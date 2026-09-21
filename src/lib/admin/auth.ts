// 운영자 인증 확인 (05-api §4).
//
// **미들웨어가 아니라 핸들러에서 확인한다.** 킬 스위치와 같은 이유다 (05-api §4 · §6) —
// 미들웨어 캐시에 인증 판정이 얹히면 그게 곧 우회 경로가 된다.
//
// **`/admin` 페이지와 `/api/admin/*`를 같은 방식으로 막는다.** API만 막고 페이지를
// 열어두면 큐 화면 껍데기가 노출된다. 페이지는 `next/headers`의 쿠키를 읽어야 해서
// 각 페이지가 직접 `verifySession`을 부르고, 그 검증 함수는 여기와 같은 것이다.

import { unauthorized } from "../errors";
import { ADMIN_COOKIE, readCookie, verifySession } from "./session";

export function isAdminRequest(request: Request): boolean {
  return verifySession(readCookie(request.headers.get("cookie"), ADMIN_COOKIE));
}

/**
 * 통과면 `null`, 아니면 401 응답. **모든 `/api/admin/*` 핸들러의 첫 줄이다.**
 *
 * 401 본문은 errors.ts의 고정 문구다 — 비밀번호가 틀렸는지 세션이 만료됐는지 말하지
 * 않는다.
 */
export function requireAdmin(request: Request): Response | null {
  return isAdminRequest(request) ? null : unauthorized();
}
