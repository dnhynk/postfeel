// 분류기 평가셋 러너 — 08-milestones.md 「"분류기 동작"의 합격 기준」.
//
//   npm run eval
//
// ── 무엇을 재는가 ───────────────────────────────────────────
// **층 1 + 층 2 파이프라인 전체다.** 게이트가 판정할 질문은 "luna가 잘하나"가 아니라
// "이 시스템이 저격을 거르나"이기 때문에, 제출 경로가 쓰는 것과 같은 함수를 그대로
// 부른다 — `runLayer1` → `classify` → `grade`. 판정 규칙을 여기서 다시 구현하지 않는다.
// 다시 구현하면 재는 대상이 파이프라인이 아니라 그 복제본이 된다.
//
// **"탐지"는 판정 등급이 `medium` 이상인 것이다.** 오탐도 같은 기준 — 정상 편지가
// `medium` 이상을 받으면 오탐이다. 등급은 셋인데 라벨은 이진이라 이 정의가 없으면
// 재현율이 계산되지 않는다 (08).
//
// ── 층별로 나눠 집계하는 이유 ───────────────────────────────
// 묶어서 한 숫자만 보면 층 1의 정규식이 연락처·URL을 쓸어담아 재현율을 밀어올리고,
// **한국어 인명·맥락을 못 잡는 모델도 0.8을 넘긴다** (08 · D-020). 그래서 탐지된 건을
// 층 1 / 층 2로 가르고, 놓친 건을 따로 센다.
//
// 가르는 방법: 같은 편지를 두 번 판정한다.
//   · 층 1 단독   `grade(layer1, {state:'ok', risk:'low', flags:[]})`
//                 — 중립 분류기 결과를 넣어 층 1 신호만 남긴다. D-016의 칸 규칙이
//                   grade.ts 안에 있으므로 여기서 직접 계산하면 규칙이 두 곳이 된다
//   · 전체       `grade(layer1, classify(draft))`
// 층 1 단독이 이미 `medium` 이상이면 층 1이 잡은 것이고, 아니면서 전체가 `medium`
// 이상이면 층 2가 잡은 것이다.
//
// **`unavailable`은 세 번째 칸으로 뺀다.** D-015의 강등 경로는 분류기가 죽었을 때
// 편지를 `medium`으로 만들어 통과시키는 장치라, 그대로 세면 장애가 곧 만점 재현율이
// 된다(모든 편지가 `medium`이 되므로 재현율 1.0 · 오탐율 1.0). 그건 탐지력이 아니다.
//
// ── 배치로 돌리지 않는 이유 ─────────────────────────────────
// 08은 "배치로 돌린다 — 제출 경로가 아니라 지연이 무관하고 단가가 절반이다"라고 적었다.
// OpenAI Batch API를 공식 문서로 확인했다 (2026-08-15):
//   https://developers.openai.com/api/docs/guides/batch
//   · "50% cost discount compared to synchronous APIs" — 단가 절반은 사실이다
//   · "Each batch completes within 24 hours" — 지연도 무관하다
//   · 입력은 **`.jsonl` 한 줄에 요청 하나**다. 각 줄이 `custom_id` + 메서드 +
//     엔드포인트 URL + 그 엔드포인트의 요청 본문 전체를 담는다
//
// 세 번째 줄이 걸린다. 배치를 쓰려면 **프롬프트와 JSON 스키마를 이 파일이 직접
// 조립해야 한다.** 그 둘은 `src/lib/safety/classifier.ts`(S2 워커 소유)에 사는 값이고,
// 여기에 복제하면 두 가지가 동시에 깨진다 — ① 재는 대상이 배포되는 분류기가 아니라
// 평가셋 안의 사본이 된다(위 「무엇을 재는가」와 정면으로 어긋난다), ② 사본은 반드시
// 원본과 갈라지고 갈라진 뒤에도 숫자는 계속 나온다.
//
// 그래서 **`classify()`를 그대로 부르되 동시에 부른다.** 50건이라 절약되는 절대액이
// 작고(현재는 층 2가 스텁이라 호출 자체가 0건), 재는 대상이 흐려지는 비용이 훨씬 크다.
// 층 2가 배치 진입점을 노출하면 그때 이 자리를 바꾼다 — 아래 CONCURRENCY 주석 참조.

