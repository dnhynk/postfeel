// 신고 큐 초안 판정 — 배선 (07 §2 · 05-api §1 · 07 §7).
//
// 07 §2가 약속한 "큐에는 분류기가 붙여둔 초안이 있다"를 실제로 붙이는 경로다. 이 파일이
// 고정하는 것 넷:
//
//   1. 신고 1건 → `admin_actions`에 초안 행 하나. 큐가 그걸 읽는다
//   2. 초안이 실패해도 신고 접수 · 자동 비공개 · 텔레그램은 그대로 돈다
//      (초안은 **운영자 보조이지 안전 장치가 아니다**)
//   3. 비용 상한에 닿으면 초안은 건너뛰고 등급 판정은 살아 있다 (05-api §1 끄는 순서)
//   4. 초안에 편지 본문이 들어가지 않는다 (L-007 · 09 §3와 같은 이유)
//
// 스텁은 `fetch`에 둔다 — classifier.ts를 통째로 mock 하면 실제로 확인해야 하는 것(응답을
// 우리가 제대로 읽는가)이 빠진다. `.env.test`의 `OPENAI_API_KEY`가 비어 있어 라우트를
// **가짜 키를 넣은 뒤 다시 싣는다** (tests/lib/classifier/load.ts와 같은 이유).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** 가로챈 `after()`가 받아 둔 콜백들. 돌리는 것은 테스트가 정한다. */
  scheduled: [] as Array<() => Promise<void>>,
  email: { notifyAutoHidden: vi.fn(async () => {}) },
  telegram: { notifySevereReport: vi.fn(async () => {}) },
}));

vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    mocks.scheduled.push(task);
  },
}));

vi.mock("@/lib/notify/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/email")>()),
  ...mocks.email,
}));

vi.mock("@/lib/notify/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/telegram")>()),
  ...mocks.telegram,
}));

import { REPORT_DRAFT_ACTION, loadQueue } from "@/lib/admin/queue";
import { answerHmac } from "@/lib/answer";
import { query } from "@/lib/db";
import { deleteByAuthor } from "@/lib/letters/deletion";
import { DAILY_CAP_USD, spendDayKey } from "@/lib/safety/budget";
import { insertLetter, randomLetterId } from "../fixtures/letters.ts";
import {
  abortError,
  structured,
  stubFetch,
} from "../lib/classifier/fake-openai.ts";

/** 07 §2 판정표를 묻게 만드는 편지. 본문 인용 검사에도 이 본문을 쓴다. */
const BODY = "그 사람 번호를 아직 못 지웠다. 3반이었고 늘 창가에 앉았다.";
const HINT = "2019년 신촌 그 골목";

let uaCounter = 0;

type Post = typeof import("@/app/api/letters/[id]/report/route").POST;
let post: Post;

/**
 * 라우트를 가짜 키와 함께 새로 싣는다.
 *
 * `src/lib/env.ts`가 모듈 평가 시점에 `process.env`를 한 번 읽어 고정하므로, 키를 넣은
 * **뒤에** 레지스트리를 비우고 다시 import 해야 분류기가 클라이언트를 만들 수 있다.
 * 커넥션 풀은 `globalThis`에 있어 다시 실어도 그대로다 (src/lib/db.ts).
 */
beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-a-real-key");
  vi.resetModules();
  ({ POST: post } = await import("@/app/api/letters/[id]/report/route"));
  mocks.scheduled.length = 0;
  vi.clearAllMocks();
  await query("delete from admin_actions");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await query("delete from app_settings where key like 'classifier_spend:%'");
});

