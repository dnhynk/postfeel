// 층 2 — LLM 분류기. OpenAI `gpt-5.6-luna`, JSON 스키마 강제 출력 (D-020 · 05-api §1).
//
// **호출 형태의 근거 (기억이 아니라 문서에서 확인, 2026-08-14)**
//   · 모델·단가·effort 값 집합  https://developers.openai.com/api/docs/models/gpt-5.6-luna
//   · Responses API + 스키마 강제 `text.format`, `strict: true`, refusal의 위치
//     https://developers.openai.com/api/docs/guides/structured-outputs
//   · `reasoning.effort` 파라미터  https://developers.openai.com/api/docs/guides/reasoning
//   · `prompt_cache_key` · `usage.input_tokens_details.cached_tokens`
//     https://developers.openai.com/api/docs/guides/prompt-caching
//   · SDK의 `timeout` · `maxRetries` 옵션과 `APIConnectionTimeoutError`
//     https://github.com/openai/openai-node
//
// Chat Completions가 아니라 **Responses API**를 쓴다. 추론 모델은 Responses 쪽에서
// 동작이 정의돼 있고(추론 가이드), refusal이 `output[].content[]`의 항목 타입으로
// 명시돼 있어 "스키마 밖 응답"을 추측 없이 구분할 수 있다.
//
// ## 이 파일의 가장 중요한 규칙
//
// **거부(refusal)와 장애를 절대 섞지 않는다** (05-api §1 · D-020 · 안전 테스트 22).
//
//   타임아웃·네트워크·비용상한 → { state: 'unavailable' } → medium 강등, 편지는 생성됨
//   모델의 거부              → { state: 'refusal' }     → high, 편지가 생성되지 않는다
//
// 거부를 장애 경로로 흘리면 medium으로 강등돼 **게시된다.** S-4·S-5는 게시되면 안 되는
// 카테고리이고, 하필 그 카테고리가 거부를 유발할 가능성이 가장 높다.
//
// **classify()는 던지지 않는다.** 제출 경로에 동기로 걸려 있어 예외가 곧 작성 불가다.
// 모든 실패는 `unavailable`로 돌아간다 (D-015).

import OpenAI from "openai";
import { z } from "zod";
import { requireEnv } from "../env";
import { checkBudget, recordSpend, type TokenUsage } from "./budget";
import {
  buildClassifyInput,
  buildReportVerdictInput,
  buildVariantsInput,
  CLASSIFY_INSTRUCTIONS,
  CLASSIFY_SCHEMA,
  REPORT_ROWS,
  REPORT_VERDICT_INSTRUCTIONS,
  REPORT_VERDICT_SCHEMA,
  VARIANTS_INSTRUCTIONS,
  VARIANTS_SCHEMA,
} from "./prompt";
import {
  FLAG_FIELDS,
  FLAG_KINDS,
  type ClassifierOutcome,
  type LetterDraft,
} from "./types";

/** D-020 · 모델 교체는 감이 아니라 M6 평가셋이 정한다. */
const MODEL = "gpt-5.6-luna";

/**
 * `none` | `low` 중 **`none`** (D-020 · 05-api §1).
 *
 * 감이 아니라 실측으로 골랐다. 같은 편지(입력 952토큰)로 2026-08-14에 잰 값:
 *
 *   effort=none   1,618 ms · 1,618~2,117 ms 사이
 *   effort=low    4,397 ms
 *
 * **`low`는 3초 타임아웃을 넘긴다.** 즉 `low`로 두면 제출 경로가 매번 3초를 버린 뒤
 * `unavailable` → medium 강등으로 끝난다 — 분류기를 켜 두고 끈 것과 같아진다.
 * (타임아웃은 재시도하지 않으므로 재시도까지 태우지는 않는다. `toFailure` 참조.)
 *
 * 재현율이 부족하다고 M6 평가셋이 판정하면 올릴 대상은 effort가 아니라 **모델 등급**이다
 * (D-020: luna ↔ terra). effort를 올리면 예산부터 깨진다.
 */
const REASONING_EFFORT = "none";

/** 05-api §1 「동작 파라미터」 — 전부 가설값. */
const TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 1_000;
/** 최초 1회 + 재시도 1회. */
const MAX_ATTEMPTS = 2;

