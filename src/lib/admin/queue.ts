// 운영자 큐 — 읽기와 판정 (05-api §4 · 07 §1 · §2).
//
// 큐는 네 종류를 한 화면에 모은다: **미판정 신고 · 자동 비공개 건 · 이의 제기 ·
// 삭제 요청.** 07 §1이 하루 2회 15분(건당 1분)을 상한으로 잡았으므로 화면을 열고
// 다른 문서를 찾아보게 만들면 그 예산이 깨진다 — 판정에 필요한 값을 여기서 전부 준다.
//
// ── 판정은 사람이 한다 ──────────────────────────────────────
// 07 §2: 큐는 **후보 행과 근거만** 보여주고 조치 버튼은 초안 옆에 두지 않는다. 분류기에
// 조치까지 맡기면 D-012가 사전 검토를 기각한 근거(사후에는 사람이 판단한다)가 조용히
// 무너진다.
//
// ── 초안 판정을 어디에 저장하는가 ───────────────────────────
// 07 §7의 주간 점검 5번이 "초안 판정 vs 최종 판정의 불일치율"을 본다. 저장 위치가 문서에
// 없어서 **새 테이블을 만들기 전에 `admin_actions`로 되는지부터 봤다.** 된다:
//
//   초안  action='report_draft'    target_id=<신고 ID>  note=<초안 한 줄>
//   최종  action='report_upheld'   target_id=<신고 ID>  note=<판정 이유>
//         action='report_dismissed'
//
// 같은 `target_id`로 묶이므로 불일치율은 이 테이블 안에서 세어진다. 컬럼도 그대로 맞는다
// (`note`는 원래 "판정 이유 한 줄"이 들어가는 자리다 — 07 §2 원칙 3). 초안을 **쓰는**
// 쪽은 S2의 `draftReportVerdict`가 생긴 뒤에 붙는다 (신고 라우트의 TODO). 큐는 그 자리를
// 이미 읽고 있어서, 붙는 날 화면은 고치지 않아도 된다.

import type { PoolClient } from "pg";
import { query, withTransaction } from "../db";
import { env } from "../env";
import { overdueQuarantine } from "../retention/purge";
import {
  deleteByAuthorTx,
  hideByAdminTx,
  readQuarantinedContent,
  releaseQuarantineTx,
  restoreToPublishedTx,
} from "../letters/deletion";
import type { ReportReason } from "../reports/reasons";

/** 초안 판정이 들어가는 `admin_actions.action`. 신고 라우트의 TODO가 이 값을 쓴다. */
export const REPORT_DRAFT_ACTION = "report_draft";

/**
 * 한 번에 내리는 최대 건수. **가설값이다** — 문서에 없다.
 *
 * 07 §1의 상한이 하루 2회 15분이라 한 화면에 100건이 넘게 뜨는 상황은 이미 큐가 아니라
 * [전환 트리거](02 §7)다. 잘린 건수를 화면이 말할 수 있게 `truncated`로 함께 준다 —
 * 조용히 자르면 "다 처리했다"로 읽힌다.
 */
const PAGE_LIMIT = 100;

/** 판정에 필요한 편지 값. 07 §2 판정표가 묻는 것에 답할 수 있어야 한다. */
export interface QueueLetter {
  id: string;
  mode: string;
  relationship: string;
  /**
   * 판정은 `/admin`에서 한다 (09 §3). 그래서 본문은 **여기에만** 나온다.
   *
   * **작성자가 먼저 지웠으면 `null`이다** (D-027 · tombstone). 신고가 열려 있는 편지를
   * 작성자가 지울 수 있고, 그때 원문은 파기된다. 운영자는 판정할 본문이 없지만 신고를
   * 닫을 수는 있어야 한다 — 07 §1의 "큐를 비운다"가 안 지켜지면 루틴이 무너진다.
   */
  body: string | null;
  hint: string | null;
  question: string | null;
  /**
   * 격리된 시각 ([D-028](../../../docs/00-decisions.md)). `null`이면 격리되지 않았다.
   *
   * 값이 있으면 위 `body`·`hint`·`question`은 **격리 영역에서 복호해 채운 것**이고
   * `letters`에는 없다. 판정에 본문이 필요해서 채우지만, 30일 시한이 걸린 상태라는
   * 사실을 화면이 함께 보여야 한다.
   */
  quarantinedAt: string | null;
  riskLevel: string;
  status: string;
  autoHideExempt: boolean;
  createdAt: string;
  /** 07 §2 사칭 행: "신고 2건 이상이면 삭제. 1건은 보류" — 그 건수다. */
  reportCount: number;
}

