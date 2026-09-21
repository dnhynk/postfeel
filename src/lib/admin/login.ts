// 로그인 — 비밀번호 대조와 실패 제한 (05-api §4).
//
// ── 실패 5회 / 10분을 어디에 세는가 ─────────────────────────
// 05-api §5의 레이트리밋 표에 운영자 로그인이 없고, 셀 테이블도 없다. 그렇다고 카운터
// 테이블을 만들지 않는다 — 05-api §5의 "없는 걸 만들기 전에 있는 걸 센다"가 그대로
// 적용된다. **실패한 로그인은 `admin_actions`에 남긴다.** 운영 감사 기록으로도 그 자리가
// 맞고, 세는 것은 그 행을 세면 된다.
//
// ── fp 단위로 센다 ──────────────────────────────────────────
// 전역으로 세면 공격자가 10분마다 5번 틀려서 **운영자를 영구히 잠글 수 있다.** 새벽에
// 큐를 열어야 하는 사람이 못 들어가는 것은 실패 5회를 못 막는 것보다 나쁘다 (07 §1).
// 그래서 `target_id`에 fp를 적고 fp별로 센다 — 조치의 대상이 편지가 아니라 그 fp다.
// `letters.id`와 섞이지 않게 `fp:` 접두사를 붙인다.

import { query } from "../db";
import { constantTimeEqual } from "../crypto";
import { requireEnv } from "../env";

/** 05-api §4 「실패는 5 / 10분으로 제한」. */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;

const FAILURE_ACTION = "admin_login_failed";
const SUCCESS_ACTION = "admin_login";

function fpTarget(fpHash: Buffer): string {
  return `fp:${fpHash.toString("hex")}`;
}

/**
 * 비밀번호 대조. **상수 시간**이다 (05-api §4).
 *
 * `ADMIN_PASSWORD`가 없으면 던진다. 값이 없는 채로 로그인 경로가 살아 있으면 인증이
 * 통째로 무의미해질 수 있다 — env.ts가 `requireEnv`를 둔 이유가 이 판단을 쓰는 코드에
 * 맡기기 위해서다.
 */
export function passwordMatches(input: string): boolean {
  return constantTimeEqual(
    Buffer.from(input, "utf8"),
    Buffer.from(requireEnv("ADMIN_PASSWORD"), "utf8"),
  );
}

export async function countRecentLoginFailures(fpHash: Buffer): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `select count(*) as count from admin_actions
      where action = $1 and target_id = $2
        and created_at > now() - make_interval(secs => $3)`,
    [FAILURE_ACTION, fpTarget(fpHash), LOGIN_FAILURE_WINDOW_MS / 1000],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 429의 `retryAfter`(초) — 가장 오래된 실패가 10분 창에서 빠져나가는 시점까지. */
export async function loginRetryAfterSeconds(fpHash: Buffer): Promise<number> {
  const windowSeconds = LOGIN_FAILURE_WINDOW_MS / 1000;
  const { rows } = await query<{ seconds: string | null }>(
    `select extract(epoch from
              min(created_at) + make_interval(secs => $3) - now()) as seconds
       from admin_actions
      where action = $1 and target_id = $2
        and created_at > now() - make_interval(secs => $3)`,
    [FAILURE_ACTION, fpTarget(fpHash), windowSeconds],
  );
  const seconds = Number(rows[0]?.seconds ?? windowSeconds);
  return Math.max(1, Math.ceil(seconds));
}

export async function recordLoginFailure(fpHash: Buffer): Promise<void> {
  await query(
    "insert into admin_actions (action, target_id) values ($1, $2)",
    [FAILURE_ACTION, fpTarget(fpHash)],
  );
}

/** 성공도 남긴다 — 05-api §4의 "모든 운영자 호출은 `admin_actions`에 기록"이다. */
export async function recordLoginSuccess(fpHash: Buffer): Promise<void> {
  await query(
    "insert into admin_actions (action, target_id) values ($1, $2)",
    [SUCCESS_ACTION, fpTarget(fpHash)],
  );
}
