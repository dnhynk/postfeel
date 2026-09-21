// 해지와 억제 목록 (09 §1 · D-019 · 04 §1-3).
//
// ── 이 파일이 존재하는 이유 ─────────────────────────────────
// 이메일 등록은 관리 토큰으로 인증하므로 등록하는 사람은 반드시 작성자다. 하지만
// **작성자가 자기 주소 대신 타인의 주소를 적는 것은 막을 수 없다.** 그러면 요청한 적
// 없는 사람에게 메일이 가고, 그게 D-006이 금지한 상황이다.
//
// 방어는 두 겹이다. (1) 모든 메일에 1클릭 해지 링크(templates/layout.ts), (2) 해지한
// 주소를 다시 등록하지 못하게 막는 이 파일. **행만 지우면 "이 주소는 거부했다"는 기록도
// 함께 사라져** 작성자가 같은 주소를 다시 넣으면 등록이 그대로 성공하고, 09 §1이 감수하기로
// 한 "잘못 받은 사람도 1통은 받는다"가 해지할 때마다 1통씩 반복된다.
//
// ── 원문 주소는 억제 목록에 없다 ────────────────────────────
// `sha256(normalize(email))`만 남긴다. "개인정보 삭제 = 행 삭제"(07 §5)와 양립해야 하기
// 때문이다 — 해지한 사람의 주소를 지우면서 그 주소를 원문으로 다른 테이블에 옮겨 적으면
// 지운 것이 아니다. 키 없는 sha256으로 충분한 근거는 04 §1-3에 있다: 바로 옆
// `author_contacts.email`이 평문이라 해시 쪽에만 키를 씌우는 건 장식이고, 키를 쓰면 그
// 키를 교체하는 순간 억제 목록이 조용히 비어 D-006 방어가 사라진다.
//
// ── 공급자별 정규화를 흉내 내지 않는다 ──────────────────────
// `normalize`는 **앞뒤 공백 제거 + 소문자화**뿐이다 (09 §1). `user+tag@`나 점 표기 변형이
// 다른 주소로 취급되어 못 막히는 것은 09 §1이 인지하고 감수한 위험이다. 공급자마다 다른
// 규칙을 우리가 추측해서 넣으면 틀리는 날 정상 주소가 막힌다.

import { sha256 } from "../crypto";
import { query, withTransaction } from "../db";
import { record } from "../events";
import type { EmailKind } from "./email";

/**
 * 서버가 혼자 관측한 이벤트의 `session_id` (telegram.ts의 같은 상수와 같은 이유).
 *
 * 해지 클릭에는 우리 세션 쿠키가 없다 — 메일함에서 곧장 들어오는 요청이고, 그 사람은
 * 대개 이 서비스를 쓴 적도 없다. 사용자 세션인 척하는 랜덤값을 만들면 세션 수가 부풀고
 * 그건 없는 신호를 만드는 것과 같다 (D-007).
 */
const SERVER_SESSION = "server";

/** 09 §1. 이 두 단계가 전부다 — 여기에 규칙을 더하지 않는다. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 억제 목록의 키 (04 §2 `email_suppressions.email_hash`). */
export function emailHash(email: string): Buffer {
  return sha256(normalizeEmail(email));
}

/** 등록 경로가 저장 전에 본다. 걸리면 저장하지 않고 400이다 (05-api §3 · 09 §1). */
export async function isSuppressed(email: string): Promise<boolean> {
  const { rowCount } = await query(
    "select 1 from email_suppressions where email_hash = $1",
    [emailHash(email)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * `unsubscribed`는 이번 클릭이 실제로 껐다는 뜻이고, `not_found`는 그런 토큰이 없다는
 * 뜻이다 — 이미 해지했거나 처음부터 없는 토큰이다. 화면은 둘을 구분해 보여주지만 어느
 * 쪽도 편지에 대해서는 아무것도 말하지 않는다.
 */
export type UnsubscribeResult = "unsubscribed" | "not_found";

/**
 * 해지 — **확인 화면 없이 클릭 1회**로 여기까지 온다 (09 §1).
 *
 * 토큰은 `unsubscribe_token`이고 **관리 토큰이 아니다.** 관리 토큰은 편지를 삭제할 수
 * 있어서, 그걸 해지 링크에 쓰면 잘못 받은 사람의 손에 삭제 권한을 쥐여주게 된다 (D-014).
 *
 * ── 왜 그 행 하나가 아니라 같은 주소의 행을 전부 지우는가 ──
 * 한 작성자가 편지 세 통에 같은 주소를 등록하면 행이 셋이고 해지 토큰도 셋이다. 클릭한
 * 행 하나만 지우면 나머지 두 편지에서 계속 메일이 나가 "두 번째 통이 없도록 만든다"(09 §1)가
 * 성립하지 않는다. 09 §1이 억제를 편지가 아니라 **주소** 기준으로 정한 것과 같은 이유다.
 * 여기서 지우지 않고 발송 시점에 억제 목록을 대조하는 방법도 있지만, 그러면 해지한 사람의
 * 주소가 `author_contacts`에 남는다 — 07 §5의 "개인정보 삭제 = 행 삭제"와 어긋난다.
 *
 * 삭제와 억제 기록은 한 트랜잭션이다. 갈라지면 "지웠는데 재등록되는" 상태가 남는데,
 * 그게 정확히 이 파일이 막으려는 상태다.
 */
export async function unsubscribeByToken(
  token: string,
  kind: EmailKind | null,
): Promise<UnsubscribeResult> {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query<{ email: string }>(
      "delete from author_contacts where unsubscribe_token = $1 returning email",
      [token],
    );
    const email = rows[0]?.email;
    if (email === undefined) return "not_found" as const;

    await client.query("delete from author_contacts where lower(email) = $1", [
      normalizeEmail(email),
    ]);

    // 같은 주소로 두 번 해지할 수 있다 — 다른 편지의 링크가 남아 있을 수 있고, 위
    // 삭제가 그 행을 지웠어도 메일함의 링크는 살아 있다. 그때 억제 기록은 이미 있다.
    await client.query(
      "insert into email_suppressions (email_hash) values ($1) on conflict do nothing",
      [emailHash(email)],
    );
    return "unsubscribed" as const;
  });

  if (result === "unsubscribed") await recordUnsubscribed(kind);
  return result;
}

/**
 * 09 §5 `email_unsubscribed { kind }` — **§1의 방어가 작동하는지 보는 유일한 지표다.**
 * 이 값이 높으면 작성자들이 타인 주소를 넣고 있다는 뜻이고, 그러면 등록 화면 문구를
 * 고쳐야 한다.
 *
 * 이메일 주소도 편지 ID도 담지 않는다 (06 §2). `kind`는 어느 메일의 링크로 껐는가이고,
 * 링크에 붙어 오지 않았으면 담을 값이 없으므로 props를 비운다 — 모르는 값을 추측해서
 * 채우면 지표가 거짓이 된다.
 *
 * 기록 실패가 해지를 되돌리지 않는다. 해지는 이미 끝났고, 그게 계측보다 중요하다.
 */
async function recordUnsubscribed(kind: EmailKind | null): Promise<void> {
  try {
    await record("email_unsubscribed", SERVER_SESSION, kind ? { kind } : {});
  } catch (error) {
    console.error("[email] email_unsubscribed 기록 실패", error);
  }
}
