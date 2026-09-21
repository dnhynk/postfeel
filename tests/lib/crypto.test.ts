// src/lib/crypto.ts · src/lib/ids.ts

import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  hmacSha256,
  manageTokenHash,
  randomToken,
  sha256,
} from "@/lib/crypto";
import { ID_LENGTH, newId } from "@/lib/ids";

describe("ids", () => {
  it("22자 nanoid 문자셋(base64url)으로 나온다 (04 §1-1)", () => {
    const id = newId();
    expect(id).toHaveLength(ID_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("순차가 아니다 — 1000개가 전부 다르다 (04 §1-1)", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});

describe("crypto", () => {
  it("randomToken은 32바이트 base64url이다 (D-014 · 09 §4)", () => {
    const token = randomToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("manageTokenHash는 sha256(token)이다 — 원문을 저장하지 않는다 (D-014)", () => {
    const token = randomToken();
    expect(manageTokenHash(token).equals(sha256(token))).toBe(true);
  });

  it("hmacSha256은 키가 다르면 값이 다르다 (D-017)", () => {
    const a = hmacSha256("answer-key", "같은 입력");
    const b = hmacSha256("fp-key", "같은 입력");
    expect(a.equals(b)).toBe(false);
  });

  describe("constantTimeEqual", () => {
    it("같은 값이면 true", () => {
      expect(constantTimeEqual(sha256("x"), sha256("x"))).toBe(true);
    });

    it("다른 값이면 false", () => {
      expect(constantTimeEqual(sha256("x"), sha256("y"))).toBe(false);
    });

    it("길이가 달라도 던지지 않고 false를 돌려준다", () => {
      // timingSafeEqual을 그대로 쓰면 여기서 던진다.
      expect(constantTimeEqual(Buffer.from("ab"), Buffer.from("abcd"))).toBe(
        false,
      );
    });

    it("빈 버퍼끼리는 true", () => {
      expect(constantTimeEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
    });
  });
});
