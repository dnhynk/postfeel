// 작성 표면 — POST /api/letters (등급 판정 · confirmation)
//
// 안전 회귀 테스트. 기능 테스트가 아니라 **배포를 막는 테스트**다.
//
// 층 1·층 2는 아직 스텁이라(S1·S2 워커) 모듈 모킹으로 판정을 주입한다.
// **layer1.ts / classifier.ts 파일 자체는 고치지 않는다.**

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifierOutcome, Layer1Result } from "@/lib/safety/types";

const stub = vi.hoisted(() => ({
  layer1: { risk: "low", flags: [] } as Layer1Result,
  classifier: { state: "ok", risk: "low", flags: [] } as ClassifierOutcome,
  /** 재판정이 실제로 일어났는지 세는 카운터. "재판정 없이"를 증명하려면 필요하다. */
  classifyCalls: 0,
}));

vi.mock("@/lib/safety/layer1", () => ({
  runLayer1: () => stub.layer1,
}));

vi.mock("@/lib/safety/classifier", () => ({
  classify: async () => {
    stub.classifyCalls += 1;
    return stub.classifier;
  },
  generateAnswerVariants: async () => [],
}));

import { POST } from "@/app/api/letters/route";
import { contentHash, issue } from "@/lib/confirmation";
import { query } from "@/lib/db";
import type { Flag, LetterDraft } from "@/lib/safety/types";

const SCHOOL_FLAG: Flag = { kind: "school", field: "hint" };

function post(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/letters", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vitest",
      "x-forwarded-for": "198.51.100.7",
    },
    body: JSON.stringify(payload),
  });
}

// `ageConfirmed`는 작성 요청의 필수 필드다 (D-032). 빠지면 400이라 이 파일의 판정
// 단언이 전부 그 이유로 막힌다. 확인값 자체는 안전 테스트 29가 잰다.
const OPEN_LETTER = {
  mode: "open",
  relationship: "friend",
  body: "그때 하지 못한 말을 여기 남긴다.",
  ageConfirmed: true,
} as const;

const LOCKED_LETTER = {
  mode: "locked",
  relationship: "ex",
  body: "그때 하지 못한 말을 여기 남긴다.",
  hint: "2019년 봄, 처음 우산 같이 쓴 날",
  question: "그날 우리가 들어간 카페 이름은?",
  answer: "스타벅스",
  ageConfirmed: true,
} as const;

async function letterCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from letters",
  );
  return Number(rows[0]?.count ?? 0);
}

async function filterEvents(): Promise<
  Array<{ id: number; outcome: string; risk_level: string }>
> {
  const { rows } = await query<{
    id: string;
    outcome: string;
    risk_level: string;
  }>("select id, outcome, risk_level from filter_events order by id");
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/** 05-api §1의 medium 판정. 인터스티셜을 띄우고 confirmation을 발급하는 상태다. */
function classifierSaysMedium(): void {
  stub.classifier = {
    state: "ok",
    risk: "medium",
    flags: [{ kind: "person_name", field: "body" }],
  };
}

beforeEach(async () => {
  stub.layer1 = { risk: "low", flags: [] };
  stub.classifier = { state: "ok", risk: "low", flags: [] };
  stub.classifyCalls = 0;
  await query("delete from letters");
  await query("delete from filter_events");
  await query("delete from events");
});

// docs/05-api.md §7 #3 · §1 「high는 confirmation을 발급하지 않는다」
describe("safety#3 · risk=high는 confirmation 없이도, 조작된 confirmation으로도 생성되지 않는다", () => {
  // 클라이언트를 조작해도 통과 경로가 없어야 한다.
  beforeEach(() => {
    // 단서의 학교명 = high (D-016). 층 1이 잡는 자리다.
    stub.layer1 = { risk: "low", flags: [SCHOOL_FLAG] };
  });

  it("high 판정은 200 { status: 'blocked' } 이고 응답에 confirmation이 없다", async () => {
    const response = await POST(post(LOCKED_LETTER));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("blocked");
    expect(body.risk).toBe("high");
    expect(body.flags).toEqual([SCHOOL_FLAG]);
    expect(body).not.toHaveProperty("confirmation");
  });

  it("high 편지는 letters에 행이 남지 않고 filter_events에만 남는다", async () => {
    await POST(post(LOCKED_LETTER));

    expect(await letterCount()).toBe(0);
    expect(await filterEvents()).toMatchObject([
      { outcome: "blocked", risk_level: "high" },
    ]);
  });

  it("직접 만든 confirmation을 붙여도 생성되지 않는다", async () => {
    const draft: LetterDraft = {
      mode: "locked",
      relationship: "ex",
      body: LOCKED_LETTER.body,
      hint: LOCKED_LETTER.hint,
      question: LOCKED_LETTER.question,
      answer: LOCKED_LETTER.answer,
    };

    // ① 서명을 흉내 낸 토큰 — 페이로드는 그럴듯하지만 키가 없다.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        contentHash: contentHash(draft),
        risk: "medium",
        flags: [],
        filterEventId: 1,
        exp: Date.now() + 600_000,
      }),
      "utf8",
    ).toString("base64url");

    // ② 다른 편지에 정상 발급된 토큰을 가져다 붙인 경우.
    const stolen = issue({
      contentHash: contentHash({
        mode: "open",
        relationship: "friend",
        body: "전혀 다른 편지",
      }),
      flags: [],
      filterEventId: 1,
    });

    for (const confirmation of [
      `${forgedPayload}.가짜서명`,
      `${forgedPayload}.`,
      stolen,
      "완전한.쓰레기",
    ]) {
      const response = await POST(post({ ...LOCKED_LETTER, confirmation }));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { status: string }).status).toBe(
        "blocked",
      );
    }

    expect(await letterCount()).toBe(0);
  });
});