/**
 * 제출 경로 호출의 **총 예산 상한** (가설값 — 실측 후 조정).
 *
 * 어떤 경로로도 한 번의 분류 호출이 이 시간을 넘지 않는다. `callWithRetry`가 상수 산수가
 * 아니라 **시계로** 강제한다 — 위 상수들이 따로 움직여도 상한은 산다.
 *
 * 4초인 이유는 재시도 규칙과 함께 봐야 한다(`toFailure` 주석): 타임아웃은 재시도하지
 * 않으므로 예산을 다 쓰는 경로는 "빠른 실패(≈0초) → 1초 대기 → 3초" 하나뿐이다.
 */
const TOTAL_BUDGET_MS = 4_000;

/**
 * 신고 큐 초안은 **제출 경로가 아니라 지연이 무관하다** (07 §2). 3초 예산을 물려받을
 * 이유가 없어 넉넉히 준다. 가설값.
 */
const REPORT_TIMEOUT_MS = 30_000;

/**
 * 큐 초안의 총 예산 (30초 + 1초 대기 + 30초). 제출 경로가 아니라 `TOTAL_BUDGET_MS`의
 * 4초를 물려받지 않는다 — 운영자가 큐를 여는 속도는 사용자 이탈과 무관하다. 가설값.
 */
const REPORT_BUDGET_MS = 61_000;

/**
 * 출력 토큰 상한. 추론 토큰이 여기 함께 잡히고, 넘으면 `status: 'incomplete'`로 돌아온다
 * (추론 가이드). effort가 `none`이라 실제 사용량은 훨씬 작지만, 상한에 걸려 판정이
 * 통째로 날아가는 쪽이 토큰 몇 개보다 비싸다. 가설값.
 */
const MAX_OUTPUT_TOKENS = 4_096;

/**
 * D-021의 상한. 넓힐수록 제3자 적중률이 올라가 S-6이 약해진다. 모델이 더 많이 주면
 * **코드가 자른다** — 프롬프트만으로 개수를 믿지 않는다.
 */
const MAX_VARIANTS = 5;

/**
 * 인용 판정 창 (가설값). 공백을 지운 뒤 이만큼 연속으로 겹치면 인용으로 본다.
 * 한국어에서 8자는 우연히 겹치기 어려운 길이다.
 */
const QUOTE_WINDOW = 8;

// ── OpenAI 클라이언트 ───────────────────────────────────────

/**
 * **지연 생성한다.** 모듈 로드 시점에 만들면 `OPENAI_API_KEY`가 없는 환경(M1 로컬 · CI)에서
 * 이 파일을 import 하는 것만으로 죽는다 — env.ts가 이 값을 optional로 둔 이유가 그거다.
 *
 * 모듈 변수로 재사용하는 것은 db.ts의 커넥션 풀과 같은 성격이다: 캐시가 아니라 연결 관리라
 * README 「DB 접근」의 "프로세스 로컬 상태 금지"에 걸리지 않는다. 판정 결과는 여기 담기지
 * 않는다.
 */
let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: requireEnv("OPENAI_API_KEY"),
      // 재시도는 우리가 한다. SDK 기본값(2회)을 그대로 두면 3초 타임아웃이 세 번 겹쳐
      // 제출 경로가 9초를 기다린다.
      maxRetries: 0,
    });
  }
  return client;
}

// ── 공통 호출 ───────────────────────────────────────────────

type ModelFailure = {
  kind: "failure";
  reason: string;
  /** 이 실패에 재시도가 값을 만드는가. 판별 근거는 `toFailure`. */
  retryable: boolean;
};

type ModelResult =
  | { kind: "json"; value: unknown }
  | { kind: "refusal" }
  | ModelFailure;

interface CallOptions {
  instructions: string;
  input: string;
  schema: unknown;
  schemaName: string;
  /** 접두사가 같은 요청끼리 같은 캐시로 라우팅되게 한다 (프롬프트 캐싱 가이드). */
  cacheKey: string;
  timeoutMs: number;
  /** 재시도까지 합친 총 소요 상한. `timeoutMs`와 달리 호출 **전체**에 걸린다. */
  budgetMs: number;
  attempts: number;
  now: Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usageOf(response: {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
  } | null;
}): TokenUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

/**
 * 한 번 호출하고 결과를 세 갈래(JSON · 거부 · 실패)로 줄인다.
 *
 * **거부는 재시도하지 않는다.** 같은 입력에 같은 모델은 다시 거부하고, 그 사이 제출 경로가
 * 1초를 더 기다린다. 무엇보다 거부는 실패가 아니라 판정 결과다.
 */