export interface QueueReport {
  id: number;
  reason: ReportReason;
  createdAt: string;
  /**
   * 텔레그램 알림에 실려 나간 무작위 사건 번호 (D-034 6 · migrations/0007).
   *
   * **알림에는 편지 ID도 사유도 없다.** 새벽에 알림을 받은 운영자가 이 값으로 여기서
   * 신고를 찾는다 — 화면에 없으면 알림이 가리키는 곳이 없어진다.
   */
  incidentId: string;
  /** 07 §2의 분류기 초안. 아직 없으면 `null`이다 (S2가 붙인다). */
  draft: string | null;
  letter: QueueLetter;
}

export interface QueueAppeal {
  id: number;
  message: string | null;
  createdAt: string;
  letter: QueueLetter;
}

export interface QueueDeletionRequest {
  id: number;
  bodyExcerpt: string;
  contact: string | null;
  createdAt: string;
}

/**
 * 격리 30일을 넘겼는데 **이의 제기가 열려 있어 파기를 멈춘** 건 ([D-031](../../../docs/00-decisions.md)).
 *
 * 파기 잡이 이 건을 건너뛴다(사용자 판단 2026-08-16 — 운영자가 못 본 대가를 작성자가
 * 지지 않게 한다). 대신 여기 떠서 **넘긴 사실이 드러난다.** 조용히 남아 있으면 그
 * 자체가 위반으로 읽힌다.
 */
export interface QueueOverdue {
  letterId: string;
  quarantinedAt: string;
}

export interface QueueView {
  reports: QueueReport[];
  autoHidden: QueueLetter[];
  appeals: QueueAppeal[];
  deletionRequests: QueueDeletionRequest[];
  /** 시한을 넘긴 격리. 비어 있는 것이 정상이다. */
  overdue: QueueOverdue[];
  /** 각 목록이 `PAGE_LIMIT`에서 잘렸는가. 자른 사실을 숨기지 않는다. */
  truncated: boolean;
}

interface LetterColumns {
  letter_id: string;
  mode: string;
  relationship: string;
  body: string | null;
  hint: string | null;
  question: string | null;
  quarantined_at: Date | null;
  risk_level: string;
  letter_status: string;
  auto_hide_exempt: boolean;
  letter_created_at: Date;
  report_count: string;
}

/**
 * 편지 컬럼 목록. 세 목록이 같은 모양의 편지를 붙여 나가므로 SELECT 조각을 한 번만 쓴다.
 *
 * `report_count`는 서브쿼리다 — 판정에 쓰이는 값이라 목록마다 다시 세지 않는다.
 */
const LETTER_COLUMNS = `
  l.id                as letter_id,
  l.mode,
  l.relationship,
  l.body,
  l.hint,
  l.question,
  l.quarantined_at,
  l.risk_level,
  l.status            as letter_status,
  l.auto_hide_exempt,
  l.created_at        as letter_created_at,
  (select count(*) from reports r2 where r2.letter_id = l.id) as report_count`;

function toQueueLetter(row: LetterColumns): QueueLetter {
  return {
    id: row.letter_id,
    mode: row.mode,
    relationship: row.relationship,
    body: row.body,
    hint: row.hint,
    question: row.question,
    quarantinedAt: row.quarantined_at?.toISOString() ?? null,
    riskLevel: row.risk_level,
    status: row.letter_status,
    autoHideExempt: row.auto_hide_exempt,
    createdAt: row.letter_created_at.toISOString(),
    reportCount: Number(row.report_count),
  };
}

/**
 * 격리된 편지의 본문을 복호해 채운다 ([D-028](../../../docs/00-decisions.md)).
 *
 * 같은 편지가 여러 목록(미판정 신고 · 자동 비공개 · 이의 제기)에 동시에 뜨는 것이
 * 정상이라, **편지당 한 번만 복호하고 결과를 나눠 쓴다.**
 *
 * `QUARANTINE_KEY`가 없으면 아무것도 하지 않는다 — 본문이 `null`인 채로 남고 화면이
 * 그 사실을 그린다. 여기서 던지면 큐 화면 전체가 죽고, 그러면 격리와 무관한 신고까지
 * 판정할 수 없게 된다.
 */
async function hydrateQuarantined(letters: QueueLetter[]): Promise<void> {
  if (env.QUARANTINE_KEY === undefined) return;

  const byId = new Map<string, QueueLetter[]>();
  for (const letter of letters) {
    if (letter.quarantinedAt === null || letter.body !== null) continue;
    const group = byId.get(letter.id);
    if (group) group.push(letter);
    else byId.set(letter.id, [letter]);
  }

  for (const [letterId, group] of byId) {
    const content = await readQuarantinedContent(letterId);
    if (!content) continue;
    for (const letter of group) {
      letter.body = content.body;
      letter.hint = content.hint;
      letter.question = content.question;
    }
  }
}

/**
 * 큐 한 화면.
 *
 * 정렬은 전부 **오래된 것부터**다. 판정 SLA가 24시간이라(02 §4) 가장 오래 기다린 것이
 * 가장 급하다.
 */
