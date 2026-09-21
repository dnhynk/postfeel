// 재분류 잡 (M2 필수) — 05-api §1 「재분류 잡」.
//
// `classifier_state = 'unavailable'` 편지를 10분마다 다시 판정한다. **이 잡이 없으면
// 장애 1시간이 그 시간대 편지 전부를 영구히 피드에서 제외한다.**
//
//   성공 · low       → classifier_state='ok', risk_level='low'  → 피드로 승격
//   성공 · medium    → classifier_state='ok', risk_level='medium'
//   성공 · high/거부 → status='hidden_auto' + admin_actions 기록 (아래)
//   실패             → classifier_retry_count += 1
//   실패 3회         → classifier_state='failed'로 고정, medium 유지 → 주간 샘플 검수(07 §7)
//
// ## high·거부 경로는 문서에 없던 자리다 (코디네이터 판정, 2026-08-14)
//
// 05-api §1은 low와 3회 실패만 다뤘다. 재분류가 high를 내면 "이 편지는 애초에 게시되면
// 안 됐다"는 판정인데, `medium`에 두면 피드에서만 빠지고 **공유 링크로는 계속 읽힌다** —
// B 모드는 링크 유통이 정상 경로다. 주간 샘플 검수에 맡기는 것도 안 된다: 그건 medium
// 20건 샘플이고 주 1회라, S-5(02 §1이 "신고 오면 내린다가 성립하지 않는 유일한
// 카테고리"라고 못박은 것)가 최악의 경우 일주일 떠 있게 된다.
//
// 그래서 02 §4의 계산을 그대로 적용한다 — **비공개를 기본값으로 만든다. 되돌릴 수 있는
// 조치라 오작동 비용이 낮다.**
//
//   · `risk_level`은 medium 유지. "high는 저장되지 않는다"는 전제(04 §2 제약)는 그대로다.
//     여기서 바뀌는 것은 등급이 아니라 **status**다
//   · `classifier_state`는 `'ok'`. 판정은 실제로 끝났다
//   · `auto_hide_exempt`를 **무시한다.** exempt는 "반복 신고로 다시 내려가지 않는다"는
//     약속이지 "우리 필터가 틀렸어도 안 내린다"는 약속이 아니다 (D-025가 심각 카테고리에
//     exempt를 뚫어준 것과 같은 계산이고, 여기는 신고자의 악의가 개입할 여지조차 없다)
//   · `admin_actions`에 기록한다. 운영자가 "신고가 아닌데 왜 내려갔지"를 알 수 있는
//     유일한 경로다
//
// 상태 전이는 `letters/deletion.ts`의 `autoHide()`를 부른다. **이 파일에서 `status`를
// 직접 UPDATE하지 않는다** (README 「편지 상태는 한 파일에서만 바꾼다」 · L-007).

import { query } from "../db";
import { autoHide } from "../letters/deletion";
import { classify } from "./classifier";
import { grade } from "./grade";
import { runLayer1 } from "./layer1";
import type { LetterDraft, LetterMode, Relationship } from "./types";

/** 05-api §1 「3회 실패하면 'failed'로 고정」. */
export const MAX_RETRIES = 3;

/**
 * 한 번에 처리할 편지 수 (가설값).
 *
 * 편지 하나가 최악 약 4초다 (classifier.ts `TOTAL_BUDGET_MS`). 20통이면 최악 80초라
 * 배치가 크면 함수 실행 시간 상한에 걸린다 — 예산이 7초에서 4초로 줄어도 결론은 같다.
 * 걸려도 안전하다 — 편지마다 독립적으로 커밋하고, 이미 처리한 편지는 `classifier_state`가
 * 바뀌어 다음 회차의 대상에서 빠진다. 중간에 죽으면 남은 것이 10분 뒤에 이어진다.
 * 크론은 GitHub Actions가 부르는데(`reclassify.yml` 워크플로, 공개 저장소에는 없다) 그쪽도 실행을
 * 보장하지 않고 `workflow_dispatch`로 손으로 또 부를 수 있어, 멱등해야 하는 것은 같다.
 */
export const BATCH_SIZE = 20;

export interface ReclassifyOutcome {
  /** 이번 회차가 실제로 읽은 편지 수. */
  scanned: number;
  /** `low`로 판정돼 피드에 다시 뜨게 된 편지. */
  promoted: number;
  /** 판정이 끝났지만 `medium`에 남은 편지. */
  settled: number;
  /** high·거부라 `hidden_auto`로 내려간 편지. */
  hidden: number;
  /** 이번에도 실패해 다음 회차로 넘어간 편지. */
  retried: number;
  /** 3회를 채워 `failed`로 고정된 편지. */
  failed: number;
}

interface PendingRow {
  id: string;
  mode: LetterMode;
  relationship: Relationship;
  body: string;
  hint: string | null;
  question: string | null;
  classifier_retry_count: number;
}

function toDraft(row: PendingRow): LetterDraft {
  // `answer`는 저장되지 않는다 (04 「저장하지 않는 것」). 등급 판정 대상도 아니라
  // 처음 판정할 때와 입력이 같다.
  return {
    mode: row.mode,
    relationship: row.relationship,
    body: row.body,
    ...(row.hint === null ? {} : { hint: row.hint }),
    ...(row.question === null ? {} : { question: row.question }),
  };
}

