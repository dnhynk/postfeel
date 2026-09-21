// src/lib/events.ts — 06-analytics §2 금지 규칙

import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import {
  SESSION_COOKIE,
  newSessionId,
  record,
  sanitizeProps,
} from "@/lib/events";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("금지 키 (06-analytics §2)", () => {
  // 편지 ID를 담으면 session_id ↔ letter_id 연결이 생긴다. 무계정으로 얻은 익명성을
  // 분석 편의로 깨는 것이라 코드로 막는다.
  const forbidden = ["letterId", "letter_id", "email", "ip", "userAgent"];

  for (const key of forbidden) {
    it(`props에 ${key}가 있으면 개발·테스트에서 던진다`, () => {
      expect(() => sanitizeProps("letter_created", { [key]: "x" })).toThrow(
        /담을 수 없는 키/,
      );
    });
  }

  it("record()도 같은 이유로 던진다 — 행이 남기 전에 죽는다", async () => {
    await expect(
      record("letter_created", newSessionId(), { letterId: "abc" }),
    ).rejects.toThrow(/담을 수 없는 키/);
  });

  it("프로덕션에서는 그 키만 빼고 기록한다", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(
      sanitizeProps("letter_created", {
        mode: "open",
        letterId: "abc",
        email: "a@b.c",
      }),
    ).toEqual({ mode: "open" });
  });

  it("허용된 props는 그대로 둔다", () => {
    expect(
      sanitizeProps("letter_created", {
        mode: "locked",
        relationship: "ex",
        risk: "low",
      }),
    ).toEqual({ mode: "locked", relationship: "ex", risk: "low" });
  });
});

describe("record", () => {
  it("events 테이블에 한 행을 넣는다", async () => {
    const sessionId = newSessionId();
    await record("letter_created", sessionId, {
      mode: "open",
      relationship: "ex",
      risk: "low",
    });

    const { rows } = await query<{
      name: string;
      session_id: string;
      props: Record<string, unknown>;
    }>("select name, session_id, props from events where session_id = $1", [
      sessionId,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("letter_created");
    expect(rows[0]?.props).toEqual({
      mode: "open",
      relationship: "ex",
      risk: "low",
    });
  });
});

describe("세션 쿠키", () => {
  it("session_id는 익명 랜덤이다 — 계정이 아니다", () => {
    expect(newSessionId()).not.toBe(newSessionId());
    expect(SESSION_COOKIE).toBe("pf_session");
  });
});
