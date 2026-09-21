// 공개 저장소에서는 실서비스 규칙을 제외했다.
//
// 층 2 분류기의 프롬프트와 JSON 스키마. **문자열이 사는 유일한 자리다.**
//
// classifier.ts는 호출·재시도·예산만 다루고 문구는 전부 여기서 가져간다. 나누는 이유는
// 05-api §1 「프롬프트 캐싱」이다 — 캐시는 **정확한 접두사 일치**로만 걸리므로, 접두사가
// 호출 지점마다 조금씩 다르게 조립되면 v0에서 안 걸리는 캐시가 나중에 작성량이 붙어도
// 계속 안 걸린다. 접두사를 한 곳에 모아두면 그 사고가 구조적으로 불가능하다.
//
// **여기에 타임스탬프·요청 ID·편지 ID를 섞지 않는다.** 섞는 순간 접두사가 매 요청 달라져
// 캐시가 통째로 깨진다 (05-api §1).
//
// 세 가지 호출이 있고 셋 다 D-020의 일일 $5 상한을 함께 쓴다 (budget.ts):
//   1. 등급 판정      classify()               — 제출 경로. 예산 3초
//   2. 표기 변형      generateAnswerVariants() — locked 편지가 실제로 생성될 때만 (D-021)
//   3. 신고 큐 초안   draftReportVerdict()     — 제출 경로가 아니라 지연 무관 (07 §2)

// 스키마 enum은 **types.ts의 런타임 배열에서 만든다** (05-api §1 명시). 목록을 여기
// 다시 적으면 분류기가 우리가 모르는 kind를 돌려주거나 그 반대가 된다.
//
// `contact`·`url`은 층 1이 내는 값이지만 목록이 하나라 분류기도 같은 kind를 쓴다.
import { FLAG_FIELDS, FLAG_KINDS, type LetterDraft } from "./types";

// ── 1. 등급 판정 ────────────────────────────────────────────

/**
 * 05-api §1이 확정한 출력 스키마.
 *
 * strict 모드는 **모든 속성이 `required`에 있어야 하고 `additionalProperties: false`여야
 * 한다** (구조화 출력 가이드). 그래서 선택 필드인 `notice`를 `["string","null"]`로 두고
 * `required`에 넣는다 — 모델이 할 말이 없으면 `null`을 주고, 파서가 `undefined`로 되돌린다.
 * https://developers.openai.com/api/docs/guides/structured-outputs
 */
export const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["risk", "flags", "notice"],
  properties: {
    risk: { type: "string", enum: ["low", "medium", "high"] },
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "field"],
        properties: {
          kind: { type: "string", enum: FLAG_KINDS },
          field: { type: "string", enum: FLAG_FIELDS },
        },
      },
    },
    notice: { type: ["string", "null"] },
  },
} as const;

/**
 * 등급 판정 프롬프트 접두사. **편지마다 안 바뀐다.**
 *
 * 규칙의 출처는 전부 문서다 — 위협 모델 §2(3등급 표) · §3(인터스티셜 원칙) ·
 * D-016 + 코디네이터 결정(2026-08-14, question은 hint와 동급).
 */
export const CLASSIFY_INSTRUCTIONS = `너는 한국어 편지의 안전 분류기다.
실서비스 프롬프트는 비공개다. 주어진 JSON 스키마로만 답한다.`;

/**
 * 판정 대상을 직렬화한다. **접두사가 아니라 접미사다** — 편지마다 달라지는 부분이라
 * 여기에 무엇이 들어가든 캐시에 영향이 없다.
 *
 * 칸 표지를 고정 문자열로 둔다. 표지가 없으면 모델이 어느 칸의 표현인지 알 수 없고,
 * 그러면 D-016의 field가 추측이 된다.
 *
 * `answer`(열쇠 정답)는 **보내지 않는다.** 등급 판정 대상이 아니고(05-api §1), 열람자가
 * 맞혀야 하는 값이라 판정 로그·프롬프트 어디에도 남길 이유가 없다.
 */
export function buildClassifyInput(draft: LetterDraft): string {
  const lines = [
    `[mode] ${draft.mode}`,
    `[relationship] ${draft.relationship}`,
    `[body]\n${draft.body}`,
  ];
  if (draft.hint !== undefined) lines.push(`[hint]\n${draft.hint}`);
  if (draft.question !== undefined) lines.push(`[question]\n${draft.question}`);
  return lines.join("\n\n");
}

// ── 2. 표기 변형 (D-021) ────────────────────────────────────

/**
 * 변형 개수는 코드에서 자른다.
 *
 * strict 스키마가 지원하는 키워드 집합이 좁아 `minItems`/`maxItems`에 기대지 않는다.
 * 개수 제약(3~5개)은 프롬프트로 요구하고 classifier.ts가 실제로 잘라낸다 — 모델이 8개를
 * 주더라도 저장되는 건 5개다.
 */
export const VARIANTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["variants"],
  properties: {
    variants: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * D-021 · 05-api §1 「표기 변형은 등급 판정과 다른 호출이다」.
 *
 * 이 프롬프트의 유일한 위험은 **넓어지는 것**이다. 상위 개념이나 추측 가능한 일반명사로
 * 넓히면 제3자 적중률이 올라가 S-6(브루트포스 열람)이 약해진다. 그래서 금지를 예시로
 * 못박는다 — "같은 대상을 가리키는 다른 표기"와 "같은 범주의 다른 것"은 다르다.
 */
export const VARIANTS_INSTRUCTIONS = `너는 한국어 표기 변형 생성기다.
실서비스 프롬프트는 비공개다. 주어진 JSON 스키마로만 답한다.`;

export function buildVariantsInput(answer: string): string {
  return `[answer]\n${answer}`;
}

// ── 3. 신고 큐 초안 판정 (07 §2) ────────────────────────────

/**
 * 07-operations §2 판정표의 행. 값은 `reports.reason`(0001_init.sql)과 같은 집합이다 —
 * 신고 사유와 판정 행이 1:1이라 다른 이름을 만들 이유가 없다.
 */
export const REPORT_ROWS = [
  "doxx",
  "targeting",
  "impersonation",
  "sexual",
  "selfharm",
  "spam",
  "other",
] as const;

export const REPORT_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["row", "rationale", "confidence"],
  properties: {
    row: { type: "string", enum: REPORT_ROWS },
    rationale: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;

/**
 * 07 §2 「큐에는 분류기가 붙여둔 초안이 있다」.
 *
 * **조치를 내지 않는다.** 07 §2가 못박았다 — 분류기에 조치까지 맡기면 D-012가 사전 검토를
 * 기각한 근거(사후에는 사람이 판단한다)가 조용히 무너지고 운영자는 승인 버튼만 누르는
 * 사람이 된다. 그래서 이 프롬프트는 **행·근거·신뢰도까지만** 요구한다.
 */
export const REPORT_VERDICT_INSTRUCTIONS = `너는 신고 처리 큐의 초안 작성자다.
실서비스 프롬프트는 비공개다. 주어진 JSON 스키마로만 답한다.`;

export function buildReportVerdictInput(
  letter: { body: string; hint?: string; question?: string },
  reason: string,
): string {
  const lines = [`[reason] ${reason}`, `[body]\n${letter.body}`];
  if (letter.hint !== undefined) lines.push(`[hint]\n${letter.hint}`);
  if (letter.question !== undefined)
    lines.push(`[question]\n${letter.question}`);
  return lines.join("\n\n");
}
