// 하네스가 실제로 도는지 확인하는 최소 테스트 두 개.
// 안전 회귀 테스트(05-api §7)가 아니라 기반 점검이다.

import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { insertLetter, sha256 } from "./fixtures/letters.ts";

describe("테스트 하네스", () => {
  it("테스트 전용 DB에 연결된다", async () => {
    const { rows } = await query<{ one: number; db: string }>(
      "select 1 as one, current_database() as db",
    );
    expect(rows[0]?.one).toBe(1);
    // 공유 DB가 아니라 이 파일 전용 DB여야 한다.
    expect(rows[0]?.db).toMatch(/^postfeel_test_/);
  });

  it("픽스처로 넣은 편지를 다시 읽는다", async () => {
    const { letter, manageToken } = await insertLetter({
      relationship: "ex",
      body: "잘 지내길 바란다.",
    });

    const { rows } = await query<{
      id: string;
      mode: string;
      relationship: string;
      body: string;
      status: string;
      risk_level: string;
      manage_token_hash: Buffer;
    }>("select * from letters where id = $1", [letter.id]);

    expect(rows).toHaveLength(1);
    const found = rows[0]!;
    expect(found.mode).toBe("open");
    expect(found.relationship).toBe("ex");
    expect(found.body).toBe("잘 지내길 바란다.");
    expect(found.status).toBe("published");
    expect(found.risk_level).toBe("low");
    // 관리 토큰 원문은 저장되지 않는다 (D-014).
    expect(found.manage_token_hash.equals(sha256(manageToken))).toBe(true);
  });
});
