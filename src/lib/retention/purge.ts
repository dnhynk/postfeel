// 파기 작업 — [D-031](../../../docs/00-decisions.md).
//
// M0 답이 "삭제하지 않는다고 고지하는 것으로는 충분하지 않다"고 정했다. 보유기간 표를
// 실제로 집행하는 코드가 여기다.
//
// ── 대상과 기간 ─────────────────────────────────────────────
// | 대상                          | 기간            | 어떻게        |
// |---|---|---|
// | 격리된 편지 본문 (D-028)      | 30일            | 행 삭제       |
// | 법정 접속기록 (D-030)         | 3개월           | 행 삭제       |
// | 원시 이벤트                   | 90일            | 행 삭제       |
// | 열람 시도 기록                | 90일            | 행 삭제       |
// | `fp_hash` (편지·열람·신고·반응)| 90일            | **값 익명화** |
// | 삭제 요청의 연락처·본문 조각  | 사건 종료 후 30일| 값 비우기     |
// | 이의 제기 자유 텍스트         | 사건 종료 후 30일| 값 비우기     |
//
// **활성 편지는 대상이 아니다** (D-024는 그대로다).
//
// **재해복구 백업 30일과 통신사실확인자료 제공 대장 7년은 여기 없다.** 전자는 관리형 DB
// 설정이라 리포 밖이고, 후자는 아직 그런 표가 없다 — 실제 제공이 발생하면 그때 만든다.
//
// ── fp_hash는 왜 행을 지우지 않는가 ─────────────────────────
// `fp_hash`가 든 표 넷은 성격이 다르다. 열람 시도는 레이트리밋 이력뿐이라 행째 지워도
// 되지만, `unlocks`·`reactions`·`reports`는 **행 자체가 제품 데이터**다 — 지우면 북극성
// 지표와 반응 수와 신고 이력이 함께 사라진다. `letters.author_fp_hash`는 `not null`이다.
//
// 그래서 값만 지운다. 되돌릴 수 없는 난수로 덮으면 그 행이 어느 접속 환경에서 왔는지
// 알 수 없게 되고, 그게 "삭제"가 요구하는 결과다.
//
// **이미 익명화된 행은 길이로 가른다.** 진짜 `fp_hash`는 HMAC-SHA256이라 32바이트이고
// (05-api §5), 덮어쓴 값은 UUID 16바이트다. 컬럼을 새로 두지 않고 `length(...) = 32`로
// 대상을 좁힌다 — 표식 컬럼을 넷에 더하는 것보다 작고, 실수로 32바이트를 쓰는 경로가
// 없다.
//
// ── 이의 제기가 열려 있으면 파기하지 않는다 ─────────────────
// 사용자 판단(2026-08-16): 30일이 지나도 **이의 제기가 pending이면 멈추고 큐에 띄운다.**
// 운영자가 못 본 대가를 작성자가 지지 않게 하되, 넘긴 사실 자체는 드러나야 한다.
// `overdueQuarantine()`가 그 목록이고 큐가 그린다.
//
// ── 실패하면 작성을 멈춘다 ──────────────────────────────────
// 파기되지 않는 상태에서 데이터가 계속 쌓이면 위반 규모가 커진다 (D-031).
// 실패 시 `retention_healthy`를 끈다. **다시 켜는 것은 사람이** 파기를 고친 뒤에 한다.

import { query } from "../db";
import { setRetentionHealthy } from "../settings";

/** 격리 시한. D-028의 "최대 30일". */
const QUARANTINE_DAYS = 30;
/** 법정 접속기록. 통신비밀보호법 시행령의 3개월 이상. */
const ACCESS_LOG_DAYS = 92;
/** `fp_hash`와 원시 이벤트. */
const IDENTIFIER_DAYS = 90;
/** 사건이 끝난 뒤 남기는 기간. */
const CASE_CLOSED_DAYS = 30;

/**
 * 익명화한 `fp_hash`. UUID 16바이트라 진짜 값(32바이트)과 길이로 구분된다.
 *
 * `gen_random_uuid()`는 Postgres 13+ 내장이라 확장이 필요 없다 — 이 프로젝트는
 * pgcrypto를 켜지 않는다.
 */
const ANONYMIZED_FP = `decode(replace(gen_random_uuid()::text, '-', ''), 'hex')`;

export interface PurgeOutcome {
  /** 30일이 지나 파기한 격리 본문. */
  quarantine: number;
  /** 30일이 지났지만 이의 제기가 열려 있어 **파기하지 않은** 건. */
  quarantineHeld: number;
  accessLog: number;
  events: number;
  unlockAttempts: number;
  /** 익명화한 `fp_hash` 행 수 (네 표의 합). */
  fingerprints: number;
  deletionRequests: number;
  appeals: number;
}

