// src/lib/safety/classifier.ts — classify() (05-api §1 · D-015 · D-020)
//
// 실제 API를 부르지 않는다. 스텁은 `fetch`에 있고 openai SDK는 진짜를 쓴다
// (tests/lib/classifier/fake-openai.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { spendDayKey } from "@/lib/safety/budget";
import type { LetterDraft } from "@/lib/safety/types";
import {
  abortError,
  hang,
  incomplete,
  networkError,
  refusal,
  slowNetworkError,
  structured,
  stubFetch,
} from "./fake-openai";
import { loadClassifier } from "./load";

/**
 * `classifier.ts`의 `TOTAL_BUDGET_MS`. 모듈이 내보내지 않으므로 값을 여기 적는다 —
 * 상수가 조용히 움직이면 이 테스트가 먼저 깨지는 쪽이 낫다.
 */
const TOTAL_BUDGET_MS = 4_000;

/** 러너가 밀릴 때를 위한 여유. 옛 동작(3+1+3 ≈ 7초)은 이 여유를 줘도 넘는다. */
const SLACK_MS = 1_000;

const draft: LetterDraft = {
  mode: "locked",
  relationship: "ex",
  body: "그때 우리가 자주 가던 골목의 국숫집을 아직도 지나치지 못한다.",
  hint: "2019년 신촌에서 파란 머리",
  question: "우리가 마지막으로 먹은 것",
  answer: "국수",
};

let classify: typeof import("@/lib/safety/classifier").classify;

beforeEach(async () => {
  ({ classify } = await loadClassifier());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await query("delete from app_settings where key like 'classifier_spend:%'");
});

describe("classify · 정상 판정", () => {
  it("스키마대로 온 응답을 { state: 'ok' }로 돌려준다", async () => {
    stubFetch([
      () =>
        structured({
          risk: "medium",
          flags: [{ kind: "place_time_combo", field: "hint" }],
          notice: "단서에 시기와 장소가 함께 있어 다른 사람도 대상을 좁힐 수 있습니다.",
        }),
    ]);

    expect(await classify(draft)).toEqual({
      state: "ok",
      risk: "medium",
      flags: [{ kind: "place_time_combo", field: "hint" }],
      notice:
        "단서에 시기와 장소가 함께 있어 다른 사람도 대상을 좁힐 수 있습니다.",
    });
  });

  it("flags의 field를 body·hint·question 세 칸 그대로 보존한다", async () => {
    // D-016 · 코디네이터 결정(2026-08-14) — question은 hint와 동급 high다. 등급은
    // grade.ts가 매기지만, field가 뭉개지면 그 규칙 전체가 무의미해진다.
    stubFetch([
      () =>
        structured({
          risk: "high",
          flags: [
            { kind: "school", field: "body" },
            { kind: "school", field: "hint" },
            { kind: "company", field: "question" },
          ],
          notice: "학교와 회사로 보이는 표현이 있습니다.",
        }),
    ]);

    const outcome = await classify(draft);
    expect(outcome.state).toBe("ok");
    expect(outcome.state === "ok" && outcome.flags).toEqual([
      { kind: "school", field: "body" },
      { kind: "school", field: "hint" },
      { kind: "company", field: "question" },
    ]);
  });

  it("notice가 null이면 필드를 붙이지 않는다", async () => {
    stubFetch([() => structured({ risk: "low", flags: [], notice: null })]);
    expect(await classify(draft)).toEqual({
      state: "ok",
      risk: "low",
      flags: [],
    });
  });
});

