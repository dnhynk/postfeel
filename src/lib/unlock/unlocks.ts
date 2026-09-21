// 해제 기록과 수신자 응답 (04 §4 · 05-api §2).
//
// `unlocks`는 **북극성 지표의 소스**다 (01 「북극성 지표」 · 04 §2 주석). 행 하나가
// "누군가 이 편지를 열었다"이고 `recipient_response`가 "그 사람이 자기에게 온 것 같다고
// 했는가"다. 그래서 이 파일에서 행을 늘리거나 응답을 덮어쓰는 실수는 오류로 나타나지
// 않고 **지표를 조용히 부풀린다.** 규칙 둘을 여기 한 곳에서 지킨다.
//
//   1. `(letter, fp)`당 행은 하나다 — 재해제는 기존 행을 그대로 돌려준다
//   2. `recipient_response`는 한 번만 쓴다 — 첫 응답이 가장 정직하다

import type { PoolClient } from "pg";
import { query } from "../db";
import { newId } from "../ids";

/** 04 §2 `unlocks.recipient_response`. 03 흐름 2의 버튼 세 개와 1:1이다. */
export const RECIPIENT_RESPONSES = ["yes", "no", "unknown"] as const;
export type RecipientResponse = (typeof RECIPIENT_RESPONSES)[number];

/**
 * 이 `(letter, fp)`의 해제 기록을 보장하고 `unlock_id`를 돌려준다.
 *
 * **이미 해제한 사람이 다시 맞혀도 행을 새로 만들지 않는다** (05-api §2 · 04 §4).
 * 스키마의 `unique (letter_id, fp_hash)`가 그걸 막고 있고, 재열람이 북극성 분자를 두 번
 * 올리면 안 된다. 기존 행의 `unlocked_at`·`recipient_response`도 건드리지 않는다 —
 * 첫 열람 시각과 첫 응답이 가장 정직하다.
 *
 * 시도 기록과 같은 트랜잭션에서 돌아야 해서 클라이언트를 받는다 (05-api §5).
 */
export async function ensureUnlock(
  client: PoolClient,
  letterId: string,
  fpHash: Buffer,
): Promise<string> {
  const inserted = await client.query<{ unlock_id: string }>(
    `insert into unlocks (unlock_id, letter_id, fp_hash)
     values ($1, $2, $3)
     on conflict (letter_id, fp_hash) do nothing
     returning unlock_id`,
    [newId(), letterId, fpHash],
  );
  const created = inserted.rows[0];
  if (created) return created.unlock_id;

  // 충돌 = 이미 연 사람이다. `do update`로 억지로 returning을 받아내지 않는다 —
  // 그러면 손대지 않기로 한 컬럼들이 갱신 대상이 된다.
  const { rows } = await client.query<{ unlock_id: string }>(
    "select unlock_id from unlocks where letter_id = $1 and fp_hash = $2",
    [letterId, fpHash],
  );
  const existing = rows[0];
  if (!existing) {
    // 충돌해놓고 행이 없을 수는 없다. 여기 오면 스키마가 깨진 것이라 조용히 새 ID를
    // 만들어 내려보내지 않는다 — 그 ID로는 아무것도 열리지 않는다.
    throw new Error(`해제 기록이 충돌했는데 행이 없다: letter ${letterId}`);
  }
  return existing.unlock_id;
}

/**
 * `recorded`는 이번 호출이 처음 기록한 것, `already`는 이미 응답이 있던 것,
 * `not_found`는 그런 `unlock_id`가 없는 것이다.
 *
 * 부르는 쪽은 `recorded`·`already` 둘 다 204를 낸다(05-api §2). 구분이 필요한 곳은
 * **작성자 알림**이다 — `yes` 메일은 편지당 1회라(D-023) 처음 기록됐을 때만 나간다.
 */
export type RecipientResponseResult = "recorded" | "already" | "not_found";

export async function recordRecipientResponse(
  unlockId: string,
  response: RecipientResponse,
): Promise<RecipientResponseResult> {
  // `recipient_response is null`이 1회 기록을 보장한다. 조회 후 갱신으로 나누면 그 사이가
  // 곧 덮어쓰기 창이 된다.
  const updated = await query(
    `update unlocks
        set recipient_response = $2, responded_at = now()
      where unlock_id = $1 and recipient_response is null`,
    [unlockId, response],
  );
  if ((updated.rowCount ?? 0) > 0) return "recorded";

  const { rowCount } = await query(
    "select 1 from unlocks where unlock_id = $1",
    [unlockId],
  );
  return (rowCount ?? 0) > 0 ? "already" : "not_found";
}
