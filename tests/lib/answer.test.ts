// src/lib/answer.ts — 04 §4 열쇠 답 정규화

import { describe, expect, it } from "vitest";
import { answerHmac, matchesAnswer, normalizeAnswer } from "@/lib/answer";

describe("normalizeAnswer (04 §4)", () => {
  it("자모 분리 입력(NFD)과 NFC 입력이 같아진다", () => {
    // 맥에서 입력한 한글은 자모가 분리된 형태로 들어온다.
    const nfd = "스타벅스".normalize("NFD");
    expect(nfd).not.toBe("스타벅스");
    expect(normalizeAnswer(nfd)).toBe(normalizeAnswer("스타벅스"));
  });

  it("앞뒤 공백과 모든 내부 공백을 지운다", () => {
    expect(normalizeAnswer("  스타 벅스 ")).toBe("스타벅스");
    // 전각 공백도 공백이다.
    expect(normalizeAnswer("스타　벅스")).toBe("스타벅스");
  });

  it("영문을 소문자화한다", () => {
    expect(normalizeAnswer("StarBucks")).toBe("starbucks");
  });

  it("문장부호를 지운다 (.,!?~·'\"「」)", () => {
    expect(normalizeAnswer("스타벅스!!")).toBe("스타벅스");
    expect(normalizeAnswer("「스타·벅스」~")).toBe("스타벅스");
  });

  it("숫자 한글 표기를 통일하지 않는다 — 04 §4가 명시적으로 뺐다", () => {
    expect(normalizeAnswer("3층")).not.toBe(normalizeAnswer("삼층"));
  });
});

describe("answerHmac (04 §4)", () => {
  it("정규화가 같으면 해시가 같다", () => {
    const a = answerHmac("letter-1", " 스타 벅스 ");
    const b = answerHmac("letter-1", "스타벅스".normalize("NFD"));
    expect(a.equals(b)).toBe(true);
  });

  it("편지 ID가 솔트로 작동한다 — 같은 답도 편지가 다르면 해시가 다르다", () => {
    const a = answerHmac("letter-1", "스타벅스");
    const b = answerHmac("letter-2", "스타벅스");
    expect(a.equals(b)).toBe(false);
  });

  it("답 원문이 해시 안에 남지 않는다 (04 「저장하지 않는 것」 · 안전 테스트 23)", () => {
    const hash = answerHmac("letter-1", "스타벅스");
    expect(hash).toHaveLength(32);
    expect(hash.toString("utf8")).not.toContain("스타벅스");
    expect(hash.toString("hex")).not.toContain(
      Buffer.from("스타벅스", "utf8").toString("hex"),
    );
  });
});

describe("matchesAnswer (05-api §2 · D-021)", () => {
  const letterId = "letter-1";
  const stored = answerHmac(letterId, "스타벅스");
  const variants = [
    answerHmac(letterId, "스벅"),
    answerHmac(letterId, "스타벅스 홍대점"),
  ];

  it("원본 답이 맞으면 true", () => {
    expect(matchesAnswer(letterId, " 스타벅스! ", stored, variants)).toBe(true);
  });

  it("표기 변형이 맞아도 true — 어느 쪽에 맞았는지는 돌려주지 않는다", () => {
    // 반환 타입이 boolean 하나라서 "원본이냐 변형이냐"가 새어나갈 자리가 없다.
    expect(matchesAnswer(letterId, "스벅", stored, variants)).toBe(true);
    expect(matchesAnswer(letterId, "스타벅스홍대점", stored, variants)).toBe(
      true,
    );
  });

  it("틀리면 false", () => {
    expect(matchesAnswer(letterId, "이디야", stored, variants)).toBe(false);
  });

  it("다른 편지의 해시로는 열리지 않는다", () => {
    const other = answerHmac("letter-2", "스타벅스");
    expect(matchesAnswer(letterId, "스타벅스", other, [])).toBe(false);
  });

  it("변형이 없어도 동작한다 — 변형 생성 실패 시의 동작 (05-api §1)", () => {
    expect(matchesAnswer(letterId, "스타벅스", stored, [])).toBe(true);
  });
});
