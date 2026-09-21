// 해제 쿠키를 **굽는** 쪽 (05-api §2 · 04 §4 「재열람」).
//
// 이름은 여기서 정하지 않는다. 읽는 쪽(`src/lib/letters/read.ts`)의 `UNLOCK_COOKIE`를
// 가져다 쓴다 — 이름이 갈라지면 재방문한 사람이 답을 다시 맞혀야 하고, 그건 03 흐름 2가
// "제품 실패"라고 부른 상태다. 수명·플래그 같은 굽는 조건만 여기 있다.
//
// 값은 `unlock_id` 하나다. **편지 ID를 담지 않는다** — 담으면 값을 바꿔 아무 편지나 열
// 수 있다 (04 §4 · 안전 #16). 랜덤값 + DB 대조라 위조가 불가능하고, 행 하나를 지우면
// 그 쿠키가 폐기된다.

import { UNLOCK_COOKIE } from "../letters/read";

/** 05-api §2 「30일, 가설값」. */
export const UNLOCK_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * `Set-Cookie` 한 줄.
 *
 * - **HttpOnly** — 05-api §2가 지정했다. 이 값이 곧 본문 열람 자격이라 스크립트가 읽을
 *   이유가 없다. XSS가 나도 쿠키가 그대로 새지는 않는다
 * - **SameSite=Lax** — 유일한 배달 수단이 공유 링크다(D-006). `Strict`면 카카오톡에서
 *   눌러 들어온 재방문에 쿠키가 실리지 않아 답을 다시 맞히게 된다
 * - **Secure는 프로덕션에서만** — 로컬 개발이 http라 항상 붙이면 개발에서 쿠키가 아예
 *   저장되지 않는다. `src/lib/events.ts`의 세션 쿠키와 같은 판단이다
 */
export function unlockCookie(unlockId: string): string {
  const parts = [
    `${UNLOCK_COOKIE}=${unlockId}`,
    "Path=/",
    `Max-Age=${UNLOCK_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}