// docs/05-api.md §7 #4 · §1 · docs/00-decisions.md D-021
describe("safety#4 · confirmation 발급 후 본문 또는 답을 바꾸면 재분류된다", () => {
  // contentHash에 answer가 들어간다. 빠뜨리면 경고를 본 뒤 답만 갈아끼운 편지가
  // 같은 토큰으로 통과한다.

  it("body를 고쳐 재제출하면 토큰이 거부되고 다시 판정한다", async () => {
    classifierSaysMedium();
    const first = (await (await POST(post(OPEN_LETTER))).json()) as {
      status: string;
      confirmation: string;
    };
    expect(first.status).toBe("needs_confirmation");
    const callsAfterFirst = stub.classifyCalls;

    // 고친 본문은 high였다 — 토큰이 있어도 그 판정이 이긴다.
    stub.classifier = {
      state: "ok",
      risk: "high",
      flags: [{ kind: "person_name", field: "body" }],
    };
    const response = await POST(
      post({
        ...OPEN_LETTER,
        body: `${OPEN_LETTER.body} 그리고 한 줄 더 적었다.`,
        confirmation: first.confirmation,
      }),
    );

    expect(((await response.json()) as { status: string }).status).toBe(
      "blocked",
    );
    expect(stub.classifyCalls).toBe(callsAfterFirst + 1);
    expect(await letterCount()).toBe(0);
  });

  it("answer만 고쳐 재제출해도 토큰이 거부되고 다시 판정한다", async () => {
    classifierSaysMedium();
    const first = (await (await POST(post(LOCKED_LETTER))).json()) as {
      status: string;
      confirmation: string;
    };
    expect(first.status).toBe("needs_confirmation");
    const callsAfterFirst = stub.classifyCalls;

    stub.classifier = {
      state: "ok",
      risk: "high",
      flags: [{ kind: "person_name", field: "body" }],
    };
    const response = await POST(
      post({
        ...LOCKED_LETTER,
        answer: "다른 답",
        confirmation: first.confirmation,
      }),
    );

    expect(((await response.json()) as { status: string }).status).toBe(
      "blocked",
    );
    expect(stub.classifyCalls).toBe(callsAfterFirst + 1);
    expect(await letterCount()).toBe(0);
  });

  it("내용이 같으면 재판정 없이 생성되고 filter_events가 warned → published가 된다", async () => {
    classifierSaysMedium();
    const first = (await (await POST(post(OPEN_LETTER))).json()) as {
      confirmation: string;
      flags: Flag[];
    };
    const warned = await filterEvents();
    expect(warned).toMatchObject([{ outcome: "warned", risk_level: "medium" }]);
    const callsAfterFirst = stub.classifyCalls;

    const response = await POST(
      post({ ...OPEN_LETTER, confirmation: first.confirmation }),
    );

    expect(response.status).toBe(201);
    // 재판정이 없다 — 분류기를 다시 부르지 않았다.
    expect(stub.classifyCalls).toBe(callsAfterFirst);

    // 같은 행이 올라간다. 새 행이 생기면 강행률이 두 배로 보인다.
    expect(await filterEvents()).toMatchObject([
      { id: warned[0]?.id, outcome: "published", risk_level: "medium" },
    ]);

    // risk_flags의 출처는 토큰뿐이다 (05-api §1).
    const { rows } = await query<{ risk_level: string; risk_flags: Flag[] }>(
      "select risk_level, risk_flags from letters",
    );
    expect(rows).toEqual([
      { risk_level: "medium", risk_flags: first.flags },
    ]);
  });
});