import { spentTodayUsd } from "@/lib/safety/budget";
import { classify } from "@/lib/safety/classifier";
import { grade } from "@/lib/safety/grade";
import { runLayer1 } from "@/lib/safety/layer1";
import type { Decision } from "@/lib/safety/grade";
import type { ClassifierOutcome, RiskLevel } from "@/lib/safety/types";
import { CASES } from "./dataset.ts";
import type { EvalCase, RiskType } from "./dataset.ts";

// ── 임계값 (08의 가설값) ────────────────────────────────────

const RECALL_MIN = 0.8;
const FALSE_POSITIVE_MAX = 0.2;

/**
 * `classify()`를 동시에 부르는 개수. 층 2가 붙으면 05-api §1의 일일 상한과 레이트리밋을
 * 함께 본다. 지금은 스텁이라 네트워크가 없어서 값과 무관하게 즉시 끝난다.
 */
const CONCURRENCY = 6;

/** 층 1 단독 판정을 뽑을 때 넣는 중립 분류기 결과. 층 2 신호를 0으로 만든다. */
const NEUTRAL: ClassifierOutcome = { state: "ok", risk: "low", flags: [] };

/** classifier.ts 스텁이 돌려주는 값. 이게 나오면 층 2가 아직 없는 것이다. */
const STUB_REASON = "not_implemented";

// ── 판정 ───────────────────────────────────────────────────

type Attribution = "layer1" | "layer2" | "degraded" | "missed";

interface Outcome {
  case: EvalCase;
  classifier: ClassifierOutcome;
  layer1Only: Decision;
  full: Decision;
  detectedByLayer1: boolean;
  detected: boolean;
  attribution: Attribution;
  /**
   * `classify()` 한 건의 왕복 시간. 08의 등급 절차가 "effort를 올려 재측정"으로 가면
   * 그 다음 질문이 **제출 경로 3초 예산에 들어가는가**이고, 그건 전체 소요 시간으로는
   * 답이 안 나온다 (CONCURRENCY로 나뉘기 때문이다).
   *
   * 동시 6건이 붙은 상태의 값이라 순차 측정보다 조금 부풀 수 있다. 판정에는 쓰지 않는다 —
   * 게이트 임계값은 재현율·오탐율 둘뿐이다.
   */
  classifyMs: number;
}

/** 08: "탐지는 판정 등급이 `medium` 이상인 것이다." */
function isDetected(risk: RiskLevel): boolean {
  return risk === "medium" || risk === "high";
}

function isStub(outcome: ClassifierOutcome): boolean {
  return outcome.state === "unavailable" && outcome.reason === STUB_REASON;
}

async function evaluate(item: EvalCase, layer2Missing: boolean): Promise<Outcome> {
  const layer1 = runLayer1(item.draft);
  const calledAt = Date.now();
  const classifier = await classify(item.draft);
  const classifyMs = Date.now() - calledAt;

  // 층 2가 없으면 그 자리를 중립으로 두고 **층 1만으로** 돌린다. 스텁의 `unavailable`을
  // 그대로 먹이면 grade가 D-015 강등을 태워 50건 전부 `medium`이 되고, 재현율 1.0 ·
  // 오탐율 1.0이라는 무의미한 숫자가 나온다.
  const effective = layer2Missing ? NEUTRAL : classifier;

  const layer1Only = grade(layer1, NEUTRAL);
  const full = grade(layer1, effective);

  const detectedByLayer1 = isDetected(layer1Only.risk);
  const detected = isDetected(full.risk);

  let attribution: Attribution;
  if (detectedByLayer1) attribution = "layer1";
  else if (!detected) attribution = "missed";
  else if (classifier.state === "unavailable") attribution = "degraded";
  else attribution = "layer2";

  return {
    case: item,
    classifier,
    layer1Only,
    full,
    detectedByLayer1,
    detected,
    attribution,
    classifyMs,
  };
}