export async function loadQueue(): Promise<QueueView> {
  const [reports, autoHidden, appeals, deletionRequests, overdue] =
    await Promise.all([
      loadPendingReports(),
      loadAutoHidden(),
      loadPendingAppeals(),
      loadPendingDeletionRequests(),
      overdueQuarantine(),
    ]);

  // 격리된 편지는 `letters`에 본문이 없다 (D-028). 판정하려면 본문이 필요하므로
  // 여기서 복호해 채운다 — **이 표면에서만** 열린다.
  await hydrateQuarantined([
    ...reports.map((report) => report.letter),
    ...autoHidden,
    ...appeals.map((appeal) => appeal.letter),
  ]);

  return {
    reports,
    autoHidden,
    appeals,
    deletionRequests,
    overdue,
    truncated:
      reports.length === PAGE_LIMIT ||
      autoHidden.length === PAGE_LIMIT ||
      appeals.length === PAGE_LIMIT ||
      deletionRequests.length === PAGE_LIMIT,
  };
}

async function loadPendingReports(): Promise<QueueReport[]> {
  const { rows } = await query<
    LetterColumns & {
      id: string;
      reason: ReportReason;
      created_at: Date;
      incident_id: string;
      draft: string | null;
    }
  >(
    `select r.id, r.reason, r.created_at, r.incident_id, ${LETTER_COLUMNS},
            (select a.note from admin_actions a
              where a.action = $1 and a.target_id = r.id::text
              order by a.created_at desc limit 1) as draft
       from reports r
       join letters l on l.id = r.letter_id
      where r.status = 'pending'
      order by r.created_at asc
      limit ${PAGE_LIMIT}`,
    [REPORT_DRAFT_ACTION],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    incidentId: row.incident_id,
    draft: row.draft,
    letter: toQueueLetter(row),
  }));
}

/**
 * 자동 비공개 건 (05-api §4).
 *
 * 미판정 신고 목록과 겹치는 게 정상이다. 겹치지 않는 행 — 미판정 신고가 없는데
 * `hidden_auto`인 편지 — 이 보이면 그건 신고 접수 중에 뭔가 어긋났다는 뜻이라, 오히려
 * 그 행이 이 목록을 따로 두는 이유다.
 */
async function loadAutoHidden(): Promise<QueueLetter[]> {
  const { rows } = await query<LetterColumns>(
    `select ${LETTER_COLUMNS}
       from letters l
      where l.status = 'hidden_auto'
      order by l.status_changed_at asc
      limit ${PAGE_LIMIT}`,
  );
  return rows.map(toQueueLetter);
}

async function loadPendingAppeals(): Promise<QueueAppeal[]> {
  const { rows } = await query<
    LetterColumns & { id: string; message: string | null; created_at: Date }
  >(
    `select ap.id, ap.message, ap.created_at, ${LETTER_COLUMNS}
       from appeals ap
       join letters l on l.id = ap.letter_id
      where ap.status = 'pending'
      order by ap.created_at asc
      limit ${PAGE_LIMIT}`,
  );

  return rows.map((row) => ({
    id: Number(row.id),
    message: row.message,
    createdAt: row.created_at.toISOString(),
    letter: toQueueLetter(row),
  }));
}

/** 07 §5. 편지를 찾아 붙이지 않는다 — 대조는 운영자가 사람으로 한다. */
async function loadPendingDeletionRequests(): Promise<QueueDeletionRequest[]> {
  const { rows } = await query<{
    id: string;
    body_excerpt: string;
    contact: string | null;
    created_at: Date;
  }>(
    `select id, body_excerpt, contact, created_at
       from deletion_requests
      where status = 'pending'
      order by created_at asc
      limit ${PAGE_LIMIT}`,
  );

  return rows.map((row) => ({
    id: Number(row.id),
    bodyExcerpt: row.body_excerpt,
    contact: row.contact,
    createdAt: row.created_at.toISOString(),
  }));
}

// ── 판정 ────────────────────────────────────────────────────
//
// 셋 다 한 트랜잭션이다: 판정 행(`reports`·`appeals`) + 편지 상태 + `admin_actions`.
// 갈라지면 큐에 결론 없는 항목이 남거나, 이유를 모르는 상태 변경이 남는다.

export type ReportAction = "uphold" | "dismiss";
export type AppealAction = "restore" | "reject";

/** 이미 판정된 건을 다시 판정하지 않는다 — 큐를 두 사람이 볼 일은 없지만 새로고침은 한다. */
export type ResolveOutcome = "ok" | "not_found" | "already_resolved";