function report(letterId: string, reason: string): Promise<Response> {
  uaCounter += 1;
  return post(
    new Request(`http://localhost/api/letters/${letterId}/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `report-draft-${uaCounter}`,
      },
      body: JSON.stringify({ reason }),
    }),
    { params: Promise.resolve({ id: letterId }) },
  );
}

/** 모아둔 콜백을 실제로 돌린다 — 배포에서 응답이 나간 뒤에 벌어지는 일이다. */
async function runScheduled(): Promise<void> {
  const tasks = mocks.scheduled.splice(0);
  for (const task of tasks) await task();
}

async function drafts(): Promise<
  Array<{ action: string; target_id: string; note: string }>
> {
  const { rows } = await query<{
    action: string;
    target_id: string;
    note: string;
  }>(
    "select action, target_id, note from admin_actions where action = $1",
    [REPORT_DRAFT_ACTION],
  );
  return rows;
}

async function reportIdOf(letterId: string): Promise<number> {
  const { rows } = await query<{ id: string }>(
    "select id from reports where letter_id = $1",
    [letterId],
  );
  if (!rows[0]) throw new Error("신고 행이 없다.");
  return Number(rows[0].id);
}

async function statusOf(letterId: string): Promise<string> {
  const { rows } = await query<{ status: string }>(
    "select status from letters where id = $1",
    [letterId],
  );
  if (!rows[0]) throw new Error("편지가 없다.");
  return rows[0].status;
}

describe("초안 행이 생긴다 (07 §2)", () => {
  it("신고 1건이 admin_actions에 초안 한 줄을 남기고 큐가 그걸 읽는다", async () => {
    const { letter } = await insertLetter({ body: BODY });
    stubFetch([
      () =>
        structured({
          row: "targeting",
          rationale: "제3자가 알아볼 수 있고 부정적이다.",
          confidence: "medium",
        }),
    ]);

    expect((await report(letter.id, "targeting")).status).toBe(204);
    // 07 §2: 제출 경로가 아니라 응답 뒤에 돈다. 응답 시점에는 아직 없다.
    expect(await drafts()).toEqual([]);

    await runScheduled();

    const reportId = await reportIdOf(letter.id);
    expect(await drafts()).toEqual([
      {
        action: "report_draft",
        // 최종 판정(`report_upheld`·`report_dismissed`)과 같은 키로 묶인다 — 07 §7 5번.
        target_id: String(reportId),
        note: "[targeting] 저격·비방 · 신뢰도 medium — 제3자가 알아볼 수 있고 부정적이다.",
      },
    ]);

    // 큐가 읽는 자리(`src/lib/admin/queue.ts`)에 그대로 뜬다.
    const queue = await loadQueue();
    const queued = queue.reports.find((row) => row.id === reportId);
    expect(queued?.draft).toBe(
      "[targeting] 저격·비방 · 신뢰도 medium — 제3자가 알아볼 수 있고 부정적이다.",
    );
  });

  it("미루는 사이에 작성자가 지운 편지에는 만들지 않는다", async () => {
    const { letter } = await insertLetter({ body: BODY });
    const stub = stubFetch([
      () => structured({ row: "spam", rationale: "광고다.", confidence: "high" }),
    ]);

    await report(letter.id, "spam");
    await deleteByAuthor(letter.id);
    await runScheduled();

    expect(stub.calls).toHaveLength(0);
    expect(await drafts()).toEqual([]);
  });
});

describe("초안이 실패해도 신고 처리는 그대로다 (07 §2)", () => {
  it("분류기가 죽어도 접수 · 자동 비공개 · 텔레그램이 정상이다", async () => {
    const { letter } = await insertLetter({ body: BODY });
    stubFetch([abortError]);

    // D-025의 심각 카테고리 — 자동 비공개와 텔레그램이 함께 걸리는 경로다.
    expect((await report(letter.id, "doxx")).status).toBe(204);

    // 신고 행과 자동 비공개는 초안과 무관하게 응답 전에 이미 끝나 있다.
    expect(await statusOf(letter.id)).toBe("hidden_auto");
    const reportId = await reportIdOf(letter.id);
    expect(reportId).toBeGreaterThan(0);

    await runScheduled();

    // D-034 6 — 넘어가는 것은 편지 ID가 아니라 신고 행 번호다.
    expect(mocks.telegram.notifySevereReport).toHaveBeenCalledWith({
      reason: "doxx",
      reportId,
    });
    expect(mocks.email.notifyAutoHidden).toHaveBeenCalledWith(letter.id);
    // 초안만 없다. 큐는 "아직 없습니다"를 보여주고 운영자가 본문을 읽는다.
    expect(await drafts()).toEqual([]);
    const queue = await loadQueue();
    expect(queue.reports.find((row) => row.id === reportId)?.draft).toBeNull();
  });

  it("모델이 판정표 밖의 행을 내도 행을 만들지 않는다", async () => {
    const { letter } = await insertLetter({ body: BODY });
    stubFetch([
      // 07 §2가 금지한 조치를 행 자리에 넣어 온 경우. 스키마가 거른다.
      () =>
        structured({ row: "delete_now", rationale: "삭제", confidence: "high" }),
    ]);

    expect((await report(letter.id, "other")).status).toBe(204);
    await expect(runScheduled()).resolves.toBeUndefined();

    expect(await drafts()).toEqual([]);
    expect(await statusOf(letter.id)).toBe("hidden_auto");
  });
});

describe("비용 상한 (05-api §1 「끄는 순서」)", () => {
  it("상한에 닿으면 초안은 건너뛰고 등급 판정은 살아 있다", async () => {
    // 큐 초안은 상한의 85%, 등급 판정은 100%에서 끊긴다 (budget.ts RESERVE_FRACTION).
    await query(
      `insert into app_settings (key, value) values ($1, to_jsonb($2::numeric))
       on conflict (key) do update set value = to_jsonb($2::numeric)`,
      [`classifier_spend:${spendDayKey(new Date())}`, DAILY_CAP_USD * 0.9],
    );

    const { letter } = await insertLetter({ body: BODY });
    const draftStub = stubFetch([
      () =>
        structured({
          row: "doxx",
          rationale: "연락처가 있다.",
          confidence: "high",
        }),
    ]);

    await report(letter.id, "doxx");
    await runScheduled();

    // 호출 자체가 나가지 않는다. 초안은 없어도 안전 정책이 그대로다.
    expect(draftStub.calls).toHaveLength(0);
    expect(await drafts()).toEqual([]);

    // 같은 상한에서 등급 판정은 여전히 돈다 — 꺼지면 그 시간대 편지가 전부 medium으로
    // 강등된다(D-015). 그래서 마지막까지 살린다.
    const gradeStub = stubFetch([
      () => structured({ risk: "low", flags: [], notice: null }),
    ]);
    const { classify } = await import("@/lib/safety/classifier");
    expect(await classify({ mode: "open", relationship: "ex", body: BODY })).toEqual(
      { state: "ok", risk: "low", flags: [] },
    );
    expect(gradeStub.calls).toHaveLength(1);
  });
});

describe("초안에 본문이 들어가지 않는다 (L-007 · 09 §3와 같은 이유)", () => {
  it("근거가 본문을 인용하면 문장을 버리고 행·신뢰도만 남긴다", async () => {
    const { letter } = await insertLetter({ body: BODY });
    stubFetch([
      () =>
        structured({
          row: "doxx",
          // 모델이 프롬프트를 어기고 본문을 그대로 옮긴 경우.
          rationale: `본문에 "3반이었고 늘 창가에 앉았다"가 그대로 있다.`,
          confidence: "high",
        }),
    ]);

    await report(letter.id, "doxx");
    await runScheduled();

    const [row] = await drafts();
    expect(row?.note).toBe(
      "[doxx] 신상 노출 · 신뢰도 high — 근거 문장이 본문을 인용해 저장하지 않았습니다. 본문을 직접 읽고 판정합니다.",
    );
  });

  it("저장된 초안에 본문 · 단서의 어떤 조각도 남지 않는다", async () => {
    // 잠긴 편지 — 단서와 질문도 분류기가 읽는 입력이라 같은 검사를 받는다.
    const id = randomLetterId();
    const { letter } = await insertLetter({
      id,
      body: BODY,
      mode: "locked",
      hint: HINT,
      question: "그날 들어간 카페 이름은?",
      answerHmac: answerHmac(id, "스타벅스"),
    });
    stubFetch([
      () =>
        structured({
          row: "doxx",
          rationale: "단서에 지역과 시점이 있어 소속 특정이 가능하다.",
          confidence: "medium",
        }),
    ]);

    await report(letter.id, "doxx");
    await runScheduled();

    const [row] = await drafts();
    const note = (row?.note ?? "").replace(/\s+/gu, "");
    for (const source of [BODY, HINT]) {
      const text = source.replace(/\s+/gu, "");
      for (let i = 0; i + 8 <= text.length; i += 1) {
        expect(note).not.toContain(text.slice(i, i + 8));
      }
    }
    // 판정 자체는 남아 있다 — 버리는 것은 인용된 문장뿐이다.
    expect(row?.note).toContain("[doxx]");
    expect(row?.note).toContain("신뢰도 medium");
  });
});
