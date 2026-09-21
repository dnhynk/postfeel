// 킬 스위치 (`app_settings`). 05-api §6 · 07-operations §3.
//
// | 스위치 | 막는 것 | 막지 않는 것 |
// |---|---|---|
// | `public_read_enabled` | GET /api/feed, GET /api/letters/:id, /m/:id, OG 이미지 | /manage/:token, 운영자 API |
// | `writing_enabled`     | POST /api/letters | 나머지 전부 |
// | `retention_healthy`   | POST /api/letters | 나머지 전부 |
//
// 앞의 둘은 **운영자가** 끄고, 셋째는 **파기 잡이** 끈다 (D-031 · migrations/0006).
// 같은 것을 막지만 키를 나눈 이유는 "내가 껐다"와 "파기가 실패해서 꺼졌다"의 대응이
// 정반대이기 때문이다 — 전자는 켜면 되고, 후자는 파기를 고치기 전에 켜면 안 된다.
//
// **매 요청 DB에서 읽는다. 프로세스 캐시를 두지 않는다.** 05-api §6이 명시했다 —
// 캐시 때문에 스위치가 즉시 반영되지 않으면 킬 스위치의 의미가 없다. 배포가 서버리스라
// (D-018) 인메모리 값은 인스턴스마다 다르게 늙기까지 한다.
//
// **미들웨어가 아니라 핸들러에서 부른다.** 같은 이유다. 그래서 이 파일은 미들웨어가
// 아니라 각 route handler가 import 한다.

import { query } from "./db";

export type SettingKey =
  | "public_read_enabled"
  | "writing_enabled"
  | "retention_healthy";

/**
 * 행이 없으면 켜진 것으로 본다.
 *
 * 두 행은 `0002_settings_seed.sql`이 넣으므로 정상 경로에서는 비어 있지 않다.
 * 없을 때 꺼진 것으로 보면 마이그레이션이 덜 돈 환경에서 서비스가 통째로 죽는데,
 * 그건 스위치가 막으려던 상황이 아니다.
 */
async function readFlag(key: SettingKey): Promise<boolean> {
  const { rows } = await query<{ value: unknown }>(
    "select value from app_settings where key = $1",
    [key],
  );
  const value = rows[0]?.value;
  return value === undefined ? true : value === true;
}

export function publicReadEnabled(): Promise<boolean> {
  return readFlag("public_read_enabled");
}

export function writingEnabled(): Promise<boolean> {
  return readFlag("writing_enabled");
}

/**
 * 파기 작업이 건강한가 (D-031). **파기 잡이 실패하면 스스로 끈다.**
 *
 * 운영자가 켜는 것이 아니라 **파기를 고친 뒤** 켜는 값이다. 그냥 켜면 파기되지 않는
 * 상태에서 데이터가 다시 쌓이기 시작한다.
 */
export function retentionHealthy(): Promise<boolean> {
  return readFlag("retention_healthy");
}

/** 파기 잡만 쓴다. 07 §3의 운영자 스위치 화면은 이 값을 켜지 못한다. */
export async function setRetentionHealthy(healthy: boolean): Promise<void> {
  await query(
    `insert into app_settings (key, value) values ('retention_healthy', $1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(healthy)],
  );
}
