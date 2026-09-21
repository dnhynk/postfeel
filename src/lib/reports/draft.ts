// 신고 큐 초안 판정 — 만들고 저장한다 (07 §2 · 05-api §1).
//
// 07 §2 「큐에는 분류기가 붙여둔 초안이 있다」가 약속한 것을 실제로 붙이는 자리다.
// 판정 자체는 S2의 `draftReportVerdict`가 내고(행 · 근거 한 줄 · 신뢰도), 여기서는
// **어디에 어떤 모양으로 남기는가**만 정한다.
//
// ── 응답을 막지 않는다 ──────────────────────────────────────
// 07 §2: "제출 경로가 아니므로 지연이 무관하다." 부르는 쪽(신고 라우트)이
// `scheduleAfterResponse`로 응답 뒤에 돌린다. 그래서 이 함수는 **던지지 않는다** —
// 응답은 이미 나갔고 예외를 받아줄 호출자가 없다. 초안은 운영자 보조이지 안전 장치가
// 아니라서, 실패하면 큐가 "아직 없습니다"를 보여주고 운영자가 본문을 처음부터 읽을 뿐
// 신고 접수 · 자동 비공개 · 텔레그램은 그대로 돈다.
//
// ── 저장 위치는 `admin_actions`다 ───────────────────────────
// 04의 규약대로 새 테이블을 만들기 전에 있는 걸 썼다. R1이 큐를 만들면서 남긴 판단이
// 맞다 (`src/lib/admin/queue.ts` 머리말):
//
//   초안  action='report_draft'      target_id=<신고 ID>  note=<초안 한 줄>
//   최종  action='report_upheld'     target_id=<신고 ID>  note=<판정 이유>
//         action='report_dismissed'
//
// 같은 `target_id`로 묶이므로 07 §7 주간 점검 5번(초안 vs 최종 판정의 불일치율)이 이
// 테이블 안에서 세어진다. 컬럼도 그대로 맞는다 — `note`는 원래 "판정 이유 한 줄"이
// 들어가는 자리다 (07 §2 원칙 3).
//
// ── 본문을 저장하지 않는다 ──────────────────────────────────
// 근거 한 줄은 **판정 사유이지 본문 인용이 아니다.** 09 §3이 텔레그램 메시지에 본문을
// 넣지 않는 것과 같은 이유다 (L-007): `admin_actions`에는 편지에 걸린 외래키가 없어서
// **편지가 사라져도 이 행은 남는다.** 본문 조각이 여기 들어가면 L-007의 답이 "완전
// 삭제"로 나온 날 지워야 할 사본이 `letters.body` 밖에 하나 더 생긴다.
//
// 프롬프트도 "본문을 통째로 옮기지 않는다"고 요구하지만(`safety/prompt.ts`), 프롬프트는
// 요청이고 아래 검사가 보장이다 — 05-api §1이 인터스티셜 `notice`에 같은 이중 방어를
// 둔 것과 같다 (`classifier.ts`의 `quotesDraft`).
//
// ── 조치를 담지 않는다 ──────────────────────────────────────
// 07 §2: **판정은 사람이 한다.** 이 행에는 후보 행 · 근거 · 신뢰도만 들어간다. 삭제 ·
// 복구를 제안하는 필드도, 그걸 계산해 두는 컬럼도 만들지 않는다.

import { REPORT_DRAFT_ACTION } from "../admin/queue";
import { query } from "../db";
import { readQuarantinedContent } from "../letters/deletion";
import {
  draftReportVerdict,
  type ReportVerdictDraft,
} from "../safety/classifier";
import { REPORT_REASON_LABELS, type ReportReason } from "./reasons";

/** 분류기가 읽는 편지. 판정에 필요한 세 필드뿐이다. */
interface DraftTarget {
  body: string;
  hint?: string;
  question?: string;
}

/**
 * 인용 판정 창. `classifier.ts`의 `quotesDraft`와 같은 값이다 — 같은 규칙을 같은 세기로
 * 건다. 한국어에서 공백을 지운 8자는 우연히 겹치기 어려운 길이다 (가설값).
 */
const QUOTE_WINDOW = 8;

/** 근거가 본문을 인용했을 때 그 자리에 대신 남기는 문장. */
const QUOTED_RATIONALE =
  "근거 문장이 본문을 인용해 저장하지 않았습니다. 본문을 직접 읽고 판정합니다.";

/** 모델이 근거를 비워 보낸 경우. 행과 신뢰도는 그대로 쓸모가 있다. */
const EMPTY_RATIONALE = "근거가 비어 있습니다.";

function compact(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").toLowerCase();
}

/**
 * 근거 한 줄이 편지의 표현을 그대로 옮겼는가.
 *
 * 공백을 지운 뒤 비교한다 — "OO 고등학교"를 "OO고등학교"로 옮기면 문자열로는 다르지만
 * 인용인 것은 같다.
 */
