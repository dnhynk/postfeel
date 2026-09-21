// 킬 스위치 쓰기 (05-api §4 `POST /api/admin/settings` · 07 §3).
//
// 읽기는 `src/lib/settings.ts`다 — 매 요청 DB에서 읽고 캐시를 두지 않는다. 여기는 그
// 값을 바꾸는 쪽이고, 두 스위치의 의미는 07 §3에 있다:
//
//   writing_enabled = false      스팸 폭주 · 필터 오작동 · **자리를 비울 때**
//   public_read_enabled = false  문제 콘텐츠가 여러 건이라 개별 처리로 못 따라갈 때
//
// **자리를 비울 때는 읽기가 아니라 작성을 끈다.** `public_read_enabled = false`는 피드뿐
// 아니라 이미 공유된 링크까지 전부 죽인다. 화면도 이 한 줄을 그대로 보여준다.

import { withTransaction } from "../db";
import type { SettingKey } from "../settings";

export interface SettingsPatch {
  publicReadEnabled?: boolean;
  writingEnabled?: boolean;
}

const KEYS: Array<[keyof SettingsPatch, SettingKey]> = [
  ["publicReadEnabled", "public_read_enabled"],
  ["writingEnabled", "writing_enabled"],
];

/**
 * 준 값만 바꾼다. 두 스위치는 독립이고, 한 번에 하나만 누르는 게 정상 경로다.
 *
 * `insert ... on conflict`가 아니라 `update`다 — 두 행은 `0002_settings_seed.sql`이 이미
 * 넣었고, 그 마이그레이션이 "POST /api/admin/settings가 update로 동작하고"를 근거로
 * 적었다. 여기서 행을 만들기 시작하면 오타 난 키가 조용히 새 행이 된다.
 *
 * 05-api §4: **모든 운영자 호출은 `admin_actions`에 기록.** 상태 변경과 기록이 갈라지지
 * 않게 한 트랜잭션이다.
 */
export async function updateSettings(
  patch: SettingsPatch,
  note: string | null,
): Promise<void> {
  await withTransaction(async (client) => {
    for (const [field, key] of KEYS) {
      const value = patch[field];
      if (value === undefined) continue;

      await client.query(
        "update app_settings set value = $2::jsonb where key = $1",
        [key, JSON.stringify(value)],
      );
      await client.query(
        "insert into admin_actions (action, target_id, note) values ($1, $2, $3)",
        [value ? "setting_enabled" : "setting_disabled", key, note],
      );
    }
  });
}