async function callOnce(options: CallOptions): Promise<ModelResult> {
  let response;
  try {
    response = await getClient().responses.create(
      {
        model: MODEL,
        instructions: options.instructions,
        input: options.input,
        reasoning: { effort: REASONING_EFFORT },
        text: {
          format: {
            type: "json_schema",
            name: options.schemaName,
            strict: true,
            schema: options.schema as Record<string, unknown>,
          },
        },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        // 편지 본문을 벤더 쪽에 남기지 않는다. 04 「저장하지 않는 것」과 같은 기준이다.
        store: false,
        prompt_cache_key: options.cacheKey,
      },
      { timeout: options.timeoutMs, maxRetries: 0 },
    );
  } catch (error) {
    return toFailure(error);
  }

  // 거부든 정상이든 토큰은 청구된다. 판정보다 먼저 센다.
  await recordSpend(usageOf(response), options.now).catch(() => {
    // 누적 실패가 판정을 막지 않는다. 상한은 안전 장치이지 판정 조건이 아니다.
  });

  // 구조화 출력 가이드: 거부는 output[].content[]에 `type: 'refusal'` 항목으로 온다.
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "refusal") return { kind: "refusal" };
    }
  }

  // 여기서부터는 **응답이 실제로 돌아온** 실패다. 타임아웃이 아니므로 재시도 대상이다.
  // max_output_tokens에 걸리면 본문이 잘린 채 온다 (추론 가이드). 파싱을 시도하지 않는다.
  if (response.status === "incomplete") {
    return { kind: "failure", reason: "incomplete", retryable: true };
  }

  const text = response.output_text;
  if (!text) {
    return { kind: "failure", reason: "empty_output", retryable: true };
  }

  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    // strict 스키마에서는 일어나면 안 된다. 일어나면 판정이 아니라 장애다.
    return { kind: "failure", reason: "unparsable_json", retryable: true };
  }
}

function failureReason(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (error instanceof OpenAI.APIConnectionError) return "network";
  if (error instanceof OpenAI.APIError) return `api_${error.status ?? "error"}`;
  return "unknown";
}

/**
 * SDK 오류를 실패 결과로 바꾸고 **재시도 여부를 여기서 정한다.**
 *
 * ## 타임아웃에는 재시도하지 않는다 (코디네이터 판정, 2026-08-15)
 *
 * 1. 3초를 다 태운 뒤의 재시도는 대개 또 타임아웃이다. 재시도가 실제로 값을 만드는 것은
 *    **빠르게 끝나는 실패** — 연결 거부 · 5xx · 일시적 네트워크 오류다
 * 2. 제출 경로에서 7초(3+1+3)는 05-api §1이 스스로 정한 "3초 이상은 고장으로 인식된다"를
 *    넘는다. `locked` 편지는 변형 생성 호출이 뒤에 붙어 더 나빠진다
 * 3. **재시도를 안 해서 지는 비용이 낮다.** D-015가 실패 경로를 이미 안전하게 설계했다 —
 *    medium 강등으로 편지는 생성되고 공유 링크도 살아 있으며, 재분류 잡이 나중에 등급을
 *    갱신한다. 반면 7초 제출은 사용자가 실패로 인식하고 이탈한다
 *
 * ## 판별은 SDK의 오류 **타입**으로 한다
 *
 * `APIConnectionTimeoutError`는 SDK가 `timeout` 옵션으로 요청을 끊었을 때만 던지는
 * 클래스다(https://github.com/openai/openai-node). `reason` 문자열이나 오류 메시지를
 * 보지 않는다 — 문구는 SDK 판올림에 바뀌고, 그날 이 규칙은 조용히 "전부 재시도"로 돌아간다.
 *
 * `APIConnectionError`(연결 거부 등)는 타임아웃의 **부모 클래스**라 순서가 중요하다.
 * `instanceof`로 자식을 먼저 걸러야 연결 실패가 타임아웃으로 오인되지 않는다.
 */
function toFailure(error: unknown): ModelFailure {
  return {
    kind: "failure",
    reason: failureReason(error),
    retryable: !(error instanceof OpenAI.APIConnectionTimeoutError),
  };
}

/**
 * 재시도 가능한 실패면 한 번 더 — 단 **총 예산 안에서만.** 거부·JSON은 그대로 돌려준다.
 *
 * 예산은 마감 시각으로 잡고 2회차의 `timeout`을 남은 시간으로 잘라 넘긴다. "3+1+3이 4를
 * 넘지 않는다"를 상수 산수로 믿는 대신 시계로 강제한다 — 1회차가 예상보다 오래 끌어도
 * 상한이 산다.
 */
