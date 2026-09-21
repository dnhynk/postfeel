// 운영자 세션 — **환경변수 비밀번호 1개 + 서명 쿠키 (7일)** (05-api §4).
//
// 계정 테이블도 사용자 관리도 없다. 로그인하는 사람은 한 명이고, 그 사람이 아는 것은
// `ADMIN_PASSWORD` 하나다.
//
// ── Basic Auth를 쓰지 않는 이유 ─────────────────────────────
// 05-api §4: 로그아웃이 없고, 새벽에 휴대폰으로 여는 경우가 많다. 브라우저가 자격증명을
// 물고 있는 방식은 그 두 상황에 맞지 않는다.
//
// ── 쿠키에 담기는 것 ────────────────────────────────────────
// 만료 시각 하나와 그 서명뿐이다. **세션 테이블이 없다** — 서버가 기억하는 상태를 만들지
// 않는다는 규약(D-018)에 맞고, 로그인한 사람이 한 명뿐이라 구분할 주체도 없다.
//
//   pf_admin = <exp(초)>.<HMAC-SHA256(admin_session_key, "admin.v1.<exp>") base64url>
//
// 서명 키는 `ADMIN_SESSION_KEY`다. 비밀번호(`ADMIN_PASSWORD`)는 **키가 아니다** —
// D-017의 시크릿 표가 넷을 세면서 비밀번호를 그 밖에 뒀다. 키를 바꾸면 운영자가 다시
// 로그인하면 된다.
//
// 남는 한계: 발급된 쿠키는 만료 전에는 취소할 수 없다. 취소가 필요하면
// `ADMIN_SESSION_KEY`를 바꾼다 — 그게 D-017이 이 키의 교체 비용으로 적어둔 값이다.

import { constantTimeEqual, hmacSha256 } from "../crypto";
import { requireEnv } from "../env";

export const ADMIN_COOKIE = "pf_admin";

/** 05-api §4 「서명 쿠키 세션 (7일)」. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 서명 대상에 버전 접두사를 둔다. 나중에 담을 값이 늘어나면 `admin.v2.`가 되고, 그러면
 * v1 쿠키가 자동으로 무효가 된다 — 형식이 바뀌었는데 옛 쿠키가 통과하는 일이 없다.
 */
function signature(exp: number): string {
  return hmacSha256(
    requireEnv("ADMIN_SESSION_KEY"),
    `admin.v1.${exp}`,
  ).toString("base64url");
}

/** 로그인 성공 시의 쿠키 값. */
export function issueSession(nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  return `${exp}.${signature(exp)}`;
}

/**
 * 쿠키 값 검증. 형식·만료·서명 중 하나라도 어긋나면 `false`.
 *
 * 서명 비교는 **상수 시간**이다 (crypto.ts `constantTimeEqual`). 여기는 사용자가 준 값을
 * 우리가 계산한 값과 맞춰보는 자리라 관리 토큰(조회로 끝난다)과 다르다.
 *
 * `ADMIN_SESSION_KEY`가 없으면 **던진다.** 조용히 `false`를 돌려주면 키를 안 넣은 배포가
 * "비밀번호가 틀렸나 보다"로 보인다. 설정 실수는 시끄럽게 죽는 쪽이 맞다 (env.ts 주석).
 */
export function verifySession(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!value) return false;

  // base64url에는 '.'이 없으므로 구분자가 값에 섞이지 않는다.
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [expText, provided] = parts as [string, string];

  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || exp <= 0) return false;
  if (exp * 1000 <= nowMs) return false;

  return constantTimeEqual(
    Buffer.from(provided),
    Buffer.from(signature(exp)),
  );
}

/**
 * `Set-Cookie` 헤더 값.
 *
 * - `HttpOnly` — 스크립트가 읽을 이유가 없다
 * - `SameSite=Lax` — 운영자 조치는 전부 POST라 교차 사이트 요청에 쿠키가 붙지 않는다
 * - `Secure`는 프로덕션에서만. 로컬 개발은 http다
 */
export function sessionCookieHeader(
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${ADMIN_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/** 요청 헤더에서 쿠키 하나를 꺼낸다. Next 런타임 없이도 도는 형태로 둔다. */
export function readCookie(
  cookieHeader: string | null,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return undefined;
}