export async function resolveReport(
  reportId: number,
  action: ReportAction,
  note: string | null,
): Promise<ResolveOutcome> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ letter_id: string; status: string }>(
      "select letter_id, status from reports where id = $1 for update",
      [reportId],
    );
    const report = rows[0];
    if (!report) return "not_found";
    if (report.status !== "pending") return "already_resolved";

    const status = action === "uphold" ? "upheld" : "dismissed";
    await client.query(
      "update reports set status = $2, resolved_at = now() where id = $1",
      [reportId, status],
    );

    // 04 §3의 상태 기계 그대로.
    //   위반  → hidden_admin
    //   문제없음 → published + auto_hide_exempt (07 §2 원칙 2)
    if (action === "uphold") {
      await hideByAdminTx(client, report.letter_id);
    } else {
      // D-028 종결 ② 복원 — **본문을 먼저 되돌린다.** 순서가 반대면 본문 없는
      // `published`가 잠깐 존재하고, 그 틈에 피드 쿼리가 그 행을 집으면 빈 편지가 뜬다.
      // 격리되지 않은 편지에는 `false`를 돌려주고 아무것도 하지 않는다.
      await releaseQuarantineTx(client, report.letter_id);
      await restoreToPublishedTx(client, report.letter_id);
    }

    await recordAction(client, `report_${status}`, String(reportId), note);
    return "ok";
  });
}

export async function resolveAppeal(
  appealId: number,
  action: AppealAction,
  note: string | null,
): Promise<ResolveOutcome> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ letter_id: string; status: string }>(
      "select letter_id, status from appeals where id = $1 for update",
      [appealId],
    );
    const appeal = rows[0];
    if (!appeal) return "not_found";
    if (appeal.status !== "pending") return "already_resolved";

    const status = action === "restore" ? "restored" : "rejected";
    await client.query(
      "update appeals set status = $2, resolved_at = now() where id = $1",
      [appealId, status],
    );

    // `reject`는 **상태를 바꾸지 않는다** (05-api §4). 편지는 내려간 그대로 두고
    // `appeals.status`만 기록한다.
    if (action === "restore") {
      // 신고 `dismiss`와 같은 순서다 (D-028 종결 ② 복원).
      await releaseQuarantineTx(client, appeal.letter_id);
      await restoreToPublishedTx(client, appeal.letter_id);
    }

    await recordAction(client, `appeal_${status}`, String(appealId), note);
    return "ok";
  });
}

/**
 * 삭제 요청 처리 (07 §5).
 *
 * **`letterId`는 필수다.** 어느 편지인지는 운영자가 `body_excerpt`를 본문과 대조해서
 * 사람으로 정한다 — 서버가 본문으로 편지를 찾아 지우면 본문 일부만 아는 사람이 남의
 * 편지를 지울 수 있다 (04 §5 발견 3). 그래서 접수 시 비워둔 `letter_id`를 여기서 채운다.
 *
 * **편지는 `deleted_by_author`로 간다** — `hidden_admin`이 아니다. 관리 링크를
 * 잃어버렸을 뿐 결국 작성자 본인의 삭제이고, 나중에 작성자가 링크를 찾았을 때 410
 * ("이미 지웠다")을 봐야 사실과 맞는다 (05-api §2 표 · 07 §5).
 *
 * 편지가 이미 지워졌거나 없어도 요청은 처리 완료로 내린다 — 결과가 같기 때문이다.
 */
export async function resolveDeletionRequest(
  requestId: number,
  letterId: string,
  note: string | null,
): Promise<ResolveOutcome | "letter_not_found"> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ status: string }>(
      "select status from deletion_requests where id = $1 for update",
      [requestId],
    );
    const request = rows[0];
    if (!request) return "not_found";
    if (request.status !== "pending") return "already_resolved";

    const { rows: letters } = await client.query<{ id: string }>(
      "select id from letters where id = $1",
      [letterId],
    );
    if (!letters[0]) return "letter_not_found";

    // 상태 전이는 deletion.ts를 통해서만 한다.
    await deleteByAuthorTx(client, letterId);

    await client.query(
      `update deletion_requests
          set status = 'resolved', resolved_at = now(), letter_id = $2
        where id = $1`,
      [requestId, letterId],
    );
    await recordAction(
      client,
      "deletion_request_resolved",
      String(requestId),
      note,
    );
    return "ok";
  });
}

/**
 * 05-api §4: **모든 운영자 호출은 `admin_actions`에 기록.**
 *
 * `note`는 07 §2 원칙 3의 "판정 이유 한 줄"이다. 비어 있어도 행은 남긴다 — 이유 없는
 * 판정이 있었다는 사실 자체가 기록이다.
 */
async function recordAction(
  client: PoolClient,
  action: string,
  targetId: string,
  note: string | null,
): Promise<void> {
  await client.query(
    "insert into admin_actions (action, target_id, note) values ($1, $2, $3)",
    [action, targetId, note],
  );
}