async function deleteRows(sql: string, params: unknown[] = []): Promise<number> {
  const { rowCount } = await query(sql, params);
  return rowCount ?? 0;
}

/**
 * 30일이 지났는데 **이의 제기가 열려 있어** 파기를 멈춘 격리 건.
 *
 * 큐가 이 목록을 드러낸다. 시한을 넘긴 항목이 조용히 남아 있는 것이 가장 나쁘다 —
 * 넘긴 사실 자체가 위반으로 읽힐 수 있다.
 */
export async function overdueQuarantine(): Promise<
  { letterId: string; quarantinedAt: string }[]
> {
  const { rows } = await query<{ letter_id: string; quarantined_at: Date }>(
    `select q.letter_id, q.quarantined_at
       from quarantine.letter_content q
      where q.legal_hold = false
        and q.quarantined_at < now() - make_interval(days => $1)
        and exists (select 1 from appeals a
                     where a.letter_id = q.letter_id and a.status = 'pending')
      order by q.quarantined_at asc`,
    [QUARANTINE_DAYS],
  );
  return rows.map((row) => ({
    letterId: row.letter_id,
    quarantinedAt: row.quarantined_at.toISOString(),
  }));
}

/**
 * 한 회차. 실패하면 던지기 전에 `retention_healthy`를 끈다.
 *
 * 대상마다 독립적으로 돈다 — 하나가 실패해도 앞서 지운 것은 지워진 채로 남는다.
 * 멱등하므로 다음 회차가 남은 것을 이어서 처리한다.
 */
export async function runPurgeJob(): Promise<PurgeOutcome> {
  try {
    // ── 격리 본문 (D-028 종결 ①) ─────────────────────────
    // `legal_hold`는 대상이 아니고, 이의 제기가 열린 건도 아니다.
    const quarantine = await deleteRows(
      `delete from quarantine.letter_content q
        where q.legal_hold = false
          and q.quarantined_at < now() - make_interval(days => $1)
          and not exists (select 1 from appeals a
                           where a.letter_id = q.letter_id and a.status = 'pending')`,
      [QUARANTINE_DAYS],
    );
    const held = await overdueQuarantine();

    // ── 법정 접속기록 (D-030) ────────────────────────────
    const accessLog = await deleteRows(
      `delete from audit.access_log
        where captured_at < now() - make_interval(days => $1)`,
      [ACCESS_LOG_DAYS],
    );

    // ── 원시 이벤트 · 열람 시도 ──────────────────────────
    const events = await deleteRows(
      `delete from events where created_at < now() - make_interval(days => $1)`,
      [IDENTIFIER_DAYS],
    );
    const unlockAttempts = await deleteRows(
      `delete from unlock_attempts
        where attempted_at < now() - make_interval(days => $1)`,
      [IDENTIFIER_DAYS],
    );

    // ── fp_hash 익명화 ──────────────────────────────────
    let fingerprints = 0;
    for (const [table, column, timeColumn] of [
      ["letters", "author_fp_hash", "created_at"],
      ["unlocks", "fp_hash", "unlocked_at"],
      ["reports", "reporter_fp_hash", "created_at"],
      ["reactions", "fp_hash", "created_at"],
    ] as const) {
      fingerprints += await deleteRows(
        `update ${table}
            set ${column} = ${ANONYMIZED_FP}
          where ${timeColumn} < now() - make_interval(days => $1)
            and length(${column}) = 32`,
        [IDENTIFIER_DAYS],
      );
    }

    // ── 사건이 끝난 요청·이의 제기 ──────────────────────
    // 행은 남긴다. 처리 이력까지 사라지면 "언제 무엇을 처리했는가"를 알 수 없다.
    // 비우는 것은 사람에 관한 값뿐이다.
    const deletionRequests = await deleteRows(
      `update deletion_requests
          set contact = null, body_excerpt = ''
        where resolved_at is not null
          and resolved_at < now() - make_interval(days => $1)
          and (contact is not null or body_excerpt <> '')`,
      [CASE_CLOSED_DAYS],
    );
    const appeals = await deleteRows(
      `update appeals set message = null
        where resolved_at is not null
          and resolved_at < now() - make_interval(days => $1)
          and message is not null`,
      [CASE_CLOSED_DAYS],
    );

    await setRetentionHealthy(true);
    return {
      quarantine,
      quarantineHeld: held.length,
      accessLog,
      events,
      unlockAttempts,
      fingerprints,
      deletionRequests,
      appeals,
    };
  } catch (error) {
    // **작성을 멈춘다.** 파기되지 않는 상태에서 계속 받으면 위반 규모가 커진다.
    // 이 UPDATE마저 실패하면 그건 DB가 통째로 죽은 것이라 작성도 어차피 실패한다.
    await setRetentionHealthy(false).catch(() => undefined);
    throw error;
  }
}