describe("classify · 거부는 장애가 아니다 (05-api §1 · D-020)", () => {
  it("refusal 응답은 { state: 'refusal' }다 — unavailable로 흘리지 않는다", async () => {
    stubFetch([() => refusal()]);
    expect(await classify(draft)).toEqual({ state: "refusal" });
  });

  it("거부는 재시도하지 않는다 — 판정 결과이지 실패가 아니다", async () => {
    const stub = stubFetch([() => refusal()]);
    await classify(draft);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("classify · 장애는 unavailable (D-015)", () => {
  it("타임아웃이면 { state: 'unavailable', reason: 'timeout' }이다", async () => {
    stubFetch([abortError]);
    expect(await classify(draft)).toEqual({
      state: "unavailable",
      reason: "timeout",
    });
  });

  it("네트워크 오류면 unavailable이다", async () => {
    stubFetch([networkError]);
    const outcome = await classify(draft);
    expect(outcome.state).toBe("unavailable");
  });

  it("스키마 위반 응답은 unavailable이다 — 판정이 아니라 장애다", async () => {
    stubFetch([() => structured({ risk: "critical", flags: [] })]);
    expect(await classify(draft)).toEqual({
      state: "unavailable",
      reason: "schema_violation",
    });
  });

  it("types.ts에 없는 kind가 섞이면 스키마 위반이다", async () => {
    // 분류기 스키마와 types.ts가 어긋나면 risk_flags가 조용히 오염된다.
    stubFetch([
      () =>
        structured({
          risk: "medium",
          flags: [{ kind: "astrological_sign", field: "body" }],
          notice: null,
        }),
    ]);
    expect(await classify(draft)).toEqual({
      state: "unavailable",
      reason: "schema_violation",
    });
  });

  it("max_output_tokens에 걸린 incomplete 응답은 unavailable이다", async () => {
    stubFetch([incomplete]);
    expect(await classify(draft)).toEqual({
      state: "unavailable",
      reason: "incomplete",
    });
  });
});

describe("classify · 재시도는 타임아웃을 뺀다 (코디네이터 판정 2026-08-15)", () => {
  it("타임아웃은 재시도하지 않는다 — 호출이 한 번만 나가고 unavailable이다", async () => {
    // 3초를 다 태운 뒤의 재시도는 대개 또 타임아웃이다. 재시도가 실제로 값을 만드는 것은
    // 빠르게 끝나는 실패(연결 거부·5xx·일시적 네트워크 오류)다. 그리고 7초(3+1+3) 제출은
    // 05-api §1이 스스로 정한 "3초 이상은 고장으로 인식된다"를 넘는다.
    const stub = stubFetch([abortError]);
    expect(await classify(draft)).toEqual({
      state: "unavailable",
      reason: "timeout",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("타임아웃이 아닌 실패는 1회 재시도한다 — 호출이 두 번 나간다", async () => {
    const stub = stubFetch([networkError]);
    await classify(draft);
    expect(stub.calls).toHaveLength(2);
  });

  it("재시도가 성공하면 그 판정을 쓴다", async () => {
    stubFetch([
      networkError,
      () => structured({ risk: "low", flags: [], notice: null }),
    ]);
    expect(await classify(draft)).toEqual({
      state: "ok",
      risk: "low",
      flags: [],
    });
  });
});

describe("classify · 총 예산 4초를 어떤 경로로도 넘지 않는다", () => {
  // 위 테스트들이 SDK의 오류 **매핑**만 보는 것과 달리, 이 셋은 시계를 실제로 쓴다.

  it("타임아웃 한 번으로 끝난다 — 재시도가 붙지 않아 3초다", async () => {
    const stub = stubFetch([hang]);
    const started = Date.now();
    const outcome = await classify(draft);
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ state: "unavailable", reason: "timeout" });
    expect(stub.calls).toHaveLength(1);
    // 3초를 실제로 기다린다 — 응답하지 않는 서버를 즉시 포기하는 것이 아니다.
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThan(TOTAL_BUDGET_MS + SLACK_MS);
  });

  it("빠른 실패 → 1초 대기 → 타임아웃이 최악이고, 그래도 예산 안이다", async () => {
    const stub = stubFetch([networkError, hang]);
    const started = Date.now();
    const outcome = await classify(draft);
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ state: "unavailable", reason: "timeout" });
    expect(stub.calls).toHaveLength(2);
    expect(elapsed).toBeLessThan(TOTAL_BUDGET_MS + SLACK_MS);
  });

  it("느린 실패 뒤의 재시도는 남은 예산만큼으로 잘린다", async () => {
    // 2초를 쓰고 실패 → 1초 대기 → 남은 예산은 1초다. 2회차가 3초 타임아웃을 그대로
    // 쓰면 총 6초가 된다. 예산이 상수 산수가 아니라 시계로 자르는지 본다.
    const stub = stubFetch([slowNetworkError(2_000), hang]);
    const started = Date.now();
    const outcome = await classify(draft);
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ state: "unavailable", reason: "timeout" });
    expect(stub.calls).toHaveLength(2);
    expect(elapsed).toBeLessThan(TOTAL_BUDGET_MS + SLACK_MS);
  });
});

describe("classify · 비용 상한 (D-020 $5)", () => {
  it("상한에 닿으면 호출하지 않고 unavailable이다", async () => {
    await query(
      "insert into app_settings (key, value) values ($1, to_jsonb(5.0::numeric))",
      [`classifier_spend:${spendDayKey(new Date())}`],
    );
    const stub = stubFetch([
      () => structured({ risk: "low", flags: [], notice: null }),
    ]);

    expect(await classify(draft)).toEqual({
      state: "unavailable",
      reason: "budget_exceeded",
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("등급 판정은 상한의 100%까지 살아 있다 — 마지막까지 꺼지지 않는다", async () => {
    // 05-api §1 「끄는 순서: 표기 변형 → 큐 초안 → 등급 판정」.
    await query(
      "insert into app_settings (key, value) values ($1, to_jsonb(4.9::numeric))",
      [`classifier_spend:${spendDayKey(new Date())}`],
    );
    stubFetch([() => structured({ risk: "low", flags: [], notice: null })]);
    expect((await classify(draft)).state).toBe("ok");
  });
});

describe("classify · notice는 본문을 인용하지 않는다 (05-api §1)", () => {
  it("본문 구절이 섞인 notice는 버리고 판정은 남긴다", async () => {
    stubFetch([
      () =>
        structured({
          risk: "medium",
          flags: [{ kind: "person_name", field: "body" }],
          notice: "'자주 가던 골목의 국숫집'이라는 표현이 대상을 좁힙니다.",
        }),
    ]);

    expect(await classify(draft)).toEqual({
      state: "ok",
      risk: "medium",
      flags: [{ kind: "person_name", field: "body" }],
    });
  });

  it("단서를 옮긴 notice도 버린다", async () => {
    stubFetch([
      () =>
        structured({
          risk: "high",
          flags: [{ kind: "place_time_combo", field: "hint" }],
          notice: "단서의 2019년 신촌에서 파란 머리가 대상을 특정합니다.",
        }),
    ]);
    const outcome = await classify(draft);
    expect(outcome.state === "ok" && outcome.notice).toBeUndefined();
  });

  it("띄어쓰기만 바꿔 옮긴 인용도 잡는다", async () => {
    stubFetch([
      () =>
        structured({
          risk: "medium",
          flags: [],
          notice: "자주가던골목의국숫집 이라고 쓰셨습니다.",
        }),
    ]);
    const outcome = await classify(draft);
    expect(outcome.state === "ok" && outcome.notice).toBeUndefined();
  });

  it("인용이 없으면 notice를 그대로 돌려준다", async () => {
    stubFetch([
      () =>
        structured({
          risk: "medium",
          flags: [{ kind: "school", field: "body" }],
          notice: "본문에 학교 이름으로 보이는 표현이 있습니다.",
        }),
    ]);
    const outcome = await classify(draft);
    expect(outcome.state === "ok" && outcome.notice).toBe(
      "본문에 학교 이름으로 보이는 표현이 있습니다.",
    );
  });
});

describe("classify · 요청 형태", () => {
  it("Responses API에 스키마 강제 출력과 effort를 실어 보낸다", async () => {
    const stub = stubFetch([
      () => structured({ risk: "low", flags: [], notice: null }),
    ]);
    await classify(draft);

    const body = stub.calls[0] as {
      model: string;
      reasoning: { effort: string };
      text: { format: { type: string; strict: boolean; schema: unknown } };
      store: boolean;
    };
    expect(body.model).toBe("gpt-5.6-luna");
    // D-020 — 기본값 medium으로 두면 3초 예산을 넘긴다.
    expect(["none", "low"]).toContain(body.reasoning.effort);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
    // 편지 본문을 벤더 쪽에 남기지 않는다.
    expect(body.store).toBe(false);
  });

  it("열쇠 정답을 프롬프트에 넣지 않는다", async () => {
    const stub = stubFetch([
      () => structured({ risk: "low", flags: [], notice: null }),
    ]);
    await classify(draft);
    expect(JSON.stringify(stub.calls[0])).not.toContain("국수");
  });

  it("프롬프트 접두사가 편지마다 같다 — 타임스탬프·요청 ID가 섞이지 않는다", async () => {
    // 05-api §1 「프롬프트 캐싱」. v0에서 캐시가 거의 안 걸리더라도 접두사는 고정해 둔다.
    const stub = stubFetch([
      () => structured({ risk: "low", flags: [], notice: null }),
    ]);
    await classify(draft);
    await classify({ ...draft, body: "완전히 다른 본문이다." });

    const first = stub.calls[0] as { instructions: string };
    const second = stub.calls[1] as { instructions: string };
    expect(first.instructions).toBe(second.instructions);
    expect(first.instructions.length).toBeGreaterThan(0);
  });
});
