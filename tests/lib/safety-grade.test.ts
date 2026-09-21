// src/lib/safety/grade.ts — 규칙 5개. 각 규칙마다 테스트 하나.
//
// 여기가 깨지면 안전 회귀 테스트 12·13·22가 같이 깨진다. 그쪽은 HTTP 표면이고
// 여기는 순수 함수다.

import { describe, expect, it } from "vitest";
import { grade } from "@/lib/safety/grade";
import type { ClassifierOutcome, Flag, Layer1Result } from "@/lib/safety/types";

const clean: Layer1Result = { risk: "low", flags: [] };
const ok = (
  risk: "low" | "medium" | "high",
  flags: Flag[] = [],
): ClassifierOutcome => ({ state: "ok", risk, flags });

describe("규칙 1 · 층 1이 high면 분류기 상태와 무관하게 차단 (05-api §1 · 안전 테스트 13)", () => {
  const layer1: Layer1Result = {
    risk: "high",
    flags: [{ kind: "threat", field: "body" }],
  };

  it("분류기가 low를 줘도 차단이다", () => {
    expect(grade(layer1, ok("low")).action).toBe("block");
  });

  it("분류기가 죽어도 medium으로 강등되지 않는다", () => {
    const decision = grade(layer1, { state: "unavailable", reason: "timeout" });
    expect(decision.action).toBe("block");
    expect(decision.risk).toBe("high");
  });
});

describe("규칙 2 · 분류기 refusal → high (D-020 · 안전 테스트 22)", () => {
  it("medium 강등 경로로 흘리지 않는다", () => {
    const decision = grade(clean, { state: "refusal" });
    expect(decision.action).toBe("block");
    expect(decision.risk).toBe("high");
    // 강등이었다면 편지가 생성된다. S-4·S-5는 게시되면 안 되는 카테고리다.
    expect(decision.action).not.toBe("create");
  });
});

describe("규칙 3 · 분류기 unavailable → medium + 인터스티셜 없이 201 (D-015 · 안전 테스트 12)", () => {
  const outcome: ClassifierOutcome = {
    state: "unavailable",
    reason: "timeout",
  };

  it("층 1이 low면 risk = max(low, medium) = medium이다", () => {
    const decision = grade(clean, outcome);
    expect(decision).toEqual({
      action: "create",
      risk: "medium",
      flags: [],
      classifierState: "unavailable",
    });
  });

  it("인터스티셜을 띄우지 않는다 — 말할 플래그가 없기 때문이다", () => {
    // needs_confirmation(=confirm)이 아니라 즉시 생성이다. §1 흐름의 유일한 예외.
    expect(grade(clean, outcome).action).not.toBe("confirm");
  });

  it("차단도 low도 아니다", () => {
    const decision = grade(clean, outcome);
    expect(decision.action).not.toBe("block");
    expect(decision.risk).not.toBe("low");
  });

  it("classifier_state를 'unavailable'로 남긴다 — risk_flags에 섞지 않는다", () => {
    const decision = grade(clean, outcome);
    expect(decision.action === "create" && decision.classifierState).toBe(
      "unavailable",
    );
    expect(decision.flags).toEqual([]);
  });
});

describe("규칙 4 · D-016 어느 칸에 썼는가로 등급이 갈린다", () => {
  it("학교·회사가 단서(hint)면 high — 차단", () => {
    const decision = grade(clean, ok("low", [{ kind: "school", field: "hint" }]));
    expect(decision.action).toBe("block");
    expect(decision.risk).toBe("high");
  });

  it("학교·회사가 본문(body)이면 medium — 게시하되 피드 제외", () => {
    const decision = grade(clean, ok("low", [{ kind: "company", field: "body" }]));
    expect(decision.action).toBe("confirm");
    expect(decision.risk).toBe("medium");
  });

  it("학교·회사가 질문(question)이면 high — 단서와 동급 (2026-08-14 사용자 확인)", () => {
    // 질문도 카드에 그대로 노출된다(03 §1-4). 여기만 medium이면 소속을 질문 칸으로
    // 옮기는 우회로가 생긴다.
    const decision = grade(
      clean,
      ok("low", [{ kind: "school", field: "question" }]),
    );
    expect(decision.action).toBe("block");
    expect(decision.risk).toBe("high");
  });

  it("층 1이 단서에서 잡아도 같다 — 판정은 grade 한 곳에서 한다", () => {
    const layer1: Layer1Result = {
      risk: "low",
      flags: [{ kind: "school", field: "hint" }],
    };
    expect(grade(layer1, ok("low")).action).toBe("block");
  });

  it("학교·회사가 아닌 플래그는 필드로 등급을 올리지 않는다", () => {
    const decision = grade(clean, ok("low", [{ kind: "person_name", field: "hint" }]));
    expect(decision.action).toBe("create");
    expect(decision.risk).toBe("low");
  });
});

describe("규칙 5 · high는 저장하지 않는다 (04 §3 · 04 「저장하지 않는 것」)", () => {
  it("high 판정은 생성 경로로 가지 않는다 — filter_events에만 남는다", () => {
    const decision = grade(clean, ok("high", [{ kind: "sexual_minor", field: "body" }]));
    expect(decision.action).toBe("block");
    // 저장되는 등급은 'low'|'medium'뿐이다 (letters.risk_level 제약). 그래서
    // 차단 결정에는 letters에 쓸 값(classifier_state)이 아예 붙지 않는다.
    expect("classifierState" in decision).toBe(false);
  });

  it("block에는 confirmation을 붙일 자리가 없다 (안전 테스트 3)", () => {
    const decision = grade(clean, ok("high"));
    expect(decision).toEqual({ action: "block", risk: "high", flags: [] });
  });
});

describe("나머지 경로", () => {
  it("전부 low면 즉시 생성", () => {
    expect(grade(clean, ok("low"))).toEqual({
      action: "create",
      risk: "low",
      flags: [],
      classifierState: "ok",
    });
  });

  it("medium이면 인터스티셜 문구를 그대로 실어 보낸다 (05-api §1)", () => {
    const decision = grade(clean, {
      state: "ok",
      risk: "medium",
      flags: [{ kind: "place_time_combo", field: "body" }],
      notice: "본문에 장소와 시기가 함께 있습니다.",
    });
    expect(decision).toEqual({
      action: "confirm",
      risk: "medium",
      flags: [{ kind: "place_time_combo", field: "body" }],
      notice: "본문에 장소와 시기가 함께 있습니다.",
    });
  });

  it("층 1 플래그와 분류기 플래그를 합쳐 넘긴다 — risk_flags의 출처다", () => {
    const layer1: Layer1Result = {
      risk: "medium",
      flags: [{ kind: "company", field: "body" }],
    };
    const decision = grade(layer1, ok("low", [{ kind: "person_name", field: "body" }]));
    expect(decision.flags).toEqual([
      { kind: "company", field: "body" },
      { kind: "person_name", field: "body" },
    ]);
  });
});
