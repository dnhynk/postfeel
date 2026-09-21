// 법정 접속기록 — [D-030](../../docs/00-decisions.md).
//
// ─────────────────────────────────────────────────────────────
// 이 파일에 **읽는 함수가 없는 것은 실수가 아니다**
// ─────────────────────────────────────────────────────────────
// D-030이 "애플리케이션 일반 코드에서는 쓰기만 가능하고 조회는 불가능하게" 요구한다.
// DB 권한으로 강제하는 것은 배포 시 별도 역할이 하고(migrations/0004 주석), 코드 쪽
// 방어는 **읽는 경로를 아예 만들지 않는 것**이다. 조회 함수가 하나 생기면 언젠가 어떤
// 화면이 그것을 부르고, 그 순간 이 표는 그냥 또 하나의 로그 테이블이 된다.
//
// 적법한 요청이 왔을 때의 복호는 운영자가 별도로 한다 (07 §6 · crypto.ts `seal` 주석).
//
// ── 왜 응답 뒤로 미루지 않는가 ───────────────────────────────
// 리포 규약은 응답 뒤에 도는 작업을 `scheduleAfterResponse`로 감싸는 것이다. 그건
// **유실을 감수하는** 장치이고(맨 프로미스가 서버리스에서 사라지는 것을 막을 뿐,
// 성공을 보장하지는 않는다), 보관 의무가 걸린 기록에는 맞지 않는다. 유실된 접속기록은
// "처음부터 안 남겼다"와 구분되지 않는다.
//
// 대가는 **모든 요청에 INSERT 한 번**이다. 인지하고 감수한다.
//
// ── 실패하면 어떻게 하는가 ───────────────────────────────────
// **요청을 막지 않는다.** DB가 잠깐 흔들릴 때 서비스 전체가 죽는 쪽이 더 나쁘다.
// 다만 삼키고 끝내지 않고 `console.error`로 남긴다 — 조용히 비는 구간이 생기면
// 그게 가장 나쁘다. 지속적 실패를 어떻게 감지할지는 07 §7 주간 점검에서 다룬다.

import { query } from "./db";
import { seal } from "./crypto";
import { env } from "./env";

/**
 * "아주 거친 요청 분류" (D-030).
 *
 * **`app` 안에서 작성과 열람이 구분되지 않는다.** 구분하면 `letters.created_at`과
 * `captured_at`을 맞춰 "이 IP가 이 시각에 편지를 썼다"가 나오고, 조인 키를 없앤 이유가
 * 무너진다. 여기를 세분화하고 싶어지면 D-030의 「남는 위험」을 먼저 읽는다.
 */
export type AccessChannel = "app" | "admin" | "cron";

/** 경로 → 분류. 이용자 요청은 전부 `app` 하나로 접힌다. */
export function channelOf(pathname: string): AccessChannel {
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    return "admin";
  }
  if (pathname.startsWith("/api/cron")) return "cron";
  return "app";
}

/**
 * 접속 한 건을 남긴다.
 *
 * `ACCESS_LOG_KEY`가 없으면 **아무것도 하지 않는다.** 로컬 개발과 CI가 이 키 없이
 * 돌아야 하고, 키 없이 평문 IP를 남기는 것은 D-030이 요구한 것의 반대다. 배포 환경에
 * 키가 비면 기록이 조용히 멈추므로, 그 확인은 출시 게이트 17번이 한다.
 */
export async function recordAccess(
  ip: string,
  channel: AccessChannel,
): Promise<void> {
  const key = env.ACCESS_LOG_KEY;
  if (key === undefined) return;

  const sealed = seal(key, ip);
  await query(
    `insert into audit.access_log (ip_ciphertext, ip_iv, ip_tag, channel)
     values ($1, $2, $3, $4)`,
    [sealed.ciphertext, sealed.iv, sealed.tag, channel],
  );
}
