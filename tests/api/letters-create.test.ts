// POST /api/letters — 05-api §1 · §2 · §5 · §6
//
// 안전 회귀 테스트(#3 #4 #12 #13 #22)는 tests/safety/에 있다. 여기는 그 번호가
// 다루지 않는 나머지 — 검증 · 킬 스위치 · 레이트리밋 · 관리 토큰 · 표기 변형 ·
// notice 처리다.
//
// 층 1과 층 2는 아직 스텁이라(S1·S2 워커) 모듈 모킹으로 판정을 주입한다.
// **layer1.ts / classifier.ts 파일 자체는 고치지 않는다.**

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifierOutcome, Layer1Result } from "@/lib/safety/types";

const stub = vi.hoisted(() => ({
  layer1: { risk: "low", flags: [] } as Layer1Result,
  classifier: { state: "ok", risk: "low", flags: [] } as ClassifierOutcome,
  variants: [] as string[],
  variantsThrow: false,
  /** 변형 호출이 응답을 붙잡고 있는지 보려면 실제로 오래 걸려야 한다. */
  variantsDelayMs: 0,
}));

vi.mock("@/lib/safety/layer1", () => ({
  runLayer1: () => stub.layer1,
}));

vi.mock("@/lib/safety/classifier", () => ({
  classify: async () => stub.classifier,
  generateAnswerVariants: async () => {
    if (stub.variantsDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, stub.variantsDelayMs));
    }
    if (stub.variantsThrow) throw new Error("variant call failed");
    return stub.variants;
  },
}));

import { POST } from "@/app/api/letters/route";
import { answerHmac } from "@/lib/answer";
import { sha256 } from "@/lib/crypto";
import { query } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/events";
import { fpHash } from "@/lib/fingerprint";
import { fillAnswerVariants } from "@/lib/letters/create";
import { insertLetter } from "../fixtures/letters.ts";

const IP = "203.0.113.9";
const UA = "vitest";

interface LetterPayload {
  mode?: unknown;
  relationship?: unknown;
  body?: unknown;
  hint?: unknown;
  question?: unknown;
  answer?: unknown;
  ageConfirmed?: unknown;
  confirmation?: unknown;
}

