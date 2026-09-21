// 신고 접수 — `POST /api/letters/:id/report`가 쓰는 조회·삽입 (05-api §2 · 02 §4).
//
// 편지 상태 전이는 여기 없다. `src/lib/letters/deletion.ts`가 전부 갖는다
// (README 「편지 상태는 한 파일에서만 바꾼다」).

import { query } from "../db";
import { LIMITS } from "../ratelimit";
import type { ReportReason } from "./reasons";

/** 신고 대상 편지. 신고 표면이 판정에 쓰는 값만 읽는다 — 본문은 읽지 않는다. */
export interface ReportTarget {
  id: string;
  status: "published" | "hidden_auto" | "hidden_admin" | "deleted_by_author";
  /** 06 §3 `report_submitted { reason, relationship }`의 props. 계측이 붙을 때 쓴다. */
  relationship: string;
}

/**
 * 신고 대상을 찾는다. 없으면 `null`.
 *
 * **이미 비공개인 편지(`hidden_auto`·`hidden_admin`)도 신고를 받는다.** 05-api §2의
 * 「상태별 표면 응답」은 읽기 표면의 표이고 신고는 거기 없다. 받는 쪽으로 정한 이유:
 * 07 §2 판정표의 **사칭은 "신고 2건 이상이면 삭제"**라 건수 자체가 판정 근거다. 이미
 * 내려간 편지의 두 번째 신고를 버리면 그 근거가 사라진다.
 *
 * 대신 `deleted_by_author`는 대상이 아니다 — 편지가 없다.
 */
export async function findReportTarget(
  letterId: string,
): Promise<ReportTarget | null> {
  const { rows } = await query<ReportTarget>(
    "select id, status, relationship from letters where id = $1",
    [letterId],
  );
  return rows[0] ?? null;
}

/** 04 §2 `reports` 한 행. 판정 전이므로 `status`는 기본값 `pending`이다. */
export async function insertReport(
  letterId: string,
  reason: ReportReason,
  reporterFpHash: Buffer,
): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `insert into reports (letter_id, reason, reporter_fp_hash)
     values ($1, $2, $3)
     returning id`,
    [letterId, reason, reporterFpHash],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("신고 행을 돌려받지 못했다.");
  return Number(id);
}

/**
 * 429의 `retryAfter`(초) — 창 안에서 **가장 오래된 신고가 빠져나가는 시점**까지.
 *
 * 한도를 채운 뒤에만 부른다. 창 전체(24시간)를 그대로 돌려주면 실제로는 1분 뒤에 다시
 * 가능한 사람에게 하루를 기다리라고 말하게 된다.
 */
export async function reportRetryAfterSeconds(
  reporterFpHash: Buffer,
): Promise<number> {
  const windowSeconds = LIMITS.reportPerDay.windowMs / 1000;
  const { rows } = await query<{ seconds: string | null }>(
    `select extract(epoch from
              min(created_at) + make_interval(secs => $2) - now()) as seconds
       from reports
      where reporter_fp_hash = $1
        and created_at > now() - make_interval(secs => $2)`,
    [reporterFpHash, windowSeconds],
  );
  const seconds = Number(rows[0]?.seconds ?? windowSeconds);
  return Math.max(1, Math.ceil(seconds));
}
