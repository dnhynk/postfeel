// `POST /api/letters/:id/unlock` — 05-api §2 · 03 흐름 2 · 02 S-6.
//
// ── 이 파일이 지키는 규칙 ────────────────────────────────────
//
// 1. **정답 근접도를 어떤 형태로도 흘리지 않는다** (S-6 · 안전 #5). 실패 응답은
//    `{ status:'wrong', attemptsRemaining }` 하나뿐이라 글자 수도 부분 일치도 담을 자리가
//    없고, `message`도 없어 문구 차이가 생길 자리가 없다. 대조는 상수 시간이고
//    (`answer.ts`), **어느 해시에 맞았는지는 응답에도 로그에도 남기지 않는다**(D-021).
//    지연도 시도 번호에만 의존한다 — 입력에 의존하는 순간 시간이 통로가 된다.
// 2. **본문은 맞힌 뒤에만 Postgres 밖으로 나온다.** 대조에 필요한 것은 해시뿐이라 오답
//    경로에서는 본문이 프로세스에 들어오지도 않는다 (read.ts의 같은 규칙 · 05-api §7 #1).
// 3. **시도 기록과 카운트는 한 트랜잭션이다** (05-api §5). 세 층의 계산은 전부
//    `src/lib/unlock/attempts.ts`에 있다 — 화면이 보여주는 "남은 시도 N번"과 서버가
//    실제로 허용하는 횟수가 갈라지면 그게 S-6 방어가 조용히 뚫리는 형태다.

import { z } from "zod";
import type { PoolClient } from "pg";
import { matchesAnswer } from "@/lib/answer";
import { ensureSession, withSession } from "@/lib/analytics/session";
import { query } from "@/lib/db";
import { invalidRequest, jsonError, notFound } from "@/lib/errors";
import { record } from "@/lib/events";
import { fingerprint } from "@/lib/fingerprint";
import { notifyFirstUnlock } from "@/lib/notify/email";
import { scheduleAfterResponse } from "@/lib/notify/schedule";
import { publicReadEnabled } from "@/lib/settings";
import { failureDelayMs, recordUnlockAttempt } from "@/lib/unlock/attempts";
import { unlockCookie } from "@/lib/unlock/cookie";
import { ensureUnlock } from "@/lib/unlock/unlocks";

/** 05-api §6 — 킬 스위치를 매 요청 확인한다. 캐시되면 스위치가 즉시 반영되지 않는다. */
export const dynamic = "force-dynamic";

/**
 * 입력 상한. **가설값이다** — 답 길이는 문서에 없다(원문을 저장하지 않으니 컬럼도 없다).
 * 04 §2가 본문을 500자로 묶었고 답이 본문보다 길 이유가 없어 같은 값을 쓴다.
 * 상한이 필요한 이유는 검증이 아니라 방어다 — 없으면 임의 길이 입력이 HMAC으로 간다.
 */
const ANSWER_MAX = 500;

const schema = z.object({
  answer: z.string().trim().min(1).max(ANSWER_MAX),
});

interface UnlockableLetter {
  /** `locked_fields` 제약(04 §2)이 `mode='locked'`에서 not null을 보장한다. */
  answer_hmac: Buffer;
  answer_variant_hmacs: Buffer[];
  /** 06 §3 `unlock_success { relationship, attemptNo }`의 props. 대조에는 쓰지 않는다. */
  relationship: string;
}

/**
 * 대조에 필요한 것만 가져온다 — **본문은 여기 없다.**
 *
 * `status='published'`가 아니면 null이고 부르는 쪽이 404를 낸다. `mode='open'`도 404다:
 * 열 것이 없는 편지에 해제 표면이 존재하지 않는다. 두 경우 다 404라 이 응답은 편지에
 * 대해 아무것도 알려주지 않는다 (05-api §2 「상태별 표면 응답」).
 */
async function unlockableLetter(id: string): Promise<UnlockableLetter | null> {
  const { rows } = await query<UnlockableLetter>(
    `select answer_hmac, answer_variant_hmacs, relationship
       from letters
      where id = $1 and status = 'published' and classifier_state = 'ok'
        and mode = 'locked'`,
    [id],
  );
  return rows[0] ?? null;
}

/** 대조와 본문 조회 사이에 편지가 내려간 경우. 시도는 롤백되고 404가 나간다. */
class LetterGone extends Error {}

