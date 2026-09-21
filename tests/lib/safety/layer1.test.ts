// src/lib/safety/layer1.ts — 층 1 판정의 동작 계약 (D-015 · D-016)
//
// 공개 저장소에서는 실서비스 규칙을 제외했다. 여기서는 규칙 내용이 아니라 층 1이
// 결과를 합치는 방식과 grade.ts와의 경계만 고정한다. 입력은 patterns.ts ·
// dictionaries/의 예시 항목을 쓴다.

import { describe, expect, it } from "vitest";
import { grade } from "@/lib/safety/grade";
import { runLayer1 } from "@/lib/safety/layer1";
import { COMPANIES, SCHOOLS } from "@/lib/safety/dictionaries/match";
import type { ClassifierOutcome, LetterDraft } from "@/lib/safety/types";

const draft = (over: Partial<LetterDraft>): LetterDraft => ({
  mode: "open",
  relationship: "ex",
  body: "잘 지내니. 그냥 한 번 물어보고 싶었어.",
  ...over,
});

/** 분류기가 아무것도 못 찾은 경우. 층 1의 기여만 남는다. */
const classifierClean: ClassifierOutcome = { state: "ok", risk: "low", flags: [] };

const SCHOOL = SCHOOLS[0];
const COMPANY = COMPANIES[0];

describe("사전 — 걸린 칸을 flag의 field로 낸다", () => {
  it("본문의 학교명", () => {
    expect(runLayer1(draft({ body: `${SCHOOL} 나왔다고 했잖아` })).flags).toEqual([
      { kind: "school", field: "body" },
    ]);
  });

  it("본문의 회사명", () => {
    expect(runLayer1(draft({ body: `${COMPANY} 다닌다고 들었어` })).flags).toEqual([
      { kind: "company", field: "body" },
    ]);
  });
});

describe("D-016 — 같은 학교명도 어느 칸이냐로 등급이 갈린다", () => {
  it("본문이면 medium — 게시하되 피드 제외", () => {
    const decision = grade(
      runLayer1(draft({ body: `${SCHOOL} 앞에서 자주 만났잖아` })),
      classifierClean,
    );
    expect(decision.action).toBe("confirm");
    expect(decision.risk).toBe("medium");
    expect(decision.flags).toEqual([{ kind: "school", field: "body" }]);
  });

  it("단서면 high — 차단", () => {
    const decision = grade(
      runLayer1(
        draft({
          mode: "locked",
          body: "잘 지내지",
          hint: `${SCHOOL} 정문 앞 그 카페`,
          question: "그때 마신 음료는?",
        }),
      ),
      classifierClean,
    );
    expect(decision.action).toBe("block");
    expect(decision.risk).toBe("high");
    expect(decision.flags).toEqual([{ kind: "school", field: "hint" }]);
  });

  it("질문이면 high — 단서와 동급", () => {
    const decision = grade(
      runLayer1(
        draft({
          mode: "locked",
          body: "잘 지내지",
          hint: "둘만 아는 그날",
          question: `${SCHOOL} 앞 그 카페 이름은?`,
        }),
      ),
      classifierClean,
    );
    expect(decision.action).toBe("block");
    expect(decision.risk).toBe("high");
    expect(decision.flags).toEqual([{ kind: "school", field: "question" }]);
  });

  it("층 1은 D-016을 스스로 적용하지 않는다 — 판정은 grade 한 곳에서 한다", () => {
    const result = runLayer1(
      draft({ mode: "locked", body: "잘 지내지", hint: `${SCHOOL} 앞`, question: "음료는?" }),
    );
    expect(result.risk).toBe("low");
    expect(result.flags).toEqual([{ kind: "school", field: "hint" }]);
  });
});

describe("연락처·URL은 칸과 무관하게 high", () => {
  it("본문의 연락처도 high다", () => {
    const result = runLayer1(draft({ body: "someone@example.com 으로 연락 줘" }));
    expect(result.risk).toBe("high");
    expect(result.flags).toEqual([{ kind: "contact", field: "body" }]);
  });

  it("단서의 URL도 high다", () => {
    const result = runLayer1(
      draft({
        mode: "locked",
        body: "잘 지내",
        hint: "https://example.com/photo",
        question: "그날 뭐 먹었지?",
      }),
    );
    expect(result.risk).toBe("high");
    expect(result.flags).toEqual([{ kind: "url", field: "hint" }]);
  });

  it("층 1이 high면 분류기가 죽어도 차단이다 (안전 테스트 13)", () => {
    const decision = grade(
      runLayer1(draft({ body: "someone@example.com" })),
      { state: "unavailable", reason: "timeout" },
    );
    expect(decision.action).toBe("block");
    expect(decision.risk).toBe("high");
  });
});

describe("답(answer)은 보지 않는다", () => {
  it("답에 연락처가 있어도 등급을 올리지 않는다", () => {
    const result = runLayer1(
      draft({
        mode: "locked",
        body: "잘 지내",
        hint: "둘만 아는 그날",
        question: "그때 그 주소는?",
        answer: "someone@example.com",
      }),
    );
    expect(result).toEqual({ risk: "low", flags: [] });
  });
});

describe("탐지 없음 · 실패 경로 없음 (D-015 「로컬 실행, 실패 없음」)", () => {
  it("평범한 문장은 low이고 최종 판정도 즉시 게시다", () => {
    const body = "네가 준 편지는 아직 서랍에 있어. 버리지 못했어.";
    expect(runLayer1(draft({ body }))).toEqual({ risk: "low", flags: [] });
    const decision = grade(runLayer1(draft({ body })), classifierClean);
    expect(decision.action).toBe("create");
    expect(decision.risk).toBe("low");
  });

  for (const body of ["", " ", "🙂🙂🙂", "가".repeat(500), "\\d{3}-\\d{4}"]) {
    it(`던지지 않는다: ${JSON.stringify(body.slice(0, 20))}`, () => {
      expect(() => runLayer1(draft({ body }))).not.toThrow();
    });
  }

  it("빈 단서·질문을 건너뛴다", () => {
    expect(runLayer1(draft({ body: "잘 지내", hint: "", question: "" }))).toEqual({
      risk: "low",
      flags: [],
    });
  });
});