async function callWithRetry(options: CallOptions): Promise<ModelResult> {
  const deadline = Date.now() + options.budgetMs;
  let last: ModelFailure = {
    kind: "failure",
    reason: "not_attempted",
    retryable: true,
  };

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    if (attempt > 0) {
      // 타임아웃은 여기서 끝난다 (`toFailure`).
      if (!last.retryable) return last;
      // 대기하고 나면 호출할 시간이 남지 않는 경우. 1초를 버리지 않는다.
      if (deadline - Date.now() <= RETRY_DELAY_MS) return last;
      await sleep(RETRY_DELAY_MS);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;

    const result = await callOnce({
      ...options,
      timeoutMs: Math.min(options.timeoutMs, remaining),
    });
    if (result.kind !== "failure") return result;
    last = result;
  }

  return last;
}

// ── 1. 등급 판정 ────────────────────────────────────────────

const classifyPayload = z.object({
  risk: z.enum(["low", "medium", "high"]),
  flags: z.array(
    z.object({
      kind: z.enum(FLAG_KINDS),
      field: z.enum(FLAG_FIELDS),
    }),
  ),
  notice: z.string().nullish(),
});

function compact(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").toLowerCase();
}

/**
 * `notice`가 편지의 표현을 그대로 옮겼는가 (05-api §1 명시).
 *
 * 프롬프트에서 금지하는 것만으로는 부족하다 — 이 문장은 화면에 그대로 뜨고, 캡처되면
 * 우리 통제를 벗어난다. 프롬프트는 요청이고 이 검사는 보장이다.
 *
 * 공백을 지운 뒤 비교하는 이유: "OO 고등학교"를 "OO고등학교"로 옮기면 문자열로는 다르지만
 * 인용인 것은 같다.
 */
