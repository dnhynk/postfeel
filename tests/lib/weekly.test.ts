// 주간 리뷰 7개 지표 — `scripts/weekly.ts` (06-analytics §5 · §6).
//
// **M5의 완료 판정이 "7개 지표가 전부 쿼리로 나온다"이다.** 그래서 이 파일이 재는 것은
// "숫자가 나오는가"가 아니라 **각 지표가 문서의 식과 같은가**다.
//
// 특히 고정하는 셋:
//   1. 순서 — 06 §6이 "매주 같은 숫자를 같은 순서로 본다"고 못박았다
//   2. 북극성의 `l.status='published'` — 나중에 내려간 편지의 열람을 성과로 세지 않는다
//   3. #5 · #7이 02 §7 전환 트리거와 **같은 식**이다 — 식이 갈라지면 발동 여부를 판정할 수 없다

import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { REPORT_DRAFT_ACTION } from "@/lib/admin/queue";
import {
  DELETE_RATE_TRIGGER,
  DRAFT_ACTION,
  REPORT_RATE_TRIGGER,
  countRecentDeletes,
  format,
  formatOperations,
  northStar,
  reportDraftAgreement,
  weeklyReview,
} from "../../scripts/weekly.ts";
import { insertLetter, randomFpHash } from "../fixtures/letters.ts";

/** `@/lib/db`의 `query`가 그대로 `Queryable`이다 — CLI는 `pg.Client`를 넘긴다. */
const db = { query };

let unlockSeq = 0;

async function unlock(
  letterId: string,
  response: "yes" | "no" | "unknown",
  daysAgo: number,
): Promise<void> {
  unlockSeq += 1;
  await query(
    `insert into unlocks (unlock_id, letter_id, fp_hash, recipient_response, responded_at)
     values ($1, $2, $3, $4, now() - make_interval(days => $5))`,
    [`unlock-${unlockSeq}`, letterId, randomFpHash(), response, daysAgo],
  );
}

async function event(
  name: string,
  props: Record<string, unknown> = {},
  times = 1,
  daysAgo = 1,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await query(
      `insert into events (name, session_id, props, created_at)
       values ($1, $2, $3, now() - make_interval(days => $4))`,
      [name, `s-${name}-${i}`, JSON.stringify(props), daysAgo],
    );
  }
}

beforeEach(async () => {
  await query("delete from events");
  await query("delete from unlocks");
});

describe("#1 북극성 (06 §5)", () => {
  it("published 편지의 yes 응답만 센다", async () => {
    const { letter: live } = await insertLetter();
    const { letter: hiddenAuto } = await insertLetter({ status: "hidden_auto" });
    const { letter: hiddenAdmin } = await insertLetter({
      status: "hidden_admin",
    });
    const { letter: deleted } = await insertLetter({
      status: "deleted_by_author",
    });

    await unlock(live.id, "yes", 1);
    // 나중에 내려간 편지의 열람은 성과가 아니다 (06 §5 · 01 「안전하게」).
    await unlock(hiddenAuto.id, "yes", 1);
    await unlock(hiddenAdmin.id, "yes", 1);
    await unlock(deleted.id, "yes", 1);

    expect(await northStar(db)).toBe(1);
  });

  it("yes가 아닌 응답과 무응답은 세지 않는다", async () => {
    const { letter } = await insertLetter();
    const { letter: other } = await insertLetter();
    const { letter: third } = await insertLetter();

    await unlock(letter.id, "yes", 1);
    await unlock(other.id, "no", 1);
    await unlock(third.id, "unknown", 1);

    expect(await northStar(db)).toBe(1);
  });

  it("주간 창 밖의 응답은 세지 않는다", async () => {
    const { letter } = await insertLetter();
    const { letter: old } = await insertLetter();

    await unlock(letter.id, "yes", 6);
    await unlock(old.id, "yes", 8);

    expect(await northStar(db)).toBe(1);
  });
});

