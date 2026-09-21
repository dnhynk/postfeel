// 등급 판정 표면 — 층 1 · 층 2가 합쳐지는 자리 (POST /api/letters)
//
// 순수 함수 레벨 대응은 tests/lib/safety-grade.test.ts에 이미 통과하는 테스트로 있다.
// 여기는 HTTP 표면에서 같은 규칙이 유지되는지 본다.
//
// **#12와 #22가 나란히 있는 게 중요하다.** 둘 다 층 2가 정상 판정을 못 준 경우인데
// 결과가 정반대다 — 장애(`unavailable`)는 medium으로 **생성**되고, 거부(`refusal`)는
// **생성되지 않는다**. D-020이 "거부는 장애가 아니라 위험 신호"라고 가른 자리다.
// 하나로 합치지 않는다.
//
// 층 1·층 2는 아직 스텁이라(S1·S2 워커) 모듈 모킹으로 판정을 주입한다.
// **layer1.ts / classifier.ts 파일 자체는 고치지 않는다.**

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifierOutcome, Layer1Result } from "@/lib/safety/types";

const stub = vi.hoisted(() => ({
  layer1: { risk: "low", flags: [] } as Layer1Result,
  classifier: { state: "unavailable", reason: "timeout" } as ClassifierOutcome,
  /** 3초 타임아웃이 실제로는 예외로 올라올 수도 있다 (05-api §1). */
  classifyThrows: false,
}));

vi.mock("@/lib/safety/layer1", () => ({
  runLayer1: () => stub.layer1,
}));

vi.mock("@/lib/safety/classifier", () => ({
  classify: async () => {
    if (stub.classifyThrows) throw new Error("classifier timeout");
    return stub.classifier;
  },
  generateAnswerVariants: async () => [],
}));

import { POST } from "@/app/api/letters/route";
import { query } from "@/lib/db";
import type { Flag } from "@/lib/safety/types";

function post(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/letters", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vitest",
      "x-forwarded-for": "198.51.100.23",
    },
    body: JSON.stringify(payload),
  });
}

// `ageConfirmed`는 작성 요청의 필수 필드다 (D-032). 빠지면 400이라 이 파일의 판정
// 단언이 전부 그 이유로 막힌다. 확인값 자체는 안전 테스트 29가 잰다.
const LETTER = {
  mode: "open",
  relationship: "friend",
  body: "그때 하지 못한 말을 여기 남긴다.",
  ageConfirmed: true,
} as const;

const LOCKED_LETTER = {
  mode: "locked",
  relationship: "ex",
  body: "그때 하지 못한 말을 여기 남긴다.",
  hint: "OO고등학교 앞에서",
  question: "그날 우리가 들어간 카페 이름은?",
  answer: "스타벅스",
  ageConfirmed: true,
} as const;

async function letters(): Promise<
  Array<{ risk_level: string; classifier_state: string; status: string }>
> {
  const { rows } = await query<{
    risk_level: string;
    classifier_state: string;
    status: string;
  }>("select risk_level, classifier_state, status from letters");
  return rows;
}

async function filterEvents(): Promise<
  Array<{ outcome: string; risk_level: string }>
> {
  const { rows } = await query<{ outcome: string; risk_level: string }>(
    "select outcome, risk_level from filter_events order by id",
  );
  return rows;
}

beforeEach(async () => {
  stub.layer1 = { risk: "low", flags: [] };
  stub.classifier = { state: "unavailable", reason: "timeout" };
  stub.classifyThrows = false;
  await query("delete from letters");
  await query("delete from filter_events");
  await query("delete from events");
});

// docs/05-api.md §7 #12 · §1 「층 2 실패 시」 · docs/00-decisions.md D-015
describe("safety#12 · 분류기를 강제로 죽이면 편지가 medium으로 생성된다", () => {
  // 차단도 아니고 low도 아니다. 인터스티셜도 띄우지 않는다 — 말할 플래그가 없는
  // 모호한 경고는 우회 학습만 시킨다. §1 흐름의 medium → 200 규칙에 대한 유일한 예외.

  it("층 2 타임아웃이면 201이고 risk_level='medium', classifier_state='unavailable'이다", async () => {
    const response = await POST(post(LETTER));

    expect(response.status).toBe(201);
    expect(await letters()).toEqual([
      {
        risk_level: "medium",
        classifier_state: "unavailable",
        status: "published",
      },
    ]);
  });

  it("needs_confirmation을 돌려주지 않는다", async () => {
    const response = await POST(post(LETTER));

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("created");
    expect(body).not.toHaveProperty("confirmation");
    // 인터스티셜을 띄우지 않았으므로 warned가 아니라 바로 published다.
    expect(await filterEvents()).toEqual([
      { outcome: "published", risk_level: "medium" },
    ]);
  });

  it("분류기가 예외를 던져도 같은 경로다 — 제출이 500이 되지 않는다", async () => {
    stub.classifyThrows = true;

    const response = await POST(post(LETTER));

    expect(response.status).toBe(201);
    expect(await letters()).toEqual([
      {
        risk_level: "medium",
        classifier_state: "unavailable",
        status: "published",
      },
    ]);
  });
});

// docs/05-api.md §7 #13 · §1 마지막 문단
describe("safety#13 · 층 1이 high로 판정하면 분류기 장애와 무관하게 차단된다", () => {
  it("층 2가 죽은 상태에서 층 1 high면 200 blocked이고 letters에 행이 없다", async () => {
    // 단서의 학교명 = high (D-016 · 02 §2). 층 1이 사전으로 잡는 자리다.
    const flags: Flag[] = [{ kind: "school", field: "hint" }];
    stub.layer1 = { risk: "high", flags };
    stub.classifier = { state: "unavailable", reason: "timeout" };

    const response = await POST(post(LOCKED_LETTER));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("blocked");
    expect(body.risk).toBe("high");
    expect(body.flags).toEqual(flags);

    expect(await letters()).toEqual([]);
    expect(await filterEvents()).toEqual([
      { outcome: "blocked", risk_level: "high" },
    ]);
  });
});

// docs/05-api.md §7 #22 · §1 「거부(refusal)는 장애가 아니다」 · docs/00-decisions.md D-020
describe("safety#22 · 분류기가 refusal을 반환하면 편지가 생성되지 않는다", () => {
  // medium으로 강등되면 게시된다. S-4·S-5는 게시되면 안 되는 카테고리이고,
  // 하필 그 카테고리가 거부를 유발할 가능성이 가장 높다.

  it("refusal 응답이면 200 blocked이고 letters에 행이 없다", async () => {
    stub.classifier = { state: "refusal" };

    const response = await POST(post(LETTER));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("blocked");
    expect(body.risk).toBe("high");
    expect(body).not.toHaveProperty("confirmation");
    expect(await letters()).toEqual([]);
  });

  it("classifier_state='unavailable' 경로로 흐르지 않는다", async () => {
    stub.classifier = { state: "refusal" };

    await POST(post(LETTER));

    // #12의 경로였다면 여기 medium/unavailable 편지가 한 통 있어야 한다.
    const { rows } = await query<{ count: string }>(
      "select count(*) as count from letters where classifier_state = 'unavailable'",
    );
    expect(Number(rows[0]?.count)).toBe(0);
    // 남는 것은 차단 기록뿐이고, 등급도 medium이 아니라 high다.
    expect(await filterEvents()).toEqual([
      { outcome: "blocked", risk_level: "high" },
    ]);
  });
});
