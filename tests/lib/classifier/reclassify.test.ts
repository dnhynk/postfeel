// src/lib/safety/reclassify.ts — 재분류 잡 (05-api §1 「재분류 잡」)
//
// 이 잡이 없으면 장애 1시간이 그 시간대 편지 전부를 영구히 피드에서 제외한다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, withTransaction } from "@/lib/db";
import { insertLetter } from "../../fixtures/letters";
import { abortError, refusal, structured, stubFetch } from "./fake-openai";
import { loadReclassify } from "./load";

let runReclassifyJob: typeof import("@/lib/safety/reclassify").runReclassifyJob;

interface LetterState {
  risk_level: string;
  risk_flags: unknown;
  classifier_state: string;
  classifier_retry_count: number;
  status: string;
}

async function stateOf(id: string): Promise<LetterState> {
  const { rows } = await query<LetterState>(
    `select risk_level, risk_flags, classifier_state, classifier_retry_count, status
       from letters where id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error("편지가 없다.");
  return rows[0];
}

/** 분류기 장애로 medium 강등된 편지 — 재분류 잡의 대상 (D-015). */
async function insertPending(
  overrides: Parameters<typeof insertLetter>[0] = {},
): Promise<string> {
  const { letter } = await insertLetter({
    riskLevel: "medium",
    classifierState: "unavailable",
    ...overrides,
  });
  return letter.id;
}

beforeEach(async () => {
  ({ runReclassifyJob } = await loadReclassify());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await query("delete from admin_actions");
  await query("delete from letters");
  await query("delete from app_settings where key like 'classifier_spend:%'");
});

describe("재분류 · 성공", () => {
  it("low로 판정되면 ok로 바꾸고 피드로 승격한다", async () => {
    const id = await insertPending();
    stubFetch([() => structured({ risk: "low", flags: [], notice: null })]);

    const outcome = await runReclassifyJob();

    expect(outcome).toMatchObject({ scanned: 1, promoted: 1 });
    // 피드 노출 조건은 status='published' and risk_level='low' (05-api §2).
    expect(await stateOf(id)).toMatchObject({
      risk_level: "low",
      classifier_state: "ok",
      status: "published",
    });
  });

  it("medium이면 ok로 닫되 피드에는 올리지 않는다", async () => {
    const id = await insertPending();
    stubFetch([
      () =>
        structured({
          risk: "medium",
          flags: [{ kind: "person_name", field: "body" }],
          notice: null,
        }),
    ]);

    const outcome = await runReclassifyJob();

    expect(outcome).toMatchObject({ scanned: 1, settled: 1, promoted: 0 });
    expect(await stateOf(id)).toMatchObject({
      risk_level: "medium",
      classifier_state: "ok",
    });
  });

  it("판정된 flags를 risk_flags에 적는다", async () => {
    const id = await insertPending();
    stubFetch([
      () =>
        structured({
          risk: "medium",
          flags: [{ kind: "school", field: "body" }],
          notice: null,
        }),
    ]);

    await runReclassifyJob();
    expect((await stateOf(id)).risk_flags).toEqual([
      { kind: "school", field: "body" },
    ]);
  });

  it("이미 판정이 끝난 편지는 건드리지 않는다", async () => {
    const { letter } = await insertLetter({ classifierState: "ok" });
    const stub = stubFetch([
      () => structured({ risk: "low", flags: [], notice: null }),
    ]);

    expect(await runReclassifyJob()).toMatchObject({ scanned: 0 });
    expect(stub.calls).toHaveLength(0);
    expect((await stateOf(letter.id)).classifier_state).toBe("ok");
  });
});

describe("재분류 · 실패는 3회까지 (05-api §1)", () => {
  it("실패하면 retry_count만 올리고 unavailable에 둔다", async () => {
    const id = await insertPending();
    stubFetch([abortError]);

    expect(await runReclassifyJob()).toMatchObject({ retried: 1, failed: 0 });
    expect(await stateOf(id)).toMatchObject({
      classifier_state: "unavailable",
      classifier_retry_count: 1,
      risk_level: "medium",
    });
  });

  it("3회 실패하면 failed로 고정하고 medium에 둔다 — 주간 샘플 검수로 넘어간다", async () => {
    const id = await insertPending();
    stubFetch([abortError]);

    await runReclassifyJob();
    await runReclassifyJob();
    const third = await runReclassifyJob();

    expect(third).toMatchObject({ scanned: 1, failed: 1 });
    expect(await stateOf(id)).toMatchObject({
      classifier_state: "failed",
      classifier_retry_count: 3,
      risk_level: "medium",
      status: "published",
    });
  });

  it("failed로 고정된 편지는 다음 회차의 대상이 아니다", async () => {
    await insertPending({ classifierRetryCount: 2 });
    stubFetch([abortError]);

    await runReclassifyJob();
    expect(await runReclassifyJob()).toMatchObject({ scanned: 0 });
  });
});

describe("재분류 · high·거부는 hidden_auto (코디네이터 판정 2026-08-14)", () => {
  it("high로 판정되면 편지를 내린다 — medium에 두면 링크로 계속 읽힌다", async () => {
    const id = await insertPending();
    stubFetch([
      () =>
        structured({
          risk: "high",
          flags: [{ kind: "sexual_minor", field: "body" }],
          notice: null,
        }),
    ]);

    expect(await runReclassifyJob()).toMatchObject({ hidden: 1 });
    expect(await stateOf(id)).toMatchObject({
      status: "hidden_auto",
      // 등급이 아니라 status가 바뀐다. "high는 저장되지 않는다"는 전제는 그대로다.
      risk_level: "medium",
      classifier_state: "ok",
    });
  });

  it("거부도 high와 같은 경로다 — unavailable로 흘리지 않는다", async () => {
    const id = await insertPending();
    stubFetch([() => refusal()]);

    expect(await runReclassifyJob()).toMatchObject({ hidden: 1, retried: 0 });
    expect(await stateOf(id)).toMatchObject({
      status: "hidden_auto",
      classifier_state: "ok",
    });
  });

  it("admin_actions에 근거를 남긴다 — 신고가 아닌데 왜 내려갔는지 알 유일한 경로다", async () => {
    const id = await insertPending();
    stubFetch([
      () =>
        structured({
          risk: "high",
          flags: [{ kind: "threat", field: "body" }],
          notice: null,
        }),
    ]);

    await runReclassifyJob();

    const { rows } = await query<{ action: string; target_id: string; note: string }>(
      "select action, target_id, note from admin_actions",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "reclassify_hide", target_id: id });
    expect(rows[0]?.note).toContain("threat");
  });

  it("auto_hide_exempt를 무시한다 — exempt는 반복 신고 방어이지 필터 면제가 아니다", async () => {
    const id = await insertPending({ autoHideExempt: true });
    stubFetch([
      () =>
        structured({
          risk: "high",
          flags: [{ kind: "sexual_minor", field: "body" }],
          notice: null,
        }),
    ]);

    await runReclassifyJob();
    expect((await stateOf(id)).status).toBe("hidden_auto");
  });

  it("이미 내려간 편지는 다시 내리지 않고 판정만 닫는다", async () => {
    const id = await insertPending({ status: "hidden_admin" });
    stubFetch([
      () =>
        structured({
          risk: "high",
          flags: [{ kind: "threat", field: "hint" }],
          notice: null,
        }),
    ]);

    expect(await runReclassifyJob()).toMatchObject({ hidden: 0, settled: 1 });
    expect(await stateOf(id)).toMatchObject({
      status: "hidden_admin",
      classifier_state: "ok",
    });
    expect(await query("select 1 from admin_actions")).toMatchObject({
      rowCount: 0,
    });
  });
});

describe("재분류 · 대상 선택", () => {
  it("오래된 편지부터 처리하고 배치 크기를 지킨다", async () => {
    const older = await insertPending({
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    await insertPending({ createdAt: new Date("2026-08-02T00:00:00Z") });
    stubFetch([() => structured({ risk: "low", flags: [], notice: null })]);

    expect(await runReclassifyJob({ limit: 1 })).toMatchObject({ scanned: 1 });
    expect((await stateOf(older)).classifier_state).toBe("ok");
  });

  it("letters_classifier_pending 부분 인덱스를 탄다", async () => {
    // 이 인덱스가 없으면 편지가 쌓일수록 10분마다 전체 스캔이다 (0001_init.sql).
    // 행이 적으면 플래너가 seq scan을 고르므로, 인덱스를 **탈 수 있는지**를 보려면
    // seq scan을 끄고 계획을 받는다.
    //
    // 한 트랜잭션 안에서 `set local`로 건다. `query()`는 호출마다 풀에서 커넥션을
    // 새로 잡으므로, 트랜잭션 밖에서 걸면 설정과 explain이 다른 커넥션에 갈 수 있다.
    const plan = await withTransaction(async (client) => {
      await client.query("set local enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(
        `explain select id, mode, relationship, body, hint, question, classifier_retry_count
           from letters
          where classifier_state = 'unavailable'
          order by created_at
          limit 20`,
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("letters_classifier_pending");
  });
});
