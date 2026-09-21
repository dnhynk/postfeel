// src/lib/safety/classifier.ts — generateAnswerVariants() (D-021 · 05-api §1)
//
// 핵심 규칙 하나: **실패하면 빈 배열이다.** D-015의 등급 강등 경로를 태우지 않는다 —
// 변형이 없으면 answer_hmac 하나로 여는 이전 동작으로 떨어질 뿐이고, 편지가 안 만들어지는
// 쪽이 훨씬 나쁘다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { spendDayKey } from "@/lib/safety/budget";
import {
  abortError,
  incomplete,
  networkError,
  refusal,
  structured,
  stubFetch,
} from "./fake-openai";
import { loadClassifier } from "./load";

let generateAnswerVariants: typeof import("@/lib/safety/classifier").generateAnswerVariants;

beforeEach(async () => {
  ({ generateAnswerVariants } = await loadClassifier());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await query("delete from app_settings where key like 'classifier_spend:%'");
});

describe("표기 변형 · 정상", () => {
  it("변형 목록을 그대로 돌려준다", async () => {
    stubFetch([
      () => structured({ variants: ["스벅", "starbucks", "스타박스"] }),
    ]);
    expect(await generateAnswerVariants("스타벅스")).toEqual([
      "스벅",
      "starbucks",
      "스타박스",
    ]);
  });

  it("5개를 넘으면 자른다 — 넓힐수록 제3자 적중률이 올라간다 (S-6)", async () => {
    stubFetch([
      () =>
        structured({
          variants: ["하나", "둘", "셋", "넷", "다섯", "여섯", "일곱"],
        }),
    ]);
    expect(await generateAnswerVariants("숫자")).toHaveLength(5);
  });

  it("정답과 같은 변형은 뺀다 — 이미 answer_hmac으로 저장된다", async () => {
    // 띄어쓰기만 다른 "스타 벅스"도 뺀다. answer.ts의 normalizeAnswer가 내부 공백을
    // 전부 지우므로 그 변형은 원본 해시에 이미 걸린다 — 저장해봐야 중복 HMAC이다.
    stubFetch([
      () => structured({ variants: ["스타벅스", "스타 벅스", "스벅"] }),
    ]);
    expect(await generateAnswerVariants("스타벅스")).toEqual(["스벅"]);
  });

  it("중복과 빈 문자열을 버린다", async () => {
    stubFetch([() => structured({ variants: ["스벅", "스벅", "", "  "] })]);
    expect(await generateAnswerVariants("스타벅스")).toEqual(["스벅"]);
  });

  it("등급 판정과 다른 호출이다 — 다른 프롬프트를 쓴다", async () => {
    // D-021 · 05-api §1 「표기 변형은 등급 판정과 다른 호출이다」.
    const stub = stubFetch([() => structured({ variants: ["스벅"] })]);
    await generateAnswerVariants("스타벅스");
    const body = stub.calls[0] as {
      instructions: string;
      text: { format: { name: string } };
    };
    expect(body.text.format.name).toBe("answer_variants");
    expect(body.instructions).toContain("표기 변형");
  });
});

describe("표기 변형 · 실패는 빈 배열이다 (05-api §1 · D-021)", () => {
  it("타임아웃이면 빈 배열이다 — medium 강등 경로를 태우지 않는다", async () => {
    stubFetch([abortError]);
    expect(await generateAnswerVariants("스타벅스")).toEqual([]);
  });

  it("네트워크 오류면 빈 배열이다", async () => {
    stubFetch([networkError]);
    expect(await generateAnswerVariants("스타벅스")).toEqual([]);
  });

  it("스키마 위반이면 빈 배열이다", async () => {
    stubFetch([() => structured({ variants: "스벅" })]);
    expect(await generateAnswerVariants("스타벅스")).toEqual([]);
  });

  it("잘린 응답이면 빈 배열이다", async () => {
    stubFetch([incomplete]);
    expect(await generateAnswerVariants("스타벅스")).toEqual([]);
  });

  it("거부도 빈 배열이다 — 등급은 이미 classify()가 냈다", async () => {
    stubFetch([() => refusal()]);
    expect(await generateAnswerVariants("스타벅스")).toEqual([]);
  });
});

describe("표기 변형 · 비용 상한", () => {
  it("상한의 70%에 닿으면 호출조차 하지 않는다 — 가장 먼저 꺼진다", async () => {
    await query(
      "insert into app_settings (key, value) values ($1, to_jsonb(3.6::numeric))",
      [`classifier_spend:${spendDayKey(new Date())}`],
    );
    const stub = stubFetch([() => structured({ variants: ["스벅"] })]);
    expect(await generateAnswerVariants("스타벅스")).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });
});
