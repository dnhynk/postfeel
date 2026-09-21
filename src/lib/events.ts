// 이벤트 기록 (06-analytics). 외부 분석 도구를 붙이지 않고 `events` 테이블 하나에 넣는다.
//
// `session_id`는 **익명 랜덤 쿠키다. 계정이 아니다.** 로그인도 사용자 테이블도 없다.

import { query } from "./db";
import { randomToken } from "./crypto";

/**
 * props에 절대 담기지 않는 키 (06-analytics §2).
 *
 * **편지 ID가 핵심이다.** 담는 순간 `session_id ↔ letter_id` 연결이 생기고, 그러면
 * "누가 어떤 편지를 썼는지" 조회 가능한 테이블을 우리가 직접 만드는 것이 된다.
 * 무계정으로 설계해서 얻은 익명성을 분석 편의로 깨는 셈이다. 이메일·IP·UA도 같은
 * 이유로 여기 오지 않는다 — 개인정보는 `author_contacts`에만, 레이트리밋 식별자는
 * `fp_hash`로 분리돼 있다.
 *
 * 규칙을 주석이 아니라 코드로 강제하는 이유: 이벤트는 12개 표면이 각자 부른다.
 * 한 곳만 실수해도 연결이 생기고, 한 번 쌓인 행은 되돌릴 수 없다.
 */
const FORBIDDEN_PROP_KEYS = [
  "letterId",
  "letter_id",
  "email",
  "ip",
  "userAgent",
] as const;

export type EventProps = Record<string, unknown>;

/**
 * 금지 키를 걸러낸다.
 *
 * - 개발·테스트에서는 **던진다.** 잘못된 호출은 코드가 머지되기 전에 죽어야 한다
 * - 프로덕션에서는 그 키만 빼고 기록한다. 계측 하나 때문에 사용자 요청을 실패시키지
 *   않는다 — 이벤트는 부가 기능이고, 어차피 담기면 안 되는 값이 빠지는 결과는 같다
 */
export function sanitizeProps(name: string, props: EventProps): EventProps {
  const violations = FORBIDDEN_PROP_KEYS.filter((key) => key in props);
  if (violations.length === 0) return props;

  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      `이벤트 '${name}'의 props에 담을 수 없는 키가 있다: ${violations.join(", ")}. ` +
        `06-analytics.md §2를 본다.`,
    );
  }

  const safe: EventProps = {};
  for (const [key, value] of Object.entries(props)) {
    if ((FORBIDDEN_PROP_KEYS as readonly string[]).includes(key)) continue;
    safe[key] = value;
  }
  return safe;
}

/** `events` 테이블에 한 행. 이벤트 이름과 props는 06-analytics §3이 목록이다. */
export async function record(
  name: string,
  sessionId: string,
  props: EventProps = {},
): Promise<void> {
  const safe = sanitizeProps(name, props);
  await query(
    "insert into events (name, session_id, props) values ($1, $2, $3)",
    [name, sessionId, JSON.stringify(safe)],
  );
}

// ── 세션 쿠키 ──────────────────────────────────────────────

export const SESSION_COOKIE = "pf_session";

/** 익명 랜덤. 사용자를 식별하지 않고 퍼널을 이어 붙이기만 한다. */
export function newSessionId(): string {
  return randomToken();
}

/**
 * 수명 90일은 06-analytics §2의 기본값이다 — `session_id` 보관기간을 L-001 확인 후에
 * 정하기로 하고 그때까지 두는 값이라, 확정되면 여기와 보관 정책을 함께 고친다.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 90 * 24 * 60 * 60,
  secure: process.env.NODE_ENV === "production",
} as const;