/**
 * 대상 조회. `letters_classifier_pending` 부분 인덱스를 그대로 탄다 —
 * `where classifier_state = 'unavailable'` + `order by created_at` (0001_init.sql).
 *
 * 오래된 것부터 처리한다. 장애 구간의 앞쪽이 먼저 풀려야 재시도 횟수가 고르게 는다.
 * `deleted_by_author`는 제외한다 — 이미 지운 편지를 다시 판정하는 데 돈을 쓰지 않는다.
 *
 * **2026-08-16 · 그 제외가 주석에만 있고 SQL에 없었다.** 그때까지는 "지운 편지에 분류기
 * 호출 한 번을 낭비한다" 정도였지만, [D-027](../../../docs/00-decisions.md)이 삭제를
 * 완전 파기로 바꾸면서 **`body = null`을 분류기로 보내는 경로**가 됐다. 조건을 SQL로
 * 옮긴다 — 그래야 아래 `PendingRow.body: string`이 실제로 참이다.
 */
async function selectPending(limit: number): Promise<PendingRow[]> {
  const { rows } = await query<PendingRow>(
    `select id, mode, relationship, body, hint, question, classifier_retry_count
       from letters
      where classifier_state = 'unavailable'
        and status <> 'deleted_by_author'
      order by created_at
      limit $1`,
    [limit],
  );
  return rows;
}

/**
 * 판정 결과를 반영한다.
 *
 * `where classifier_state = 'unavailable'` 조건이 곧 잠금이다. 회차가 겹쳐 돌아도
 * (워크플로의 `concurrency` 그룹이 막지만, 엔드포인트는 `CRON_SECRET`만 있으면 누구든
 * 직접 부를 수 있다) 두 번째 실행의 UPDATE는 0행을 건드린다.
 */
async function applySettled(
  id: string,
  riskLevel: "low" | "medium",
  flags: unknown,
): Promise<void> {
  await query(
    `update letters
        set classifier_state = 'ok',
            risk_level = $2,
            risk_flags = $3::jsonb
      where id = $1 and classifier_state = 'unavailable'`,
    [id, riskLevel, JSON.stringify(flags)],
  );
}

async function applyRetry(id: string, nextCount: number): Promise<boolean> {
  const settled = nextCount >= MAX_RETRIES;
  const { rowCount } = await query(
    `update letters
        set classifier_state = $2,
            classifier_retry_count = $3
      where id = $1 and classifier_state = 'unavailable'`,
    [id, settled ? "failed" : "unavailable", nextCount],
  );
  return settled && (rowCount ?? 0) > 0;
}

/**
 * high·거부 → 비공개.
 *
 * `autoHide()`가 `status = 'published'`인 행만 바꾼다. 이미 신고로 내려갔거나 작성자가
 * 지운 편지는 그대로 두고, 판정 상태만 `ok`로 닫는다 — 다음 회차가 같은 편지를 다시
 * 집어들지 않게.
 */
async function applyHidden(
  id: string,
  flags: unknown,
  refused: boolean,
): Promise<boolean> {
  const hidden = await autoHide(id);
  await applySettled(id, "medium", flags);
  if (hidden) {
    await query(
      `insert into admin_actions (action, target_id, note)
       values ('reclassify_hide', $1, $2)`,
      [
        id,
        // 운영자가 큐에서 읽을 한 줄. 본문은 담지 않는다 (filter_events와 같은 기준).
        refused
          ? "재분류: 분류기 거부 → high (05-api §1)"
          : `재분류: high 판정 → ${JSON.stringify(flags)}`,
      ],
    );
  }
  return hidden;
}

/**
 * 한 회차. GitHub Actions가 10분마다 부른다 (`reclassify.yml` 워크플로, 공개 저장소에는 없다).
 *
 * 편지를 **순차로** 처리한다. 병렬로 돌리면 3초 예산이 서로를 밀어내고, 일일 상한
 * (budget.ts)을 한 회차가 통째로 태울 수 있다.
 */
export async function runReclassifyJob(
  options: { limit?: number } = {},
): Promise<ReclassifyOutcome> {
  const rows = await selectPending(options.limit ?? BATCH_SIZE);
  const outcome: ReclassifyOutcome = {
    scanned: rows.length,
    promoted: 0,
    settled: 0,
    hidden: 0,
    retried: 0,
    failed: 0,
  };

  for (const row of rows) {
    const draft = toDraft(row);
    const classifier = await classify(draft);
    const decision = grade(runLayer1(draft), classifier);

    if (decision.action === "block") {
      const hidden = await applyHidden(
        row.id,
        decision.flags,
        classifier.state === "refusal",
      );
      if (hidden) outcome.hidden += 1;
      else outcome.settled += 1;
      continue;
    }

    // 분류기가 또 죽었다 → 재시도 횟수만 올린다. 등급은 건드리지 않는다.
    if (decision.action === "create" && decision.classifierState === "unavailable") {
      const gaveUp = await applyRetry(row.id, row.classifier_retry_count + 1);
      if (gaveUp) outcome.failed += 1;
      else outcome.retried += 1;
      continue;
    }

    // 판정이 끝났다. `confirm`(medium)은 인터스티셜용 응답이지만, 이미 생성된 편지에는
    // 물어볼 사람이 없다 — 등급만 반영한다.
    const riskLevel = decision.risk === "low" ? "low" : "medium";
    await applySettled(row.id, riskLevel, decision.flags);
    if (riskLevel === "low") outcome.promoted += 1;
    else outcome.settled += 1;
  }

  return outcome;
}