function quotesLetter(rationale: string, letter: DraftTarget): boolean {
  const target = compact(rationale);
  for (const source of [letter.body, letter.hint, letter.question]) {
    if (source === undefined) continue;
    const text = compact(source);
    if (text.length < QUOTE_WINDOW) continue;
    for (let i = 0; i + QUOTE_WINDOW <= text.length; i += 1) {
      if (target.includes(text.slice(i, i + QUOTE_WINDOW))) return true;
    }
  }
  return false;
}

/**
 * 큐에 뜨는 한 줄.
 *
 *   [doxx] 신상 노출 · 신뢰도 medium — 본문에 학급과 좌석이 있어 소속 특정이 가능하다.
 *
 * **대괄호 접두사는 기계가 읽는다.** 07 §7 주간 점검 5번이 초안 행별 분포를 내려면
 * 행 값이 `note` 안에서 다시 나와야 하는데, `admin_actions`에는 컬럼을 더하지 않는다
 * (04: 있는 걸 쓴다 · 새 컬럼은 마지막 수단). 뒤쪽 한국어는 운영자가 읽는 부분이다 —
 * 07 §1의 건당 1분 안에 확인만 하면 되게 두 독자를 한 줄에 담는다.
 *
 * 인용이 섞였으면 **문장만 버리고 판정은 남긴다.** 05-api §1이 `notice`에서 하는 것과
 * 같은 처리다 — 후보 행과 신뢰도는 인용 여부와 무관하게 유효하다.
 */
export function draftNote(
  draft: ReportVerdictDraft,
  letter: DraftTarget,
): string {
  const rationale = draft.rationale.replace(/\s+/gu, " ").trim();
  const safe =
    rationale === ""
      ? EMPTY_RATIONALE
      : quotesLetter(rationale, letter)
        ? QUOTED_RATIONALE
        : rationale;
  return `[${draft.row}] ${REPORT_REASON_LABELS[draft.row]} · 신뢰도 ${draft.confidence} — ${safe}`;
}

/**
 * 분류기가 읽을 편지.
 *
 * 신고 라우트가 쓰는 `findReportTarget`은 본문을 읽지 않는다(그게 그 함수의 규칙이다).
 * 초안은 본문을 읽어야 나오므로 여기서 따로 읽는다 — **응답이 나간 뒤**라 제출 경로의
 * 예산과 무관하다.
 *
 * 미루는 사이에 작성자가 지웠으면 만들지 않는다. `letters/create.ts`의
 * `fillAnswerVariants`가 같은 이유로 지워진 편지를 건너뛴다.
 *
 * ── 격리된 편지를 함께 본다 (D-028) ─────────────────────────
 * **심각 카테고리 신고는 접수와 동시에 본문을 격리로 옮긴다.** 초안은 응답 뒤에 도는데
 * 그때는 이미 `letters.body`가 비어 있다 — 그래서 격리 영역도 봐야 한다. 안 보면
 * 초안이 가장 필요한 신고(doxx·sexual·selfharm)에서만 조용히 안 만들어진다.
 */
async function loadDraftTarget(letterId: string): Promise<DraftTarget | null> {
  const { rows } = await query<{
    body: string | null;
    hint: string | null;
    question: string | null;
    quarantined_at: Date | null;
  }>(
    `select body, hint, question, quarantined_at
       from letters
      where id = $1 and status <> 'deleted_by_author'`,
    [letterId],
  );
  const row = rows[0];
  if (!row) return null;

  const content =
    row.body === null && row.quarantined_at !== null
      ? await readQuarantinedContent(letterId)
      : row;
  if (!content || content.body === null) return null;

  return {
    body: content.body,
    ...(content.hint === null ? {} : { hint: content.hint }),
    ...(content.question === null ? {} : { question: content.question }),
  };
}

/**
 * 신고 한 건의 초안을 만들어 `admin_actions`에 남긴다. **응답이 나간 뒤에 돈다.**
 *
 * 초안이 없으면(모델 실패 · 거부 · 비용 상한) 행을 만들지 않는다. 없는 초안을 빈 행으로
 * 남기면 07 §7 5번의 분모가 부풀고, 큐 화면은 어차피 `null`을 "아직 없습니다"로 그린다.
 *
 * 비용 상한은 `draftReportVerdict` 안의 `checkBudget('report_draft')`가 본다 —
 * 05-api §1의 끄는 순서(표기 변형 → 큐 초안 → 등급 판정)가 `budget.ts` 한 곳에 있고
 * 여기서 다시 판단하지 않는다.
 */
export async function fillReportDraft(
  reportId: number,
  letterId: string,
  reason: ReportReason,
): Promise<void> {
  try {
    const letter = await loadDraftTarget(letterId);
    if (!letter) return;

    const draft = await draftReportVerdict(letter, reason);
    if (draft === null) return;

    await query(
      "insert into admin_actions (action, target_id, note) values ($1, $2, $3)",
      [REPORT_DRAFT_ACTION, String(reportId), draftNote(draft, letter)],
    );
  } catch (error) {
    // 여기서 던지면 받아줄 곳이 없다. 초안은 운영자 보조라 실패가 신고 처리를 막지 않는다.
    console.error("[reports] 큐 초안 저장 실패", error);
  }
}
