// `filter_events` 기록 (04 §2). **통계만 남기는 테이블이다.**
//
// ── 본문·단서·질문·답을 절대 넣지 않는다 ────────────────────
// 04 「저장하지 않는 것」: 등급 `high` 편지의 본문은 어디에도 남지 않는다 — "게시 보류는
// '다시 쓰세요'이고, 서버에 남기면 그것도 보관이다". 차단된 편지의 원문이 여기 들어가면
// `letters`에 안 쓴 의미가 사라진다. 그래서 이 파일의 입력 타입에는 **텍스트 필드를 둘
// 자리가 아예 없다** — 부르는 쪽이 실수할 여지를 타입으로 막는다.
//
// ── `outcome` 세 값은 서버가 실제로 관측 가능한 것뿐이다 (04 §2 · §5 발견 5) ──
//   · `blocked`   = high. 편지를 저장하지 않는다
//   · `warned`    = medium. 인터스티셜을 띄웠고 결과는 아직 모른다
//   · `published` = 생성됨 (low 즉시 / warned에서 confirmation으로 강행)
//
// **언제 부를지는 여기서 정하지 않는다.** 작성 표면(POST /api/letters)이 정한다.

import { query } from "../db";
import type { Flag, LetterMode, RiskLevel } from "./types";

export type FilterOutcome = "blocked" | "warned" | "published";

/** 텍스트가 들어올 자리가 없다는 게 이 타입의 요점이다. */
export interface FilterEventInput {
  risk: RiskLevel;
  flags: Flag[];
  mode: LetterMode;
  outcome: FilterOutcome;
}

/**
 * 한 행을 넣고 `id`를 돌려준다.
 *
 * `id`가 필요한 이유: 1차 판정이 남긴 행 번호가 `confirmation` 토큰의 `filterEventId`로
 * 들어가고(05-api §1), 재제출이 오면 그 행을 `published`로 올려 **강행률을 서버 측
 * 진실로** 남긴다.
 */
export async function recordFilterEvent(
  input: FilterEventInput,
): Promise<number> {
  const result = await query<{ id: string }>(
    `insert into filter_events (risk_level, flags, mode, outcome)
     values ($1, $2, $3, $4)
     returning id`,
    [input.risk, JSON.stringify(input.flags), input.mode, input.outcome],
  );
  // bigserial은 pg가 문자열로 준다. `confirmation`의 `filterEventId`가 number라 맞춘다.
  return Number(result.rows[0].id);
}

/**
 * 인터스티셜을 보고 강행한 재제출 — `warned` → `published` (05-api §1).
 *
 * **`warned`인 행만 올린다.** `blocked` 행이 뒤집히면 "차단된 편지가 게시됐다"는 통계가
 * 만들어지는데, 그건 관측되지 않은 사실이다. 위조된 `filterEventId`로도 상태를 바꿀 수
 * 없어야 한다 (안전 테스트 3의 같은 이유).
 *
 * 갱신된 행이 없으면 `false`. 부르는 쪽이 실패로 볼지는 그쪽이 정한다 — 계측 한 줄
 * 때문에 편지 생성을 실패시키지 않는다 (events.ts와 같은 판단).
 */
export async function markFilterEventPublished(id: number): Promise<boolean> {
  const result = await query(
    `update filter_events set outcome = 'published'
     where id = $1 and outcome = 'warned'`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}