/** 나눗셈 없이 정렬된 배열에서 백분위 하나를 집는다. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

/** 순서를 보존하면서 동시에 돌린다 — 출력이 실행마다 같아야 비교가 된다. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

// ── 출력 ───────────────────────────────────────────────────
//
// 한글은 터미널에서 두 칸을 차지한다. `padEnd`는 코드 유닛을 세므로 표가 어긋난다.

function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    total += wide ? 2 : 1;
  }
  return total;
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

function ratio(part: number, whole: number): string {
  return whole === 0 ? "—" : (part / whole).toFixed(2);
}

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const TYPE_LABELS: Record<RiskType, string> = {
  person_name: "인명",
  school: "학교",
  company: "회사",
  contact: "연락처",
  url: "URL",
  combo: "조합",
  sensitive: "민감",
};

const TYPE_ORDER: readonly RiskType[] = [
  "person_name",
  "school",
  "company",
  "contact",
  "url",
  "combo",
  "sensitive",
];

// ── 비용 ───────────────────────────────────────────────────
//
// 08의 게이트 보고에 "실제 비용"이 들어간다. 여기서 다시 계산하지 않고 **분류기가 이미
// 적어둔 값을 읽는다** — `classifier.ts`가 호출마다 `recordSpend()`로 `app_settings`의
// 일자 키에 누적하므로(budget.ts), 실행 전후의 차이가 이번 실행의 비용이다. 토큰 사용량을
// 여기서 따로 세면 단가표가 두 곳에 살게 되고, 그건 이 파일이 판정 규칙을 다시 구현하지
// 않는 것과 같은 이유로 하지 않는다.
//
// **알고 쓰는 오차 둘.** ① `estimateCostUsd`는 캐시 **기록**분을 모르므로 최대 25%까지
// 과소 추정한다(budget.ts 주석). ② 같은 DB를 향해 다른 프로세스가 동시에 분류기를 부르면
// 그만큼 섞인다. 로컬 평가 실행에서는 둘 다 관측 범위를 적어두는 것으로 충분하다.
//
// DB가 없으면 `undefined`다. 층 2가 스텁이던 시절 이 러너는 DB 없이 돌았고, 비용 한 줄
// 때문에 그 성질을 깨뜨리지 않는다.
async function spendSnapshot(now: Date): Promise<number | undefined> {
  try {
    return await spentTodayUsd(now);
  } catch {
    return undefined;
  }
}

// ── 본체 ───────────────────────────────────────────────────

async function main(): Promise<void> {
  // 날짜 키를 한 번 고정해서 전후 스냅샷이 같은 키를 읽게 한다. 실행이 KST 자정을
  // 넘겨도 차이가 엉키지 않는다.
  const spendClock = new Date();
  const spentBefore = await spendSnapshot(spendClock);

  // 층 2의 존재 여부를 먼저 한 번 물어본다. 스텁이면 50건 전부 같은 답이 오므로
  // 대표 한 건으로 충분하고, 이 판단이 아래 전체 판정 방식을 가른다.
  const probe = await classify(CASES[0].draft);
  const layer2Missing = isStub(probe);

  const started = Date.now();
  const outcomes = await mapWithConcurrency(CASES, CONCURRENCY, (item) =>
    evaluate(item, layer2Missing),
  );
  const elapsedMs = Date.now() - started;

  const spentAfter = await spendSnapshot(spendClock);
  const costUsd =
    spentBefore === undefined || spentAfter === undefined
      ? undefined
      : spentAfter - spentBefore;

  const risk = outcomes.filter((o) => o.case.label === "risk");
  const normal = outcomes.filter((o) => o.case.label === "normal");

  const detectedRisk = risk.filter((o) => o.detected);
  const falsePositives = normal.filter((o) => o.detected);

  const recall = detectedRisk.length / risk.length;
  const falsePositiveRate = falsePositives.length / normal.length;

  const recallPass = recall >= RECALL_MIN;
  const fpPass = falsePositiveRate <= FALSE_POSITIVE_MAX;

  out();
  out("═══ 분류기 평가셋 ═══════════════════════════════════════════");
  out(
    `  ${CASES.length}건 · 위험 ${risk.length} / 정상 ${normal.length}` +
      `   (${elapsedMs}ms)`,
  );
  out("  데이터셋: eval/dataset.ts — **코디네이터/사용자 검토 대기**");
  out();

  // ── 층 2 상태 ─────────────────────────────────────────────
  out("── 층 2 상태 ───────────────────────────────────────────────");
  if (layer2Missing) {
    out("  미구현 — src/lib/safety/classifier.ts가 스텁이다.");
    out(`           classify() → { state: 'unavailable', reason: '${STUB_REASON}' }`);
    out("  층 1만으로 돌렸다. 분류기 호출 0건 · 비용 $0.");
    out("  **게이트 판정 불가**: 08의 임계값은 층 1 + 층 2 전체 수치에 대한 것이다.");
  } else {
    const unavailable = outcomes.filter(
      (o) => o.classifier.state === "unavailable",
    ).length;
    const refusal = outcomes.filter((o) => o.classifier.state === "refusal").length;
    // 프로브 1건은 위 층 2 존재 확인용 호출이다. 판정 집계에는 들어가지 않지만
    // **토큰은 청구되므로** 호출 수와 비용에는 들어간다.
    out(`  구현됨 — 분류기 호출 ${outcomes.length + 1}건 (판정 ${outcomes.length} + 프로브 1).`);
    out(`  ok ${outcomes.length - unavailable - refusal} · refusal ${refusal} · unavailable ${unavailable}`);
    if (costUsd !== undefined) {
      out(
        `  비용 $${costUsd.toFixed(4)} · 소요 ${(elapsedMs / 1000).toFixed(1)}s` +
          `   (비용은 budget.ts estimateCostUsd 기준 — 캐시 기록분 최대 25% 과소)`,
      );
    } else {
      out("  비용 — DB를 읽지 못해 누적액을 대조하지 못했다.");
    }
    // 한 건의 왕복 시간. 제출 경로의 3초 예산(classifier.ts TIMEOUT_MS)과 비교할 값이라
    // 전체 소요 시간과 따로 찍는다 — 전체는 CONCURRENCY로 나뉘어 있어 예산과 무관하다.
    const latencies = outcomes.map((o) => o.classifyMs).sort((a, b) => a - b);
    out(
      `  classify() 왕복  p50 ${percentile(latencies, 0.5)}ms` +
        ` · p95 ${percentile(latencies, 0.95)}ms` +
        ` · 최대 ${latencies[latencies.length - 1]}ms   (동시 ${CONCURRENCY}건)`,
    );
    if (unavailable > 0) {
      out("  ⚠ unavailable 건은 D-015 강등으로 medium이 된다. 탐지가 아니다 —");
      out("    아래 층별 집계에서 `강등` 칸으로 따로 센다.");
    }
  }
  out();

  // ── 게이트 수치 ───────────────────────────────────────────
  out("── 게이트 수치 (전체 파이프라인) ───────────────────────────");
  out(
    `  위험 재현율   ${ratio(detectedRisk.length, risk.length)}` +
      `  (${detectedRisk.length}/${risk.length})` +
      `   임계값 ≥ ${RECALL_MIN.toFixed(2)}   ${recallPass ? "통과" : "미달"}`,
  );
  out(
    `  정상 오탐율   ${ratio(falsePositives.length, normal.length)}` +
      `  (${falsePositives.length}/${normal.length})` +
      `   임계값 ≤ ${FALSE_POSITIVE_MAX.toFixed(2)}   ${fpPass ? "통과" : "초과"}`,
  );
  out();
  if (layer2Missing) {
    out("  판정: **불가** — 층 2 미구현. 위 재현율은 층 1의 상한이지 시스템의 값이 아니다.");
  } else if (recallPass && fpPass) {
    out("  판정: 합격");
  } else {
    out("  판정: 불합격 — 08의 모델 등급 절차(effort 상향 → terra)로 넘어간다.");
  }
  out();

  // ── 층별 집계 ─────────────────────────────────────────────
  const byAttribution = (list: readonly Outcome[], value: Attribution): number =>
    list.filter((o) => o.attribution === value).length;

  const layer2Cell = (count: number): string =>
    layer2Missing ? "미구현" : String(count);

  // 건수는 데이터셋에서 읽는다 — 여기 숫자를 박아 두면 데이터셋이 늘어난 날 표 제목만
  // 옛날 수를 말한다 (D-033으로 실제로 늘었다).
  out(`── 층별 집계 · 위험 ${risk.length}건 ───────────────────────────────────`);
  out(`  탐지된 건   ${padLeft(String(detectedRisk.length), 2)}`);
  out(`    층 1이 잡음   ${padLeft(String(byAttribution(risk, "layer1")), 2)}`);
  out(`    층 2가 잡음   ${padLeft(layer2Cell(byAttribution(risk, "layer2")), 2)}`);
  if (byAttribution(risk, "degraded") > 0) {
    out(`    강등(장애)    ${padLeft(String(byAttribution(risk, "degraded")), 2)}   ← 탐지가 아니다`);
  }
  out(`  놓친 건     ${padLeft(String(risk.length - detectedRisk.length), 2)}`);
  out(`    둘 다 놓침    ${padLeft(String(byAttribution(risk, "missed")), 2)}`);
  out();

  out(`── 층별 집계 · 정상 ${normal.length}건 (오탐) ────────────────────────────`);
  out(`  오탐        ${padLeft(String(falsePositives.length), 2)}`);
  out(`    층 1 오탐     ${padLeft(String(byAttribution(normal, "layer1")), 2)}`);
  out(`    층 2 오탐     ${padLeft(layer2Cell(byAttribution(normal, "layer2")), 2)}`);
  if (byAttribution(normal, "degraded") > 0) {
    out(`    강등(장애)    ${padLeft(String(byAttribution(normal, "degraded")), 2)}`);
  }
  out();

  // ── 유형 분포 ─────────────────────────────────────────────
  out("── 위험 유형별 ─────────────────────────────────────────────");
  out(
    `  ${padRight("유형", 8)}${padLeft("건수", 6)}${padLeft("탐지", 6)}` +
      `${padLeft("층1", 6)}${padLeft("층2", 8)}${padLeft("놓침", 6)}`,
  );
  for (const type of TYPE_ORDER) {
    const group = risk.filter((o) => o.case.type === type);
    if (group.length === 0) continue;
    out(
      `  ${padRight(TYPE_LABELS[type], 8)}` +
        `${padLeft(String(group.length), 6)}` +
        `${padLeft(String(group.filter((o) => o.detected).length), 6)}` +
        `${padLeft(String(byAttribution(group, "layer1")), 6)}` +
        `${padLeft(layer2Cell(byAttribution(group, "layer2")), 8)}` +
        `${padLeft(String(byAttribution(group, "missed")), 6)}`,
    );
  }
  out();

  // ── 라벨 대조 ─────────────────────────────────────────────
  //
  // `layer1Catchable`은 기대값이다. 실측과 어긋나면 라벨이 틀렸거나 층 1에 구멍이 있다.
  const mismatches = outcomes.filter(
    (o) => o.case.layer1Catchable !== o.detectedByLayer1,
  );
  out("── 라벨 대조 (layer1Catchable ↔ 층 1 실측) ──────────────────");
  if (mismatches.length === 0) {
    out(`  어긋난 건 없음. ${outcomes.length}/${outcomes.length} 일치.`);
  } else {
    for (const o of mismatches) {
      out(
        `  ${o.case.id}  기대 ${o.case.layer1Catchable ? "잡음" : "못잡음"}` +
          ` → 실측 ${o.detectedByLayer1 ? "잡음" : "못잡음"}  ${o.case.note}`,
      );
    }
  }
  out();

  // ── 놓친 건 ───────────────────────────────────────────────
  const missed = risk.filter((o) => !o.detected);
  out("── 놓친 위험 건 ────────────────────────────────────────────");
  if (missed.length === 0) {
    out("  없음.");
  } else {
    for (const o of missed) {
      const type = o.case.type === undefined ? "—" : TYPE_LABELS[o.case.type];
      out(`  ${o.case.id}  ${padRight(type, 8)}${o.case.note}`);
    }
  }
  out();

  // ── 오탐 건 ───────────────────────────────────────────────
  out("── 오탐 정상 건 ────────────────────────────────────────────");
  if (falsePositives.length === 0) {
    out("  없음.");
  } else {
    for (const o of falsePositives) {
      const kinds = o.full.flags.map((f) => `${f.kind}@${f.field}`).join(" ");
      out(`  ${o.case.id}  ${o.full.risk}  ${kinds}`);
      out(`        ${o.case.probes ?? o.case.note}`);
    }
  }
  out();
  out("════════════════════════════════════════════════════════════");
  out();

  // 게이트를 막는 건 전체 수치 하나다 (08). 판정 불가면 실패로 만들지 않는다 —
  // 층 2가 없다는 사실은 이미 위에 적혔고, 여기서 1을 내면 "층 2 미구현"과
  // "모델이 미달"이 같은 신호가 된다.
  if (!layer2Missing && !(recallPass && fpPass)) {
    process.exitCode = 1;
  }
}

await main();
