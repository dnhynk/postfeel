// 익명 세션 쿠키를 요청/응답에서 다루는 자리 (06-analytics §1 · src/lib/events.ts).
//
// `session_id`는 **익명 랜덤 쿠키다. 계정이 아니다.** 쿠키가 httpOnly라(events.ts)
// 클라이언트가 값을 읽거나 붙일 수 없다 — **서버가 쿠키에서 읽는다.** 클라이언트가
// 보낸 세션 값을 믿으면 남의 세션으로 이벤트를 심을 수 있다.
//
// `next/headers`의 cookies()를 쓰지 않는 이유: 그러면 핸들러가 Next의 요청 컨텍스트
// 없이는 못 돌아서 테스트가 Request 하나로 핸들러를 부를 수 없다. 헤더를 직접 읽고
// `Set-Cookie`를 직접 붙이면 같은 동작이면서 테스트 가능하다.

import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  newSessionId,
} from "@/lib/events";

/** 요청 쿠키에서 세션 id. 없으면 null. */
export function readSessionId(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value) return value;
  }
  return null;
}

/** events.ts의 옵션을 그대로 `Set-Cookie` 문자열로 옮긴다. 옵션은 저기가 진실이다. */
export function sessionCookieHeader(sessionId: string): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    `Path=${SESSION_COOKIE_OPTIONS.path}`,
    `Max-Age=${SESSION_COOKIE_OPTIONS.maxAge}`,
    `SameSite=${SESSION_COOKIE_OPTIONS.sameSite === "lax" ? "Lax" : SESSION_COOKIE_OPTIONS.sameSite}`,
  ];
  if (SESSION_COOKIE_OPTIONS.httpOnly) parts.push("HttpOnly");
  if (SESSION_COOKIE_OPTIONS.secure) parts.push("Secure");
  return parts.join("; ");
}

export interface Session {
  sessionId: string;
  /** 새로 발급했을 때만. 응답에 붙인다. */
  setCookie?: string;
}

/** 쿠키가 있으면 그 값을, 없으면 새로 발급한다. */
export function ensureSession(headers: Headers): Session {
  const existing = readSessionId(headers);
  if (existing) return { sessionId: existing };
  const sessionId = newSessionId();
  return { sessionId, setCookie: sessionCookieHeader(sessionId) };
}

/** 발급된 세션 쿠키를 응답에 붙인다. 이미 있던 세션이면 그대로 돌려준다. */
export function withSession(response: Response, session: Session): Response {
  if (session.setCookie) response.headers.append("set-cookie", session.setCookie);
  return response;
}
