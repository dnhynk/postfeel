// 고정형 반응 — `POST /api/letters/:id/react` (05-api §2 「나머지」 · 04 §2 `reactions`).
//
// 라우트 핸들러를 직접 부른다. 핸들러가 `Request`·`Response`만 쓰므로 Next 런타임 없이
// 그대로 돈다 (tests/api/report.test.ts와 같은 방식).
//
// **여기서 고정하는 것은 셋이다.**
//   1. 중복이 **PK 제약으로** 막힌다 — 애플리케이션이 세는 게 아니다
//   2. 화면에 나갈 개수가 DB의 실제 개수와 같다 (D-007)
//   3. `status='published'`가 아닌 편지에는 반응이 붙지 않는다 — 이게 유일한 장치다

import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/letters/[id]/react/route";
import { REACTION_KINDS, REACTION_LABELS } from "@/components/reactions/kinds";
import { query } from "@/lib/db";
import { insertLetter, randomLetterId } from "../fixtures/letters.ts";

/** UA가 fp를 가른다 (05-api §5). 같은 UA면 같은 사람이다. */
function post(
  letterId: string,
  body: unknown,
  userAgent = "react-test-a",
): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/letters/${letterId}/react`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: letterId }) },
  );
}

async function rowCount(letterId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from reactions where letter_id = $1",
    [letterId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function counts(response: Response): Promise<Record<string, number>> {
  const body = (await response.json()) as { reactions: Record<string, number> };
  return body.reactions;
}

describe("라벨 (D-007)", () => {
  it("kind 네 개에 라벨이 하나씩 있다 — 04 §2의 목록 그대로", () => {
    expect(REACTION_KINDS).toEqual([
      "same",
      "wish_well",
      "unspoken",
      "letting_go",
    ]);
    for (const kind of REACTION_KINDS) {
      expect(REACTION_LABELS[kind]).toBeTruthy();
    }
  });

  it("개수에 의미를 덧씌우는 문구가 없다", () => {
    // D-007이 금지한 것은 없는 신호를 만드는 것이다. "N명이 공감했어요" 류는 개수를
    // 압박으로 바꾸는 문구라 라벨에 들어오면 안 된다. 라벨은 누른 사람 자신의 말이다.
    const labels = Object.values(REACTION_LABELS).join(" ");
    for (const banned of ["명이", "공감했", "기다리", "지금", "N명"]) {
      expect(labels).not.toContain(banned);
    }
  });
});

describe("kind 검증 (04 §2)", () => {
  it("문서에 있는 네 종류를 전부 받는다", async () => {
    const { letter } = await insertLetter();

    for (const kind of REACTION_KINDS) {
      const response = await post(letter.id, { kind });
      expect(response.status).toBe(200);
    }

    // 같은 사람(같은 UA)이라도 kind가 다르면 다른 행이다 — PK가 셋을 함께 본다.
    expect(await rowCount(letter.id)).toBe(4);
  });

  it("목록 밖의 kind는 400이고 저장되지 않는다", async () => {
    const { letter } = await insertLetter();

    for (const body of [{}, { kind: "" }, { kind: "love" }, { kind: 1 }]) {
      const response = await post(letter.id, body);
      expect(response.status).toBe(400);
    }
    expect(await rowCount(letter.id)).toBe(0);
  });
});

describe("중복 (04 §2 PK 제약)", () => {
  it("같은 사람이 같은 반응을 다시 눌러도 행이 늘지 않는다", async () => {
    const { letter } = await insertLetter();

    const first = await post(letter.id, { kind: "same" });
    const second = await post(letter.id, { kind: "same" });
    const third = await post(letter.id, { kind: "same" });

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    // 애플리케이션이 "이미 눌렀나"를 세지 않는다. 스키마가 막는다.
    expect(await rowCount(letter.id)).toBe(1);
    // **화면에 나갈 숫자도 1이다.** 여기가 D-007이 걸리는 자리다 — 클라이언트가
    // 낙관적으로 +1 했다면 3이 됐을 것이고, 그건 DB에 없는 신호다.
    expect(await counts(third)).toEqual({ same: 1 });
  });

  it("PK 제약이 실제로 존재한다 — 직접 두 번 넣으면 DB가 거부한다", async () => {
    const { letter } = await insertLetter();
    const fp = Buffer.alloc(32, 7);

    await query(
      "insert into reactions (letter_id, kind, fp_hash) values ($1,'same',$2)",
      [letter.id, fp],
    );

    // 라우트의 `on conflict do nothing`이 없으면 이 오류가 사용자에게 나간다.
    // 막는 주체가 애플리케이션이 아니라 스키마임을 여기서 고정한다.
    await expect(
      query(
        "insert into reactions (letter_id, kind, fp_hash) values ($1,'same',$2)",
        [letter.id, fp],
      ),
    ).rejects.toThrow(/duplicate key value|reactions_pkey/);

    expect(await rowCount(letter.id)).toBe(1);
  });

  it("다른 사람이면 같은 반응도 따로 센다", async () => {
    const { letter } = await insertLetter();

    await post(letter.id, { kind: "same" }, "react-test-a");
    const response = await post(letter.id, { kind: "same" }, "react-test-b");

    expect(await rowCount(letter.id)).toBe(2);
    expect(await counts(response)).toEqual({ same: 2 });
  });
});

describe("응답 (05-api §2)", () => {
  it("방금 센 개수를 돌려준다 — 0인 kind는 키가 없다", async () => {
    const { letter } = await insertLetter();

    await post(letter.id, { kind: "same" }, "react-test-a");
    await post(letter.id, { kind: "same" }, "react-test-b");
    const response = await post(letter.id, { kind: "unspoken" }, "react-test-a");

    // 누른 적 없는 kind를 `0`으로 채우지 않는다. 없는 신호를 만들지 않는 것과 같은 규칙.
    expect(await counts(response)).toEqual({ same: 2, unspoken: 1 });
  });
});

describe("대상 편지 (05-api §2 「상태별 표면 응답」)", () => {
  it("없는 편지는 404다", async () => {
    const response = await post(randomLetterId(), { kind: "same" });
    expect(response.status).toBe(404);
  });

  it("내려간 편지에는 반응이 붙지 않는다 — 403이 아니라 404", async () => {
    for (const status of [
      "hidden_auto",
      "hidden_admin",
      "deleted_by_author",
    ] as const) {
      const { letter } = await insertLetter({ status });

      const response = await post(letter.id, { kind: "same" });

      // 403은 편지의 존재를 확인해준다. 404는 아무것도 알려주지 않는다.
      expect(response.status).toBe(404);
      expect(await rowCount(letter.id)).toBe(0);
    }
  });

  it("등급 medium 편지는 반응을 받는다 — 링크 접근은 허용이고 피드 제외일 뿐이다 (04 §3)", async () => {
    const { letter } = await insertLetter({ riskLevel: "medium" });

    const response = await post(letter.id, { kind: "wish_well" });

    expect(response.status).toBe(200);
    expect(await counts(response)).toEqual({ wish_well: 1 });
  });
});
