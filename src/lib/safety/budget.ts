// 분류기 일일 비용 상한 $5 (D-020 · 05-api §1).
//
// **저장 위치는 `app_settings`의 일자별 키다** — 코디네이터 판정. 새 테이블도 새 컬럼도
// 만들지 않는다: 04가 "쓰지 않을 컬럼을 미리 두지 않는다"고 했고, v0 볼륨(하루 1,000통
// 추정 · 월 $30)에서 키 하나에 누적하는 것으로 충분하다.
//
//   app_settings['classifier_spend:2026-08-14'] = 0.0123   (USD, jsonb 숫자)
//
// **Postgres에 둔다.** 프로세스 메모리에 두면 서버리스 인스턴스마다 카운터가 따로 늘어
// 상한이 인스턴스 수만큼 곱해진다 (D-018 · README 「DB 접근」).

import { query } from "../db";

/** D-020 가설값. */
export const DAILY_CAP_USD = 5;

/**
 * `gpt-5.6-luna` 단가 (per 1M tokens). 코디네이터가 공식 문서로 확인했다 (2026-08-14).
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 */
export const PRICING_USD_PER_MTOK = {
  input: 0.2,
  cachedInput: 0.02,
  output: 1.2,
} as const;

/**
 * 상한을 함께 쓰는 세 호출 (05-api §1 「대략의 비용」).
 *
 * - `grade`        등급 판정. 제출 경로
 * - `variants`     표기 변형 (D-021). 열람 편의
 * - `report_draft` 신고 큐 초안 (07 §2). 운영자 보조
 */
export type CallKind = "grade" | "variants" | "report_draft";

/**
 * **끄는 순서: 표기 변형 → 큐 초안 → 등급 판정** (05-api §1 명시).
 *
 * 앞의 둘은 없어도 안전 정책이 그대로다. 등급 판정이 꺼지면 그 시간대 편지가 전부
 * `medium`으로 강등되고(D-015), 재분류 잡이 훑을 대상만 쌓인다. 그래서 등급 판정을
 * 마지막까지 살린다.
 *
 * 순서를 코드로 강제하려면 임계값이 하나여선 안 된다 — 하나면 셋이 동시에 꺼져 "순서"가
 * 의미를 잃는다. 그래서 종류마다 다른 지점에서 끊는다. 비율은 **가설값**이고, 실측 후
 * 조정한다.
 */
const RESERVE_FRACTION: Record<CallKind, number> = {
  variants: 0.7,
  report_draft: 0.85,
  grade: 1.0,
};

/** 한국 서비스라 "하루"는 KST 기준이다 (가설값). 한국은 서머타임이 없어 고정 +09:00이다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function spendDayKey(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function settingsKey(now: Date): string {
  return `classifier_spend:${spendDayKey(now)}`;
}

/**
 * Responses API의 `usage`. 필드 이름은 공식 문서에서 확인했다.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * (`usage.input_tokens_details.cached_tokens`)
 */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * 실제 청구액과의 차이를 알고 쓴다: gpt-5.6 계열은 캐시 **기록**에 표준 입력의 1.25배를
 * 받는데(모델 문서), `usage`는 기록이 일어났는지를 알려주지 않는다. 그래서 이 계산은
 * 캐시 기록이 있는 요청에서 최대 25%까지 **과소** 추정한다.
 *
 * 과소 추정 쪽으로 두는 이유: 과대 추정하면 등급 판정이 실제보다 일찍 꺼지고, 그건 위
 * 「끄는 순서」가 지키려던 것과 정확히 반대 방향이다. v0 추정 볼륨이 상한의 1/5이라
 * 이 오차가 실제 문제가 되기 전에 실측이 들어온다.
 */
export function estimateCostUsd(usage: TokenUsage): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncachedInput * PRICING_USD_PER_MTOK.input +
      usage.cachedInputTokens * PRICING_USD_PER_MTOK.cachedInput +
      usage.outputTokens * PRICING_USD_PER_MTOK.output) /
    1_000_000
  );
}

/** 오늘 누적 사용액. 행이 없으면 0이다. */
export async function spentTodayUsd(now: Date = new Date()): Promise<number> {
  const { rows } = await query<{ value: string }>(
    "select value::numeric::text as value from app_settings where key = $1",
    [settingsKey(now)],
  );
  const raw = rows[0]?.value;
  return raw === undefined ? 0 : Number(raw);
}

/**
 * 실제로 쓴 금액을 누적한다. **거부·스키마 위반 응답도 토큰은 청구되므로 함께 센다.**
 *
 * upsert 한 문장이다. 읽고 더해서 쓰면 동시 요청 두 개가 서로의 증가분을 덮는다
 * (서버리스라 동시 인스턴스가 기본값이다).
 */
export async function recordSpend(
  usage: TokenUsage,
  now: Date = new Date(),
): Promise<void> {
  const cost = estimateCostUsd(usage);
  if (cost <= 0) return;
  await query(
    `insert into app_settings (key, value)
     values ($1, to_jsonb($2::numeric))
     on conflict (key) do update
       set value = to_jsonb((app_settings.value)::numeric + $2::numeric)`,
    [settingsKey(now), cost],
  );
}

export interface BudgetAlert {
  kind: CallKind;
  spentUsd: number;
  capUsd: number;
  day: string;
}

/**
 * 상한 초과 시 운영자 알림 (05-api §1 「일일 비용 상한 $5 초과 시 층 2를 건너뛰고
 * 운영자 알림」).
 *
 * **텔레그램을 여기서 구현하지 않는다.** 발송 채널은 D-019 · 09-notifications의 소관이고
 * 그 워커가 아직 없다. 지금은 인터페이스와 로그만 둔다 — 여기에 fetch를 직접 박으면
 * 발송 워커가 오는 날 채널 코드가 두 곳에 살게 된다.
 *
 * TODO(발송 워커): 텔레그램 봇으로 보낸다. 하루에 한 번만 울리게 중복을 눌러야 하고,
 *   그 중복 제거는 발송 쪽이 다른 알림과 함께 다룰 문제다.
 */
export function notifyOperatorBudgetExceeded(alert: BudgetAlert): void {
  console.warn(
    `[classifier] 일일 비용 상한 도달 — ${alert.kind} 호출을 건너뛴다. ` +
      `${alert.day}: $${alert.spentUsd.toFixed(4)} / $${alert.capUsd}`,
  );
}

/**
 * 예산 관문. 통과하면 `true`, 막히면 알림을 남기고 `false`.
 *
 * 아직 하지 않은 호출의 비용은 예측하지 않는다 — 편지마다 길이가 달라 예측이 빗나가고,
 * v0에서 한 호출은 약 $0.001이라 상한을 한 번 넘겨도 초과분이 무시할 수준이다.
 *
 * 세 호출 지점이 같은 문장을 반복하지 않도록 한 자리에 둔다 — 반복되면 한 곳만 고쳐지고
 * 나머지가 남는다.
 */
export async function checkBudget(
  kind: CallKind,
  now: Date = new Date(),
): Promise<boolean> {
  const spent = await spentTodayUsd(now);
  if (spent < DAILY_CAP_USD * RESERVE_FRACTION[kind]) return true;
  notifyOperatorBudgetExceeded({
    kind,
    spentUsd: spent,
    capUsd: DAILY_CAP_USD,
    day: spendDayKey(now),
  });
  return false;
}
