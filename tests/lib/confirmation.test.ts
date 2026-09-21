// src/lib/confirmation.ts — 05-api §1
//
// 안전 테스트 4("confirmation 발급 후 본문 또는 답을 바꾸면 재분류된다")의 단위 레벨
// 대응이다. HTTP 표면 테스트는 tests/safety/letter-create.test.ts에 있다.

import { describe, expect, it } from "vitest";
import { TTL_MS, contentHash, issue, verify } from "@/lib/confirmation";
import type { Flag, LetterDraft } from "@/lib/safety/types";

const flags: Flag[] = [{ kind: "person_name", field: "body" }];

const draft: LetterDraft = {
  mode: "locked",
  relationship: "ex",
  body: "그때 그 말을 못 했다.",
  hint: "우리가 자주 가던 곳",
  question: "그 카페 이름은?",
  answer: "스타벅스",
};

function issued(now = Date.now()): string {
  return issue({ contentHash: contentHash(draft), flags, filterEventId: 7 }, now);
}

describe("contentHash", () => {
  it("필드 경계가 고정된다 — 표현을 본문 끝에서 단서 앞으로 옮기면 해시가 달라진다", () => {
    // 단순 문자열 연결(body + hint)이면 아래 둘의 해시가 같아진다 (05-api §1).
    const a: LetterDraft = { ...draft, body: "가나", hint: "다라" };
    const b: LetterDraft = { ...draft, body: "가", hint: "나다라" };
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("answer가 해시에 들어간다 (D-021)", () => {
    expect(contentHash(draft)).not.toBe(
      contentHash({ ...draft, answer: "이디야" }),
    );
  });

  it("같은 내용이면 같은 해시다", () => {
    expect(contentHash(draft)).toBe(contentHash({ ...draft }));
  });
});

describe("issue", () => {
  it("risk는 medium으로 고정된다 — high에는 발급하지 않는다 (안전 테스트 3)", () => {
    const result = verify(issued(), draft);
    expect(result.ok && result.payload.risk).toBe("medium");
  });

  it("filterEventId를 서명 안에 실어 나른다 — warned → published 갱신의 출처다", () => {
    const result = verify(issued(), draft);
    expect(result.ok && result.payload.filterEventId).toBe(7);
  });

  it("flags를 그대로 실어 나른다 — 재제출은 재판정하지 않으므로 risk_flags의 유일한 출처다", () => {
    const result = verify(issued(), draft);
    expect(result.ok && result.payload.flags).toEqual(flags);
  });
});

describe("verify", () => {
  it("정상 토큰은 통과한다", () => {
    expect(verify(issued(), draft).ok).toBe(true);
  });

  it("위조 토큰을 거부한다 — 서명이 안 맞는다", () => {
    const token = issued();
    const [part] = token.split(".");
    const forged = `${part}.${Buffer.from("아무거나").toString("base64url")}`;
    expect(verify(forged, draft)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("페이로드를 갈아끼운 토큰을 거부한다", () => {
    // 서명은 그대로 두고 payload만 바꿔치기한다.
    const token = issued();
    const signature = token.slice(token.indexOf(".") + 1);
    const tampered = Buffer.from(
      JSON.stringify({
        contentHash: contentHash(draft),
        risk: "medium",
        flags: [],
        filterEventId: 7,
        exp: Date.now() + TTL_MS,
      }),
      "utf8",
    ).toString("base64url");
    expect(verify(`${tampered}.${signature}`, draft)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("형태가 아닌 문자열을 거부한다", () => {
    expect(verify("", draft)).toEqual({ ok: false, reason: "malformed" });
    expect(verify("점이없다", draft)).toEqual({ ok: false, reason: "malformed" });
  });

  it("만료된 토큰을 거부한다 (발급 후 10분)", () => {
    const now = Date.now();
    const token = issued(now);
    expect(verify(token, draft, now + TTL_MS - 1).ok).toBe(true);
    expect(verify(token, draft, now + TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("body를 바꾸면 거부한다 — 부르는 쪽이 다시 분류한다", () => {
    const token = issued();
    expect(verify(token, { ...draft, body: "고쳐 썼다." })).toEqual({
      ok: false,
      reason: "content_changed",
    });
  });

  it("**answer만** 바꿔도 거부한다 (D-021 · 안전 테스트 4)", () => {
    // 안 막으면 경고를 본 뒤 답만 갈아끼운 편지가 같은 토큰으로 통과한다.
    const token = issued();
    expect(verify(token, { ...draft, answer: "이디야" })).toEqual({
      ok: false,
      reason: "content_changed",
    });
  });

  it("hint·question을 바꿔도 거부한다", () => {
    const token = issued();
    expect(verify(token, { ...draft, hint: "다른 단서" }).ok).toBe(false);
    expect(verify(token, { ...draft, question: "다른 질문?" }).ok).toBe(false);
  });
});