/** 맞힌 사람에게만 도는 조회. 상태를 다시 본다 — 그 사이 내려갔을 수 있다. */
async function unlockedBody(client: PoolClient, id: string): Promise<string> {
  const { rows } = await client.query<{ body: string }>(
    "select body from letters where id = $1 and status = 'published' and classifier_state = 'ok'",
    [id],
  );
  const row = rows[0];
  if (!row) throw new LetterGone();
  return row.body;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  // 익명 세션 쿠키. `unlock_attempt`·`unlock_success`(06 §3)가 서버 이벤트라 여기서
  // 세운다 — 시도 번호와 성공 여부를 클라이언트가 보낼 수 있으면 위조 가능하고,
  // 위조 가능한 숫자는 주간 리뷰에서 아무 의미가 없다 (analytics/events.ts).
  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  // 05-api §6. 성공 응답이 `body`를 그대로 내리므로 공개 읽기가 꺼져 있으면 여기도
  // 막아야 한다 — 안 막으면 `/m/:id`와 `GET /api/letters/:id`를 껐는데 이 엔드포인트
  // 직접 호출로 본문이 계속 나간다. 코드·문구는 `GET /api/letters/:id`와 맞춘다.
  if (!(await publicReadEnabled())) {
    return respond(
      jsonError(
        "public_read_disabled",
        "지금은 편지를 볼 수 없습니다. 잠시 후 다시 시도해 주세요.",
        503,
      ),
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return respond(invalidRequest("답을 입력해 주세요."));
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return respond(invalidRequest("답을 입력해 주세요."));
  const { answer } = parsed.data;

  const letter = await unlockableLetter(id);
  if (!letter) return respond(notFound());

  const fpHash = fingerprint(request.headers);

  let attempt;
  try {
    attempt = await recordUnlockAttempt(id, fpHash, async (client) => {
      // 상수 시간 비교. `answer_hmac`과 `answer_variant_hmacs`를 함께 본다 (D-021).
      // 어느 쪽에 맞았는지는 이 boolean 밖으로 나오지 않는다.
      const succeeded = matchesAnswer(
        id,
        answer,
        letter.answer_hmac,
        letter.answer_variant_hmacs,
      );
      if (!succeeded) return { succeeded, value: null };

      // 이미 해제한 `(letter, fp)`면 기존 `unlock_id`가 그대로 돌아온다 (04 §4).
      const unlockId = await ensureUnlock(client, id, fpHash);
      return { succeeded, value: { unlockId, body: await unlockedBody(client, id) } };
    });
  } catch (error) {
    if (error instanceof LetterGone) return respond(notFound());
    throw error;
  }

  if (attempt.status === "rate_limited") {
    // 05-api §2가 이 엔드포인트의 429 형태를 따로 정했다 — §6의 `{ error: {...} }`가
    // 아니라 성공·실패와 같은 `status` 판별 형태다. 클라이언트가 한 자리에서 갈린다.
    //
    // **`unlock_attempt`를 보내지 않는다.** `unlock_attempts` 행이 생기지 않았으므로
    // 시도가 아니다 — 여기서 세면 이벤트의 시도 수와 DB의 시도 수가 갈라진다.
    return respond(
      Response.json(
        { status: "rate_limited", retryAfter: attempt.retryAfter },
        { status: 429 },
      ),
    );
  }

  // `unlock_attempt { success, attemptNo }` (06 §3) — 성공·실패 양쪽이 여기를 지난다.
  // 열람 퍼널(06 §4)의 세 번째 칸이다. **편지 ID는 담지 않는다** (06 §2).
  try {
    await record("unlock_attempt", session.sessionId, {
      success: attempt.succeeded,
      attemptNo: attempt.attemptNo,
    });
  } catch {
    // 계측 실패로 열람을 막지 않는다.
  }

  if (!attempt.succeeded || attempt.value === null) {
    // 02 S-6 「실패 시 지연 증가」. 시도 번호에만 의존하는 값이다 (attempts.ts).
    await new Promise((resolve) =>
      setTimeout(resolve, failureDelayMs(attempt.attemptNo)),
    );
    return respond(
      Response.json({
        status: "wrong",
        attemptsRemaining: attempt.attemptsRemaining,
      }),
    );
  }

  // `unlock_success { relationship, attemptNo }` (06 §3). 열람 퍼널 네 번째 칸이고,
  // `attemptNo`는 "몇 번째에 맞혔나"라 D-021의 표기 변형이 실제로 작동하는지를 본다.
  // **편지 ID는 담지 않는다** (06 §2) — `relationship`만 담는다.
  try {
    await record("unlock_success", session.sessionId, {
      relationship: letter.relationship,
      attemptNo: attempt.attemptNo,
    });
  } catch {
    // 계측 실패로 열람을 막지 않는다. 본문은 이미 나간다.
  }

  // 09 §2 #2 — "누군가 열었습니다". **await 하지 않는다**: 발송은 비동기이고, 메일이 안
  // 나가도 사용자 흐름이 막히지 않는다(D-005). 편지당 1회는 여기 조건문이 아니라
  // `author_contacts.first_unlock_notified_at`을 건 UPDATE가 지킨다 (email.ts · 안전 #19).
  //
  // 맨 프로미스로 두지 않는 이유는 notify/schedule.ts에 있다 — 서버리스에서 감싸지 않은
  // 일은 응답 뒤에 조용히 사라진다. 실패 정책(로그만 남기고 포기)은 그대로다.
  scheduleAfterResponse("first_unlock", () => notifyFirstUnlock(id));

  const { unlockId, body } = attempt.value;
  const response = respond(Response.json({ status: "unlocked", body, unlockId }));
  // 재방문하면 답을 다시 맞히지 않는다 (05-api §2 · 04 §4). 30일은 가설값이다.
  response.headers.append("set-cookie", unlockCookie(unlockId));
  return response;
}
