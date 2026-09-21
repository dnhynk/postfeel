// src/lib/safety/budget.ts — 일일 비용 상한 $5 (D-020 · 05-api §1)

import { afterEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import {
  checkBudget,
  DAILY_CAP_USD,
  estimateCostUsd,
  recordSpend,
  spendDayKey,
  spentTodayUsd,
} from "@/lib/safety/budget";

async function setSpend(amount: number, now: Date): Promise<void> {
  await query(
    `insert into app_settings (key, value) values ($1, to_jsonb($2::numeric))
     on conflict (key) do update set value = to_jsonb($2::numeric)`,
    [`classifier_spend:${spendDayKey(now)}`, amount],
  );
}

afterEach(async () => {
  await query("delete from app_settings where key like 'classifier_spend:%'");
});

describe("비용 계산", () => {
  it("입력·캐시된 입력·출력에 각각 다른 단가를 쓴다", () => {
    // gpt-5.6-luna: 입력 $0.20 / 캐시된 입력 $0.02 / 출력 $1.20 per 1M
    const cost = estimateCostUsd({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.4, 10);
  });

  it("캐시된 입력은 표준 입력에서 빼고 싼 단가로 센다", () => {
    const cost = estimateCostUsd({
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.02, 10);
  });

  it("05-api §1의 추정치와 자릿수가 맞는다 — 편지 한 통 약 $0.001", () => {
    const cost = estimateCostUsd({
      inputTokens: 4_000,
      cachedInputTokens: 0,
      outputTokens: 150,
    });
    expect(cost).toBeGreaterThan(0.0005);
    expect(cost).toBeLessThan(0.002);
  });
});

describe("누적", () => {
  it("행이 없으면 0이다", async () => {
    expect(await spentTodayUsd(new Date())).toBe(0);
  });

  it("여러 번 쓰면 더해진다", async () => {
    const now = new Date();
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    await recordSpend(usage, now);
    await recordSpend(usage, now);
    expect(await spentTodayUsd(now)).toBeCloseTo(0.4, 10);
  });

  it("동시에 쓴 값이 서로를 덮지 않는다 — upsert 한 문장이라 read-modify-write가 없다", async () => {
    const now = new Date();
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    await Promise.all(Array.from({ length: 5 }, () => recordSpend(usage, now)));
    expect(await spentTodayUsd(now)).toBeCloseTo(1.0, 10);
  });

  it("날짜가 다르면 키가 다르다 — 상한이 매일 리셋된다", async () => {
    const today = new Date("2026-08-14T05:00:00Z");
    const tomorrow = new Date("2026-08-15T05:00:00Z");
    await recordSpend(
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
      today,
    );
    expect(await spentTodayUsd(today)).toBeCloseTo(0.2, 10);
    expect(await spentTodayUsd(tomorrow)).toBe(0);
  });

  it("하루 경계는 KST다", async () => {
    // 2026-08-14 15:30 UTC = 2026-08-15 00:30 KST
    expect(spendDayKey(new Date("2026-08-14T14:30:00Z"))).toBe("2026-08-14");
    expect(spendDayKey(new Date("2026-08-14T15:30:00Z"))).toBe("2026-08-15");
  });
});

describe("끄는 순서: 표기 변형 → 큐 초안 → 등급 판정 (05-api §1)", () => {
  it("상한 아래에서는 셋 다 통과한다", async () => {
    const now = new Date();
    await setSpend(0.5, now);
    expect(await checkBudget("variants", now)).toBe(true);
    expect(await checkBudget("report_draft", now)).toBe(true);
    expect(await checkBudget("grade", now)).toBe(true);
  });

  it("표기 변형이 가장 먼저 꺼진다", async () => {
    const now = new Date();
    await setSpend(DAILY_CAP_USD * 0.75, now);
    expect(await checkBudget("variants", now)).toBe(false);
    expect(await checkBudget("report_draft", now)).toBe(true);
    expect(await checkBudget("grade", now)).toBe(true);
  });

  it("다음이 큐 초안이다", async () => {
    const now = new Date();
    await setSpend(DAILY_CAP_USD * 0.9, now);
    expect(await checkBudget("variants", now)).toBe(false);
    expect(await checkBudget("report_draft", now)).toBe(false);
    expect(await checkBudget("grade", now)).toBe(true);
  });

  it("등급 판정이 마지막까지 살아 있다 — 상한에 닿아야 꺼진다", async () => {
    const now = new Date();
    await setSpend(DAILY_CAP_USD, now);
    expect(await checkBudget("grade", now)).toBe(false);
  });
});