describe("#7 분자 — letter_deleted(ageHours<24) (06 §6 · 02 §7)", () => {
  it("24시간 미만만 센다", async () => {
    await event("letter_deleted", { ageHours: 0.5 });
    await event("letter_deleted", { ageHours: 23.9 });
    await event("letter_deleted", { ageHours: 24 });
    await event("letter_deleted", { ageHours: 900 });

    expect(await countRecentDeletes(db)).toBe(2);
  });

  it("ageHours가 없거나 숫자가 아니면 세지 않는다 — 나이를 모르는 삭제로 트리거를 발동시키지 않는다", async () => {
    await event("letter_deleted", {});
    await event("letter_deleted", { ageHours: "3" });
    await event("letter_deleted", { ageHours: 1 });

    // 문자열이 섞여도 던지지 않는다. 주간 리뷰 전체가 죽으면 안 된다.
    expect(await countRecentDeletes(db)).toBe(1);
  });
});

describe("일곱 개 (06 §6)", () => {
  it("문서 순서 그대로 나온다 — 순서가 계약이다", async () => {
    const review = await weeklyReview(db);

    expect(review.metrics.map((metric) => metric.no)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(review.metrics.map((metric) => metric.formula)).toEqual([
      "unlocks.recipient_response='yes' ∧ letters.status='published' (06 §5)",
      "letter_created / feed_view",
      "letter_view(source=link) / letter_view",
      "post_unlock_continue / recipient_response",
      "report_submitted / letter_created",
      "filter_revised / filter_warned",
      "letter_deleted(ageHours<24) / letter_created",
    ]);
  });

  it("문서의 식대로 계산한다", async () => {
    const { letter } = await insertLetter();
    await unlock(letter.id, "yes", 1);

    await event("feed_view", { filter: "all" }, 10);
    await event("letter_created", { mode: "open", risk: "low" }, 5);
    await event("letter_view", { source: "feed" }, 5);
    await event("letter_view", { source: "link" }, 3);
    await event("recipient_response", { response: "no" }, 4);
    await event("post_unlock_continue", { response: "no", target: "write" }, 2);
    await event("report_submitted", { reason: "spam" }, 1);
    await event("filter_warned", { risk: "medium" }, 4);
    await event("filter_revised", { risk: "medium" }, 2);
    await event("letter_deleted", { ageHours: 3 }, 1);
    await event("letter_deleted", { ageHours: 100 }, 1);

    const { metrics } = await weeklyReview(db);

    expect(metrics[0]?.count).toBe(1);
    expect(metrics[1]?.ratio).toEqual({
      numerator: 5,
      denominator: 10,
      value: 0.5,
    });
    // 링크 유입 비중 — 분모는 letter_view 전체(8)다.
    expect(metrics[2]?.ratio).toEqual({
      numerator: 3,
      denominator: 8,
      value: 3 / 8,
    });
    expect(metrics[3]?.ratio).toEqual({
      numerator: 2,
      denominator: 4,
      value: 0.5,
    });
    expect(metrics[4]?.ratio).toEqual({
      numerator: 1,
      denominator: 5,
      value: 0.2,
    });
    expect(metrics[5]?.ratio).toEqual({
      numerator: 2,
      denominator: 4,
      value: 0.5,
    });
    // ageHours 100은 빠진다.
    expect(metrics[6]?.ratio).toEqual({
      numerator: 1,
      denominator: 5,
      value: 0.2,
    });
  });

  it("주간 창 밖의 이벤트는 세지 않는다", async () => {
    await event("feed_view", {}, 3, 2);
    await event("feed_view", {}, 5, 9);

    const { metrics } = await weeklyReview(db);

    expect(metrics[1]?.ratio?.denominator).toBe(3);
  });

  it("분모가 0이면 비율은 null이다 — 0%가 아니다", async () => {
    const { metrics } = await weeklyReview(db);

    for (const metric of metrics.slice(1)) {
      expect(metric.ratio).toEqual({
        numerator: 0,
        denominator: 0,
        value: null,
      });
    }
    // 없는 비율을 0%로 적으면 없는 신호가 된다. 트리거도 발동시키지 않는다.
    expect(metrics[4]?.trigger?.exceeded).toBe(false);
    expect(metrics[6]?.trigger?.exceeded).toBe(false);
  });
});

describe("전환 트리거 (02 §7 — 06 §6과 같은 식)", () => {
  it("임계값이 위협 모델의 수치와 같다", () => {
    expect(REPORT_RATE_TRIGGER).toBe(0.03);
    expect(DELETE_RATE_TRIGGER).toBe(0.05);
  });

  it("신고율이 3%를 넘으면 표시된다", async () => {
    await event("letter_created", {}, 100);
    await event("report_submitted", { reason: "spam" }, 3);

    const under = await weeklyReview(db);
    expect(under.metrics[4]?.ratio?.value).toBe(0.03);
    // "초과"다. 같은 값은 아직 발동이 아니다.
    expect(under.metrics[4]?.trigger?.exceeded).toBe(false);

    await event("report_submitted", { reason: "spam" }, 1);
    const over = await weeklyReview(db);
    expect(over.metrics[4]?.trigger?.exceeded).toBe(true);
  });

  it("24시간 내 삭제율이 5%를 넘으면 표시된다", async () => {
    await event("letter_created", {}, 100);
    await event("letter_deleted", { ageHours: 1 }, 5);

    const under = await weeklyReview(db);
    expect(under.metrics[6]?.trigger?.exceeded).toBe(false);

    await event("letter_deleted", { ageHours: 1 }, 1);
    const over = await weeklyReview(db);
    expect(over.metrics[6]?.trigger?.exceeded).toBe(true);
  });
});

describe("출력", () => {
  it("일곱 개를 순서대로 찍고 한계를 함께 찍는다 (06 §6)", async () => {
    await event("letter_created", {}, 100);
    await event("report_submitted", { reason: "spam" }, 10);

    const text = format(await weeklyReview(db));

    // 번호가 순서대로 나온다.
    const order = [...text.matchAll(/^(\d)\. /gm)].map((match) => match[1]);
    expect(order).toEqual(["1", "2", "3", "4", "5", "6", "7"]);

    // 숫자만 보면 오해하는 지표라 한계가 같이 나가야 한다.
    expect(text).toContain("코호트가 정확히 일치하지 않는다");
    // 임계값 초과는 눈에 띄어야 한다.
    expect(text).toContain("⚠ 임계값 3.0% 초과");
  });
});

// ── 운영 점검 (07 §7 #5) ───────────────────────────────────
//
// 06 §6의 일곱 개와 **다른 목록이다.** 07 §7의 주간 점검 5번이 요구하는 값이고, 이제
// 신고 접수 시점에 초안이 저장되므로(07 §2 · `src/lib/reports/draft.ts`) 실제로 잴 수
// 있다. 06이 "늘리지 않는다"고 못박은 일곱 개에 여덟 번째로 끼워 넣지 않는다.

/** 신고 한 건 + 최종 판정 + (선택) 초안 한 줄. */
async function resolvedReport(options: {
  row: string | null;
  status: "upheld" | "dismissed" | "pending";
  daysAgo?: number;
  note?: string;
}): Promise<void> {
  const { letter } = await insertLetter();
  const { rows } = await query<{ id: string }>(
    `insert into reports (letter_id, reason, reporter_fp_hash, status, resolved_at)
     values ($1, 'other', $2, $3,
             case when $3 = 'pending' then null
                  else now() - make_interval(days => $4) end)
     returning id`,
    [letter.id, randomFpHash(), options.status, options.daysAgo ?? 1],
  );
  const reportId = rows[0]?.id;
  if (reportId === undefined) throw new Error("신고 행이 없다.");

  if (options.row === null && options.note === undefined) return;
  await query(
    "insert into admin_actions (action, target_id, note) values ($1, $2, $3)",
    [
      DRAFT_ACTION,
      reportId,
      options.note ?? `[${options.row}] 라벨 · 신뢰도 medium — 근거 한 줄.`,
    ],
  );
}

describe("07 §7 #5 — 초안 vs 최종 판정", () => {
  beforeEach(async () => {
    await query("delete from admin_actions");
    await query("delete from reports");
    await query("delete from letters");
  });

  it("action 값이 큐가 쓰는 상수와 같다", () => {
    // weekly.ts는 별칭 import를 쓸 수 없어 문자열을 다시 적는다. 갈라지면 지표가 0이 된다.
    expect(DRAFT_ACTION).toBe(REPORT_DRAFT_ACTION);
  });

  it("어긋난 건은 초안 행이 other인데 위반, 또는 행에 걸렸는데 복구다 (07 §2)", async () => {
    await resolvedReport({ row: "doxx", status: "upheld" }); // 일치
    await resolvedReport({ row: "other", status: "dismissed" }); // 일치
    await resolvedReport({ row: "targeting", status: "dismissed" }); // 불일치
    await resolvedReport({ row: "other", status: "upheld" }); // 불일치

    const check = await reportDraftAgreement(db);
    expect(check.resolved).toBe(4);
    expect(check.mismatched).toBe(2);
    expect(check.rate.value).toBe(0.5);
    expect(check.rows).toEqual([
      { row: "doxx", upheld: 1, dismissed: 0 },
      { row: "other", upheld: 1, dismissed: 1 },
      { row: "targeting", upheld: 0, dismissed: 1 },
    ]);
  });

  it("초안이 없는 신고와 아직 판정 전인 신고는 분모에 넣지 않는다", async () => {
    await resolvedReport({ row: null, status: "upheld" }); // 초안 없음
    await resolvedReport({ row: "doxx", status: "pending" }); // 판정 전
    await resolvedReport({ row: "spam", status: "upheld" });

    const check = await reportDraftAgreement(db);
    expect(check.resolved).toBe(1);
    expect(check.rows).toEqual([{ row: "spam", upheld: 1, dismissed: 0 }]);
  });

  it("창은 최종 판정 시각으로 자른다 — 지난주 신고를 이번 주에 판정한 건이 잡힌다", async () => {
    await resolvedReport({ row: "doxx", status: "upheld", daysAgo: 2 });
    await resolvedReport({ row: "doxx", status: "upheld", daysAgo: 30 });

    expect((await reportDraftAgreement(db)).resolved).toBe(1);
    expect((await reportDraftAgreement(db, 60)).resolved).toBe(2);
  });

  it("note 형식을 못 읽으면 분모에서 빼고 그 사실을 남긴다", async () => {
    await resolvedReport({ row: null, status: "upheld", note: "형식이 다른 한 줄" });
    await resolvedReport({ row: "doxx", status: "upheld" });

    const check = await reportDraftAgreement(db);
    expect(check.resolved).toBe(1);
    expect(check.unknown).toBe(1);
    expect(formatOperations(check)).toContain("note 형식을 읽지 못해");
  });

  it("비율 옆에 분모를 찍고 한계를 함께 찍는다 — 조치는 제안하지 않는다", async () => {
    await resolvedReport({ row: "targeting", status: "dismissed" });
    await resolvedReport({ row: "doxx", status: "upheld" });
    await resolvedReport({ row: "doxx", status: "upheld" });

    const text = formatOperations(await reportDraftAgreement(db));

    // 분모 없이 비율만 보면 3건 중 1건이 33%로 읽힌다.
    expect(text).toContain("(1 / 3)");
    expect(text).toContain("초안이 붙은 채로 판정이 끝난 신고: 3건");
    // 어느 행이 안 맞는지가 같이 나온다.
    expect(text).toContain("targeting");
    expect(text).toContain("uphold 2 · dismiss 0");
    // 조건부 행 때문에 비율이 부푸는 것을 숨기지 않는다.
    expect(text).toContain("과대 계상된다");
    // 07 §7의 운영 점검은 06 §6의 일곱 개와 다른 목록이다.
    expect(text).toContain("별개 목록");
    // 07 §2 · D-012 — 코드가 조치를 제안하지 않는다.
    expect(text).not.toContain("삭제");
    expect(text).not.toContain("권장");
  });

  it("판정한 건이 없으면 0%가 아니라 '분모 0'이다", async () => {
    const check = await reportDraftAgreement(db);
    expect(check.rate.value).toBeNull();
    expect(formatOperations(check)).toContain("분모 0");
  });
});
