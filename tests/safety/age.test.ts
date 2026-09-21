// 작성 표면 — POST /api/letters (만 14세 확인)
//
// 안전 회귀 테스트. 기능 테스트가 아니라 **배포를 막는 테스트**다.
//
// D-032 — 편지 작성과 이메일 등록에는 "만 14세 이상입니다" 확인을 받고 **서버에서**
// 검증한다. 열람·피드에는 붙이지 않는다. 이메일 쪽 같은 규칙은 안전 테스트 14가 잰다.
//
// **상태 코드만 보면 "거부인데 저장됨"을 놓친다.** 그래서 매 단언에 letters 행 수를
// 함께 센다 — 거절 응답을 주면서 편지를 만들어 두는 구현은 400을 보는 테스트를 통과한다.
//
// 층 1·층 2는 스텁이라 모듈 모킹으로 판정을 주입한다.
// **layer1.ts / classifier.ts 파일 자체는 고치지 않는다.**

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifierOutcome, Layer1Result } from "@/lib/safety/types";

const stub = vi.hoisted(() => ({
  layer1: { risk: "low", flags: [] } as Layer1Result,
  classifier: { state: "ok", risk: "low", flags: [] } as ClassifierOutcome,
  /** 확인 없는 요청이 분류기까지 갔는지 세는 카운터. */
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
import { query } from "@/lib/db";

function post(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/letters", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vitest",
      "x-forwarded-for": "198.51.100.29",
    },
    body: JSON.stringify(payload),
  });
}

/** 확인값만 뺀 정상 편지. 이 편지가 막히는 이유는 ageConfirmed 하나뿐이어야 한다. */
const LETTER = {
  mode: "open",
  relationship: "friend",
  body: "그때 하지 못한 말을 여기 남긴다.",
} as const;

async function letterCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from letters",
  );
  return Number(rows[0]?.count ?? 0);
}

async function filterEventCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from filter_events",
  );
  return Number(rows[0]?.count ?? 0);
}

beforeEach(async () => {
  stub.layer1 = { risk: "low", flags: [] };
  stub.classifier = { state: "ok", risk: "low", flags: [] };
  stub.classifyCalls = 0;
  await query("delete from letters");
  await query("delete from filter_events");
  await query("delete from events");
});

// docs/00-decisions.md D-032 · docs/05-api.md §1 「POST /api/letters」
describe("safety#29 · ageConfirmed가 없거나 false면 편지가 생성되지 않는다", () => {
  // 클라이언트 체크박스만으로는 안 된다. 화면을 우회해도 통과 경로가 없어야 한다.
  it("ageConfirmed 누락이면 400이고 letters에 행이 없다", async () => {
    const response = await POST(post(LETTER));

    expect(response.status).toBe(400);
    expect(await letterCount()).toBe(0);
  });

  it("ageConfirmed=false면 400이고 letters에 행이 없다", async () => {
    const response = await POST(post({ ...LETTER, ageConfirmed: false }));

    expect(response.status).toBe(400);
    expect(await letterCount()).toBe(0);
  });

  it("문자열 'true'처럼 참 같은 값도 통과하지 못한다", async () => {
    // 이메일 등록(안전 테스트 14)과 같은 엄격 비교다. 느슨하게 열어두면 클라이언트가
    // 아무 값이나 넣어 우회할 수 있다.
    for (const value of ["true", 1, {}, null, "on"]) {
      const response = await POST(post({ ...LETTER, ageConfirmed: value }));
      expect(response.status).toBe(400);
    }
    expect(await letterCount()).toBe(0);
  });

  it("확인 없는 요청은 분류기까지 가지 않고 filter_events도 남기지 않는다", async () => {
    // 확인은 판정·저장 경로에 들어가기 전에 본다. 뒤에 두면 거절한 요청이 외부 호출
    // 비용을 쓰고 흔적을 남긴다.
    await POST(post(LETTER));

    expect(stub.classifyCalls).toBe(0);
    expect(await filterEventCount()).toBe(0);
  });

  it("high 판정이 아니라 400이다 — 막는 이유가 섞이지 않는다", async () => {
    // 확인이 없으면 등급을 매기지 않는다. blocked로 돌려주면 작성자는 자기 편지가
    // 위험하다고 읽고, 체크박스를 켜도 될 일을 본문 고치기로 해결하려 든다.
    stub.classifier = { state: "ok", risk: "high", flags: [] };

    const response = await POST(post(LETTER));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_request");
    expect(await letterCount()).toBe(0);
  });

  it("발급받은 confirmation을 붙여도 확인 없이는 생성되지 않는다", async () => {
    // 재제출 경로는 재판정을 건너뛴다. 그 경로가 확인을 함께 건너뛰면 인터스티셜을 한 번
    // 본 편지는 체크박스 없이 통과한다.
    stub.classifier = {
      state: "ok",
      risk: "medium",
      flags: [{ kind: "person_name", field: "body" }],
    };
    const first = (await (
      await POST(post({ ...LETTER, ageConfirmed: true }))
    ).json()) as { status: string; confirmation: string };
    expect(first.status).toBe("needs_confirmation");
    expect(await letterCount()).toBe(0);

    const response = await POST(
      post({ ...LETTER, confirmation: first.confirmation }),
    );

    expect(response.status).toBe(400);
    expect(await letterCount()).toBe(0);
  });

  it("ageConfirmed=true면 편지가 생성된다 — 게이트가 전부를 막는 것이 아니다", async () => {
    // 반대 방향 단언. 없으면 "항상 400"이 위 단언을 전부 통과한다.
    const response = await POST(post({ ...LETTER, ageConfirmed: true }));

    expect(response.status).toBe(201);
    expect(await letterCount()).toBe(1);
  });
});