function post(payload: LetterPayload | string, cookie?: string): Request {
  return new Request("http://localhost/api/letters", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": UA,
      "x-forwarded-for": IP,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

// `ageConfirmed`는 여기서도 필수다 (D-032). 빠지면 400이라 아래 단언들이 전부 그
// 이유로 막힌다. 확인값 자체를 재는 것은 안전 테스트 29다.
const OPEN_LETTER = {
  mode: "open",
  relationship: "friend",
  body: "그때 미안하다고 말하지 못했다.",
  ageConfirmed: true,
} as const;

const LOCKED_LETTER = {
  mode: "locked",
  relationship: "ex",
  body: "그날 하지 못한 말을 여기 남긴다.",
  hint: "2019년 봄, 처음 우산 같이 쓴 날",
  question: "그날 우리가 들어간 카페 이름은?",
  answer: "스타벅스",
  ageConfirmed: true,
} as const;

async function countLetters(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from letters",
  );
  return Number(rows[0]?.count ?? 0);
}

beforeEach(async () => {
  stub.layer1 = { risk: "low", flags: [] };
  stub.classifier = { state: "ok", risk: "low", flags: [] };
  stub.variants = [];
  stub.variantsThrow = false;
  stub.variantsDelayMs = 0;
  await query("delete from letters");
  await query("delete from filter_events");
  await query("delete from events");
  await query(
    "update app_settings set value = 'true'::jsonb where key = 'writing_enabled'",
  );
});

describe("킬 스위치 (05-api §6)", () => {
  it("writing_enabled=false면 503이고 편지가 생기지 않는다", async () => {
    await query(
      "update app_settings set value = 'false'::jsonb where key = 'writing_enabled'",
    );

    const response = await POST(post(OPEN_LETTER));

    expect(response.status).toBe(503);
    expect(await countLetters()).toBe(0);
  });

  it("다시 켜면 즉시 생성된다 — 핸들러가 매 요청 DB를 본다", async () => {
    await query(
      "update app_settings set value = 'false'::jsonb where key = 'writing_enabled'",
    );
    expect((await POST(post(OPEN_LETTER))).status).toBe(503);

    await query(
      "update app_settings set value = 'true'::jsonb where key = 'writing_enabled'",
    );
    expect((await POST(post(OPEN_LETTER))).status).toBe(201);
  });
});

describe("요청 검증 (05-api §2)", () => {
  it("JSON이 아니면 400", async () => {
    expect((await POST(post("본문만 보낸다"))).status).toBe(400);
  });

  it("본문이 500자를 넘으면 400", async () => {
    const response = await POST(
      post({ ...OPEN_LETTER, body: "가".repeat(501) }),
    );
    expect(response.status).toBe(400);
    expect(await countLetters()).toBe(0);
  });

  it("500자는 통과한다 — 경계", async () => {
    const response = await POST(post({ ...OPEN_LETTER, body: "가".repeat(500) }));
    expect(response.status).toBe(201);
  });

  it("모르는 관계는 400", async () => {
    expect(
      (await POST(post({ ...OPEN_LETTER, relationship: "boss" }))).status,
    ).toBe(400);
  });

  it("locked인데 단서·질문·답이 없으면 400", async () => {
    const withoutHint = {
      mode: LOCKED_LETTER.mode,
      relationship: LOCKED_LETTER.relationship,
      body: LOCKED_LETTER.body,
      question: LOCKED_LETTER.question,
      answer: LOCKED_LETTER.answer,
      ageConfirmed: LOCKED_LETTER.ageConfirmed,
    };
    expect((await POST(post(withoutHint))).status).toBe(400);
  });

  it("단서 60자 · 질문 60자 · 답 40자를 넘으면 400", async () => {
    const cases = [
      { hint: "가".repeat(61) },
      { question: "가".repeat(61) },
      { answer: "가".repeat(41) },
    ];
    for (const overflow of cases) {
      const response = await POST(post({ ...LOCKED_LETTER, ...overflow }));
      expect(response.status).toBe(400);
    }
    expect(await countLetters()).toBe(0);
  });

  it("open에 단서를 실어 보내면 400 — 04의 locked_fields와 어긋난다", async () => {
    const response = await POST(post({ ...OPEN_LETTER, hint: "단서" }));
    expect(response.status).toBe(400);
  });
});

describe("생성 (05-api §1 · §2)", () => {
  it("low는 201이고 published · risk_level='low' · classifier_state='ok'다", async () => {
    const response = await POST(post(OPEN_LETTER));
    expect(response.status).toBe(201);

    const created = (await response.json()) as { status: string; id: string };
    expect(created.status).toBe("created");

    const { rows } = await query<{
      id: string;
      status: string;
      risk_level: string;
      classifier_state: string;
      mode: string;
      body: string;
      author_fp_hash: Buffer;
    }>("select * from letters");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      status: "published",
      risk_level: "low",
      classifier_state: "ok",
      mode: "open",
      body: OPEN_LETTER.body,
    });
    // 레이트리밋은 이 컬럼으로 센다 (05-api §5) — 카운터 테이블이 없다.
    expect(rows[0]?.author_fp_hash.equals(fpHash(IP, UA))).toBe(true);
  });

  it("manageToken은 응답에만 있고 DB에는 sha256만 있다 (D-014)", async () => {
    const response = await POST(post(OPEN_LETTER));
    const created = (await response.json()) as { manageToken: string };

    expect(created.manageToken).toMatch(/^[\w-]{43}$/);

    const { rows } = await query<{ manage_token_hash: Buffer }>(
      "select manage_token_hash from letters",
    );
    expect(rows[0]?.manage_token_hash.equals(sha256(created.manageToken))).toBe(
      true,
    );

    // 원문이 어느 컬럼에도 남지 않는다.
    const { rows: leaked } = await query<{ count: string }>(
      "select count(*) as count from letters where letters::text like $1",
      [`%${created.manageToken}%`],
    );
    expect(Number(leaked[0]?.count)).toBe(0);
  });

  it("filter_events에 published 한 행이 남는다 (04 §2)", async () => {
    await POST(post(OPEN_LETTER));

    const { rows } = await query<{
      outcome: string;
      risk_level: string;
      mode: string;
    }>("select outcome, risk_level, mode from filter_events");
    expect(rows).toEqual([
      { outcome: "published", risk_level: "low", mode: "open" },
    ]);
  });

  it("letter_created 이벤트에 편지 ID가 담기지 않는다 (06 §2)", async () => {
    const response = await POST(post(OPEN_LETTER));
    const created = (await response.json()) as { id: string };

    const { rows } = await query<{ name: string; props: Record<string, unknown> }>(
      "select name, props from events",
    );
    expect(rows).toEqual([
      {
        name: "letter_created",
        props: { mode: "open", relationship: "friend", risk: "low" },
      },
    ]);
    expect(JSON.stringify(rows[0]?.props)).not.toContain(created.id);
  });

  it("세션 쿠키가 없으면 발급하고, 있으면 그대로 쓴다", async () => {
    const fresh = await POST(post(OPEN_LETTER));
    expect(fresh.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(fresh.headers.get("set-cookie")).toContain("HttpOnly");

    const reused = await POST(post(OPEN_LETTER, `${SESSION_COOKIE}=session-x`));
    expect(reused.headers.get("set-cookie")).toBeNull();

    const { rows } = await query<{ session_id: string }>(
      "select session_id from events order by id desc limit 1",
    );
    expect(rows[0]?.session_id).toBe("session-x");
  });
});

