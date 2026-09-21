// `POST /api/manage/:token/contact` — 이메일 등록 (05-api §3 · 03 §1-6 · D-005 · D-013).
//
// ── 편지 ID가 아니라 관리 토큰으로 받는다 ───────────────────
// ID를 키로 두면 편지 링크를 본 사람 누구나 이메일을 붙일 수 있다. 등록이 편지당 1회라
// 진짜 작성자가 409로 밀려나고, 무엇보다 **그 제3자에게 "누군가 열었습니다" 메일이
// 발송된다** — 가입하지 않은 사람에게 아웃바운드가 나가는 것이라 D-006이 뚫리는 경로다.
// 관리 토큰은 작성 응답에서만 나오므로 소지자가 곧 작성자다 (05-api §3). 안전 테스트 #17.
//
// ── 순서가 방어다 ───────────────────────────────────────────
// 1. 연령 확인 — **저장 경로에 들어가기 전에** 본다 (D-013). 안전 테스트 #14
// 2. 주소 형식
// 3. 레이트리밋 (05-api §5)
// 4. 억제 목록 — 해지한 주소는 다시 등록되지 않는다 (09 §1). 안전 테스트 #18
// 5. 삽입 (편지당 1회) → 1번 메일
//
// ── 킬 스위치를 보지 않는다 ─────────────────────────────────
// 05-api §6의 표에 이 경로가 없다. 관리 표면은 사고 대응 중에도 열려 있다.

import { z } from "zod";
import { randomToken } from "@/lib/crypto";
import { query } from "@/lib/db";
import {
  conflict,
  gone,
  invalidRequest,
  notFound,
  rateLimited,
} from "@/lib/errors";
import { record } from "@/lib/events";
import { ensureSession, withSession } from "@/lib/analytics/session";
import { fingerprint } from "@/lib/fingerprint";
import { findByManageToken } from "@/lib/letters/manage";
import { notifyManageLink } from "@/lib/notify/email";
import { scheduleAfterResponse } from "@/lib/notify/schedule";
import { isSuppressed } from "@/lib/notify/suppression";
import {
  countContactsByAuthorFp,
  exceeded,
  LIMITS,
} from "@/lib/ratelimit";

interface Context {
  params: Promise<{ token: string }>;
}

/**
 * 254자는 RFC 5321이 정한 주소 전체 길이 상한이다. 형식 검증은 zod에 맡긴다 — 우리가
 * 정규식을 새로 쓰면 정상 주소를 막는 쪽으로 틀린다.
 */
const EMAIL_MAX = 254;

const schema = z.object({
  email: z.email().max(EMAIL_MAX),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { token } = await context.params;
  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  const letter = await findByManageToken(token);
  if (!letter) return respond(notFound());
  // 05-api §2 표. 비공개 상태(`hidden_auto`·`hidden_admin`)에서는 계속 받는다 — 그래야
  // 작성자가 상태 변화를 메일로 알 수 있다. 이미 지운 편지에는 알릴 것이 없다.
  if (letter.status === "deleted_by_author") return respond(gone());

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return respond(invalidRequest("이메일 주소를 입력해 주세요."));
  }

  // D-013 — **이게 아동 개인정보를 수집하지 않기 위한 유일한 방어선이다.** 클라이언트
  // 체크박스만으로는 안 된다. 주소 검증보다 먼저 두어 미체크 요청이 저장 경로 근처에도
  // 가지 않게 한다.
  if (!isRecord(raw) || raw.ageConfirmed !== true) {
    return respond(invalidRequest("만 14세 이상임을 확인해 주세요."));
  }

  // 앞뒤 공백은 **검증 전에** 턴다. `z.email()`은 공백이 붙은 값을 형식 오류로 보는데,
  // 09 §1의 normalize가 첫 단계로 공백을 제거하므로 `  a@b.com  `은 억제 목록 대조에서
  // `a@b.com`과 같은 주소여야 한다. 여기서 안 털면 해지한 주소를 공백 하나로 되살릴
  // 수는 없지만(형식 오류로 막힌다) **막힌 이유가 달라져** 400의 뜻이 흐려진다.
  const parsed = schema.safeParse({
    email: typeof raw.email === "string" ? raw.email.trim() : raw.email,
  });
  if (!parsed.success) {
    return respond(invalidRequest("이메일 주소를 확인해 주세요."));
  }
  const email = parsed.data.email;

  // 05-api §5 — 5 / 1시간. 카운터 테이블 없이 `author_contacts` × `letters.author_fp_hash`로
  // 센다. `retryAfter`는 창 전체다 (작성 표면의 같은 처리와 맞춘다).
  const fpHash = fingerprint(request.headers);
  const rule = LIMITS.contactCreatePerHour;
  if (exceeded(await countContactsByAuthorFp(fpHash, rule.windowMs), rule)) {
    return respond(rateLimited(Math.ceil(rule.windowMs / 1000)));
  }

  // 09 §1 — 해지한 주소는 다시 등록되지 않는다. 없으면 해지가 한 번 쓰고 사라지는 장치가
  // 된다. 저장하지 않고 400이다.
  if (await isSuppressed(email)) {
    return respond(
      invalidRequest(
        "이 주소로는 알림을 보낼 수 없습니다. 이전에 알림을 끈 주소입니다.",
      ),
    );
  }

  // 편지당 1회 (05-api §3). `on conflict do nothing`이 판정이다 — 조회 후 삽입으로 나누면
  // 그 사이가 곧 중복 창이 된다.
  const unsubscribeToken = randomToken();
  const { rows } = await query<{ unsubscribe_token: string }>(
    `insert into author_contacts (letter_id, email, unsubscribe_token)
     values ($1, $2, $3)
     on conflict (letter_id) do nothing
     returning unsubscribe_token`,
    [letter.id, email, unsubscribeToken],
  );
  if (!rows[0]) {
    return respond(conflict("이미 이메일을 등록한 편지입니다."));
  }

  try {
    // 06 §3 `contact_added` — 서버가 관측하는 이벤트라 서버가 기록한다. props는 없다
    // (이메일도 편지 ID도 담지 않는다, 06 §2).
    await record("contact_added", session.sessionId);
  } catch {
    // 계측 실패로 등록을 되돌리지 않는다.
  }

  // 09 §2 #1 — 등록 직후 관리 링크. **await 하지 않는다**: 발송은 비동기이고 실패해도
  // 사용자 흐름을 막지 않는다 (09 §2 · D-005). 관리 토큰 원문은 이 요청에만 존재한다.
  //
  // **다섯 곳 중 유실 비용이 가장 큰 자리다.** 바로 그 "관리 토큰 원문은 이 요청에만
  // 존재한다" 때문이다 — DB에는 sha256만 있어(D-014) 재발송 경로가 아예 없고, 이 메일이
  // 조용히 사라지면 작성자는 자기 편지를 영영 관리·삭제하지 못한다. S-9(작성자 후회)가
  // 관리 링크를 유일한 삭제 경로로 둔 전제가 통째로 깨진다. 근거는 notify/schedule.ts.
  scheduleAfterResponse("manage_link", () =>
    notifyManageLink({
      email,
      unsubscribeToken,
      manageToken: token,
    }),
  );

  return respond(new Response(null, { status: 204 }));
}
