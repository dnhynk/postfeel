// `POST /api/unlocks/:unlockId/response` — 05-api §2 · 03 흐름 2 「열람 성공 후」.
//
// **북극성 지표의 유일한 수집 지점이다** (01 「북극성 지표」 · 04 §5 발견 5). 그래서
// 계측 이벤트(`events`)가 아니라 `unlocks` 행에 직접 쓴다 — 이벤트는 빠져도 지표가
// 흐려질 뿐이지만, 이 값이 빠지면 지표 자체가 없다.
//
// **인증이 없다.** `unlockId`는 해제 응답과 HttpOnly 쿠키에만 들어가므로 해제한 본인만
// 안다(05-api §2). 추측 불가능한 22자 랜덤이라(04 §1-1) 남의 응답을 대신 넣으려면 그
// 값을 맞혀야 한다 — 관리 토큰(D-014)과 같은 논리다.
//
// 05-api §6의 킬 스위치 표에 이 엔드포인트는 없다. 본문을 내리지 않으므로 공개 읽기
// 스위치의 대상이 아니고, §5의 레이트리밋 표에도 없어 여기서 만들어내지 않는다.

import { z } from "zod";
import { ensureSession, withSession } from "@/lib/analytics/session";
import { query } from "@/lib/db";
import { invalidRequest, notFound } from "@/lib/errors";
import { record } from "@/lib/events";
import { notifyRecipientYes } from "@/lib/notify/email";
import { scheduleAfterResponse } from "@/lib/notify/schedule";
import {
  RECIPIENT_RESPONSES,
  recordRecipientResponse,
} from "@/lib/unlock/unlocks";

export const dynamic = "force-dynamic";

const schema = z.object({ response: z.enum(RECIPIENT_RESPONSES) });

/**
 * `recipient_response { response, relationship }`(06 §3)의 `relationship`만 가져온다.
 *
 * 이벤트에 담을 값 하나 때문에 도는 조회다. 제출 경로가 아니고 호출 빈도도 낮아 조인
 * 한 번은 감당된다. **편지 ID는 담지 않는다** (06 §2) — 여기서도 밖으로 내보내지 않는다.
 */
async function relationshipOf(unlockId: string): Promise<string | null> {
  const { rows } = await query<{ relationship: string }>(
    `select l.relationship
       from unlocks u
       join letters l on l.id = u.letter_id
      where u.unlock_id = $1`,
    [unlockId],
  );
  return rows[0]?.relationship ?? null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ unlockId: string }> },
): Promise<Response> {
  const { unlockId } = await context.params;

  // 익명 세션 쿠키. `recipient_response`(06 §3)가 서버 이벤트라 여기서 세운다 — 이 사건을
  // 서버가 관측하는 자리는 여기뿐이다.
  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return respond(invalidRequest("응답을 선택해 주세요."));
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return respond(invalidRequest("응답을 선택해 주세요."));

  const result = await recordRecipientResponse(unlockId, parsed.data.response);

  // 위조하거나 이미 지워진 `unlock_id`. 편지 404와 같은 코드를 쓴다 — 이 값이 존재하는지
  // 여부를 따로 알려줄 이유가 없다.
  if (result === "not_found") return respond(notFound());

  // `recipient_response { response, relationship }` (06 §3).
  //
  // **`recorded`일 때만 남긴다.** `already`는 재해제 후 다시 누른 것이고 DB는 덮어쓰지
  // 않는데(04 §4 — 첫 응답이 가장 정직하다), 이벤트만 쌓이면 주간 지표 #4
  // (`post_unlock_continue / recipient_response`)의 **분모가 부풀어 루프 유지율이 실제보다
  // 나쁘게 보인다.** DB의 진실과 이벤트의 진실을 같은 조건에 묶는다.
  if (result === "recorded") {
    try {
      const relationship = await relationshipOf(unlockId);
      await record("recipient_response", session.sessionId, {
        response: parsed.data.response,
        // 편지가 그 사이 하드 삭제된 경우에만 null이다. 그때는 키를 빼고 남긴다 —
        // 응답이 있었다는 사실 자체가 지표의 분모다.
        ...(relationship === null ? {} : { relationship }),
      });
    } catch {
      // 북극성 지표의 진짜 소스는 `unlocks.recipient_response` 행이고 그건 이미 들어갔다.
      // 이벤트는 부가 기록이라 실패해도 응답을 되돌리지 않는다.
    }
  }

  // 09 §2 #4 · D-023 — `yes`를 **처음 기록했을 때만.** `already`는 이미 응답이 있던 것이라
  // 이 편지의 알림은 이미 나갔거나 나갈 이유가 없었다. **await 하지 않는다**: 발송은
  // 비동기다(09 §2). 편지당 1회와 "yes일 때만"은 여기 조건문이 아니라
  // `author_contacts.recipient_yes_notified_at`과 `recipient_response='yes'`를 함께 건
  // UPDATE가 지킨다 (email.ts · 안전 #24).
  //
  // 맨 프로미스로 두지 않는 이유는 notify/schedule.ts에 있다 — 서버리스에서 감싸지 않은
  // 일은 응답 뒤에 조용히 사라진다. 실패 정책(로그만 남기고 포기)은 그대로다.
  if (result === "recorded" && parsed.data.response === "yes") {
    scheduleAfterResponse("recipient_yes", () => notifyRecipientYes(unlockId));
  }

  // `already`도 204다. 1회만 기록하고 재해제 시 덮어쓰지 않는다 (04 §4) — 첫 응답이 가장
  // 정직하다. 두 번째 응답을 오류로 돌려주면 화면이 "실패"를 보여줘야 하는데, 그 사람이
  // 잘못한 것은 없다.
  return respond(new Response(null, { status: 204 }));
}