function quotesDraft(notice: string, draft: LetterDraft): boolean {
  const target = compact(notice);
  for (const source of [draft.body, draft.hint, draft.question]) {
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
 * 층 2 판정. 세 가지로만 끝난다 (types.ts `ClassifierOutcome`).
 *
 * **캐시**: 05-api §1의 "동일 `contentHash`는 캐시 재사용"은 v0에서 구현하지 않는다.
 * 저장 위치가 없다 — README 「DB 접근」이 프로세스 로컬 캐시를 금지하고(서버리스라
 * 인스턴스 간에 공유되지 않는다), 04는 쓰지 않을 테이블을 미리 두지 않는다. 그리고 같은
 * 내용이 두 번 판정되는 경로가 v0에는 사실상 없다: 인터스티셜 재제출은 `confirmation`
 * 토큰이 **등급 재판정 자체를 건너뛰게** 만든다(05-api §1 5단계). 재판정이 실제로 관측되면
 * 그때 저장 위치를 정한다.
 */
export async function classify(draft: LetterDraft): Promise<ClassifierOutcome> {
  try {
    // 상한에 닿으면 등급 판정이 **마지막으로** 꺼진다 (budget.ts RESERVE_FRACTION).
    if (!(await checkBudget("grade"))) {
      return { state: "unavailable", reason: "budget_exceeded" };
    }

    const result = await callWithRetry({
      instructions: CLASSIFY_INSTRUCTIONS,
      input: buildClassifyInput(draft),
      schema: CLASSIFY_SCHEMA,
      schemaName: "letter_risk",
      cacheKey: "postfeel-classify-v1",
      timeoutMs: TIMEOUT_MS,
      budgetMs: TOTAL_BUDGET_MS,
      attempts: MAX_ATTEMPTS,
      now: new Date(),
    });

    if (result.kind === "refusal") return { state: "refusal" };
    if (result.kind === "failure") {
      return { state: "unavailable", reason: result.reason };
    }

    const parsed = classifyPayload.safeParse(result.value);
    if (!parsed.success) {
      // 스키마 강제 출력이 지켜지지 않은 응답은 판정이 아니라 장애다 → medium 강등.
      return { state: "unavailable", reason: "schema_violation" };
    }

    const { risk, flags, notice } = parsed.data;
    if (notice === undefined || notice === null || notice.trim() === "") {
      return { state: "ok", risk, flags };
    }
    // 인용이 섞였으면 **문장을 버린다.** 판정까지 버리지는 않는다 — 등급과 flags는
    // 인터스티셜 문구와 무관하게 유효하다.
    if (quotesDraft(notice, draft)) return { state: "ok", risk, flags };
    return { state: "ok", risk, flags, notice };
  } catch (error) {
    // 여기까지 온 예외는 전부 장애다. 제출 경로에서 던지지 않는다 (D-015).
    return { state: "unavailable", reason: failureReason(error) };
  }
}

// ── 2. 표기 변형 (D-021) ────────────────────────────────────

const variantsPayload = z.object({ variants: z.array(z.string()) });

/**
 * 답의 표기 변형 3~5개 (D-021 · 05-api §1).
 *
 * **부르는 쪽이 지킬 것**: `mode='locked'`이고 편지가 **실제로 생성될 때만** 부른다.
 * `open` 모드는 답이 없고, 차단된(high) 편지에는 생성되지 않을 편지에 돈을 쓰는 것이다.
 *
 * **실패하면 빈 배열이다.** D-015의 등급 강등 경로를 태우지 않는다 — 변형이 없으면
 * `answer_hmac` 하나로 여는 이전 동작으로 떨어질 뿐이고, 편지가 안 만들어지는 쪽이 훨씬
 * 나쁘다 (05-api §1 · D-021).
 *
 * 원문 저장은 여기서 하지 않는다. HMAC 변환은 부르는 쪽 일이고, 이 함수는 **문자열
 * 배열까지만** 돌려준다 (04 「저장하지 않는 것」).
 */
export async function generateAnswerVariants(
  answer: string,
): Promise<string[]> {
  try {
    // 상한에 닿으면 **가장 먼저** 꺼진다 (05-api §1 「끄는 순서」).
    if (!(await checkBudget("variants"))) return [];

    const result = await callWithRetry({
      instructions: VARIANTS_INSTRUCTIONS,
      input: buildVariantsInput(answer),
      schema: VARIANTS_SCHEMA,
      schemaName: "answer_variants",
      cacheKey: "postfeel-variants-v1",
      timeoutMs: TIMEOUT_MS,
      budgetMs: TOTAL_BUDGET_MS,
      attempts: MAX_ATTEMPTS,
      now: new Date(),
    });

    // 거부도 빈 배열이다. 변형은 등급을 건드리지 않으므로 거부가 위험 신호로 쓰일 자리가
    // 없다 — 등급은 이미 classify()가 냈다.
    if (result.kind !== "json") return [];

    const parsed = variantsPayload.safeParse(result.value);
    if (!parsed.success) return [];

    const seen = new Set<string>([compact(answer)]);
    const variants: string[] = [];
    for (const raw of parsed.data.variants) {
      const value = raw.trim();
      const key = compact(value);
      if (value === "" || seen.has(key)) continue;
      seen.add(key);
      variants.push(value);
      if (variants.length === MAX_VARIANTS) break;
    }
    return variants;
  } catch {
    return [];
  }
}

// ── 3. 신고 큐 초안 판정 (07 §2) ────────────────────────────

export interface ReportVerdictDraft {
  /** 07 §2 판정표의 행. `reports.reason`과 같은 집합이다. */
  row: (typeof REPORT_ROWS)[number];
  /** 근거 한 줄. */
  rationale: string;
  confidence: "low" | "medium" | "high";
}

const reportVerdictPayload = z.object({
  row: z.enum(REPORT_ROWS),
  rationale: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

/**
 * 신고 접수 시 편지를 한 번 더 읽고 큐에 붙일 초안을 낸다 (07 §2).
 *
 * **판정은 사람이 한다.** 조치(삭제·복구·차단)를 돌려주지 않고, 어디에 저장할지도 정하지
 * 않는다 — 큐 화면과 저장은 운영 표면의 일이다. 07 §2가 못박은 이유: 분류기에 조치까지
 * 맡기면 D-012가 사전 검토를 기각한 근거가 조용히 무너진다.
 *
 * 실패하면 `null`이다. 초안이 없으면 운영자가 처음부터 읽을 뿐, 신고 처리 자체는 멈추지
 * 않는다.
 */
export async function draftReportVerdict(
  letter: { body: string; hint?: string; question?: string },
  reason: string,
): Promise<ReportVerdictDraft | null> {
  try {
    // 상한에 닿으면 변형 다음으로 꺼진다 (05-api §1 「끄는 순서」).
    if (!(await checkBudget("report_draft"))) return null;

    const result = await callWithRetry({
      instructions: REPORT_VERDICT_INSTRUCTIONS,
      input: buildReportVerdictInput(letter, reason),
      schema: REPORT_VERDICT_SCHEMA,
      schemaName: "report_verdict",
      cacheKey: "postfeel-report-v1",
      timeoutMs: REPORT_TIMEOUT_MS,
      budgetMs: REPORT_BUDGET_MS,
      attempts: MAX_ATTEMPTS,
      now: new Date(),
    });

    if (result.kind !== "json") return null;
    const parsed = reportVerdictPayload.safeParse(result.value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