// ── 표기 변형은 응답 뒤에 채워진다 (create.ts) ──────────────
//
// 테스트는 Next 런타임 밖이라 `after()`가 아니라 그 폴백(맨 프로미스)으로 돌지만, 어느
// 쪽이든 계약은 "응답에는 없고 곧 채워진다"로 같다. 그래서 값이 나타날 때까지 기다린다 —
// 고정 sleep은 느린 만큼 덜 확실하다.
async function waitForVariants(count: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await query<{ answer_variant_hmacs: Buffer[] }>(
      "select answer_variant_hmacs from letters",
    );
    const hmacs = rows[0]?.answer_variant_hmacs ?? [];
    if (hmacs.length >= count) return hmacs;
    if (Date.now() >= deadline) {
      throw new Error(`변형 ${count}개를 기다렸지만 ${hmacs.length}개다.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("표기 변형 (D-021 · 05-api §1)", () => {
  it("locked이고 실제로 생성될 때만 만들고, 각각 정규화+HMAC으로 저장한다", async () => {
    stub.variants = ["스벅", "스타벅스 홍대점"];

    const response = await POST(post(LOCKED_LETTER));
    const created = (await response.json()) as { id: string };

    const variants = await waitForVariants(2);
    const { rows } = await query<{ answer_hmac: Buffer }>(
      "select answer_hmac from letters",
    );

    expect(rows[0]?.answer_hmac.equals(answerHmac(created.id, "스타벅스"))).toBe(
      true,
    );
    expect(variants.map((hmac) => hmac.toString("hex"))).toEqual([
      answerHmac(created.id, "스벅").toString("hex"),
      answerHmac(created.id, "스타벅스 홍대점").toString("hex"),
    ]);
  });

  it("변형 생성을 기다리지 않고 응답한다 (05-api §1 — 제출 경로 3초)", async () => {
    // 변형 호출이 다시 제출 경로로 돌아오면 이 테스트가 깨진다. 그게 이 테스트의 전부다.
    stub.variants = ["스벅"];
    stub.variantsDelayMs = 2_000;

    const started = Date.now();
    const response = await POST(post(LOCKED_LETTER));
    const elapsed = Date.now() - started;

    expect(response.status).toBe(201);
    expect(elapsed).toBeLessThan(1_000);

    // 그리고 실제로 채워진다 — 뒤에 남은 작업이 파일 종료와 겹치지 않게 여기서 거둔다.
    expect(await waitForVariants(1)).toHaveLength(1);
  });

  it("답 원문은 어디에도 저장되지 않는다 (04 「저장하지 않는 것」)", async () => {
    stub.variants = ["스벅"];
    await POST(post(LOCKED_LETTER));
    await waitForVariants(1);

    const { rows } = await query<{ count: string }>(
      "select count(*) as count from letters where letters::text like $1",
      ["%스타벅스%"],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("변형 생성이 실패해도 편지는 변형 없이 생성된다", async () => {
    stub.variantsThrow = true;

    const response = await POST(post(LOCKED_LETTER));

    expect(response.status).toBe(201);
    const { rows } = await query<{ answer_variant_hmacs: Buffer[] }>(
      "select answer_variant_hmacs from letters",
    );
    expect(rows[0]?.answer_variant_hmacs).toEqual([]);
  });

  it("open 모드에는 호출이 없다", async () => {
    stub.variants = ["변형"];
    await POST(post(OPEN_LETTER));

    const { rows } = await query<{
      answer_hmac: Buffer | null;
      answer_variant_hmacs: Buffer[];
    }>("select answer_hmac, answer_variant_hmacs from letters");
    expect(rows[0]?.answer_hmac).toBeNull();
    expect(rows[0]?.answer_variant_hmacs).toEqual([]);
  });

  it("미루는 사이에 작성자가 지운 편지에는 채우지 않는다", async () => {
    stub.variants = ["스벅"];
    const { letter } = await insertLetter({ status: "deleted_by_author" });

    await fillAnswerVariants(
      letter.id,
      "스타벅스",
      answerHmac(letter.id, "스타벅스"),
    );

    const { rows } = await query<{ answer_variant_hmacs: Buffer[] }>(
      "select answer_variant_hmacs from letters where id = $1",
      [letter.id],
    );
    expect(rows[0]?.answer_variant_hmacs).toEqual([]);
  });
});

describe("레이트리밋 (05-api §5)", () => {
  it("1분에 3통을 넘기면 429이고 새 카운터 테이블을 쓰지 않는다", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await POST(post(OPEN_LETTER))).status).toBe(201);
    }

    const response = await POST(post(OPEN_LETTER));
    expect(response.status).toBe(429);
    const body = (await response.json()) as {
      error: { code: string; retryAfter: number };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfter).toBe(60);
    expect(await countLetters()).toBe(3);
  });

  it("1시간에 10통을 넘기면 429", async () => {
    // 분 창 밖(5분 전)에 10통. 시간 창에는 그대로 들어 있다.
    await query(
      `insert into letters (
         id, mode, relationship, body, risk_level, status,
         manage_token_hash, author_fp_hash, created_at, status_changed_at
       )
       select 'rate' || g, 'open', 'friend', '본문', 'low', 'published',
              sha256(('token' || g)::bytea), $1,
              now() - interval '5 minutes', now() - interval '5 minutes'
         from generate_series(1, 10) as g`,
      [fpHash(IP, UA)],
    );

    const response = await POST(post(OPEN_LETTER));
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { retryAfter: number } };
    expect(body.error.retryAfter).toBe(3600);
  });

  it("다른 fp는 서로의 카운트에 걸리지 않는다", async () => {
    for (let i = 0; i < 3; i += 1) await POST(post(OPEN_LETTER));
    expect((await POST(post(OPEN_LETTER))).status).toBe(429);

    const other = new Request("http://localhost/api/letters", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": UA,
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify(OPEN_LETTER),
    });
    expect((await POST(other)).status).toBe(201);
  });
});

describe("notice (05-api §1)", () => {
  beforeEach(() => {
    stub.classifier = {
      state: "ok",
      risk: "medium",
      flags: [{ kind: "school", field: "body" }],
      notice: "본문에 학교 이름으로 보이는 표현이 있습니다.",
    };
  });

  it("needs_confirmation 응답에 분류기 문구가 실린다", async () => {
    const response = await POST(post(OPEN_LETTER));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      risk: string;
      flags: unknown[];
      confirmation: string;
      notice?: string;
    };
    expect(body.status).toBe("needs_confirmation");
    expect(body.risk).toBe("medium");
    expect(body.flags).toEqual([{ kind: "school", field: "body" }]);
    expect(body.confirmation).toBeTypeOf("string");
    expect(body.notice).toBe("본문에 학교 이름으로 보이는 표현이 있습니다.");
  });

  it("notice가 본문을 인용하면 버린다 — 그대로 화면에 뜨기 때문이다", async () => {
    stub.classifier = {
      state: "ok",
      risk: "medium",
      flags: [{ kind: "school", field: "body" }],
      notice: `"${OPEN_LETTER.body}" 부분이 걸렸습니다.`,
    };

    const response = await POST(post(OPEN_LETTER));
    const body = (await response.json()) as { notice?: string };
    expect(body.notice).toBeUndefined();
  });

  it("인터스티셜을 띄운 요청은 편지를 만들지 않는다", async () => {
    await POST(post(OPEN_LETTER));

    expect(await countLetters()).toBe(0);
    const { rows } = await query<{ outcome: string }>(
      "select outcome from filter_events",
    );
    expect(rows).toEqual([{ outcome: "warned" }]);
  });
});
