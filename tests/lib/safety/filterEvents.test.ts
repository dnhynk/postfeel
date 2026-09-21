// src/lib/safety/filterEvents.ts — 04 §2 `filter_events`
//
// 여기서 확인하는 것은 두 가지다: 세 `outcome`이 문서대로 동작하는가, 그리고 **편지
// 내용이 들어갈 자리가 없는가** (04 「저장하지 않는 것」).

import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import {
  markFilterEventPublished,
  recordFilterEvent,
} from "@/lib/safety/filterEvents";

describe("recordFilterEvent", () => {
  it("한 행을 넣고 id를 돌려준다 — confirmation의 filterEventId가 된다", async () => {
    const id = await recordFilterEvent({
      risk: "medium",
      flags: [{ kind: "school", field: "body" }],
      mode: "open",
      outcome: "warned",
    });

    expect(typeof id).toBe("number");

    const { rows } = await query<{
      risk_level: string;
      flags: unknown;
      mode: string;
      outcome: string;
    }>("select risk_level, flags, mode, outcome from filter_events where id = $1", [
      id,
    ]);

    expect(rows[0]).toEqual({
      risk_level: "medium",
      flags: [{ kind: "school", field: "body" }],
      mode: "open",
      outcome: "warned",
    });
  });

  it("high는 blocked로 남는다 — 편지는 저장되지 않고 이 행만 남는다", async () => {
    const id = await recordFilterEvent({
      risk: "high",
      flags: [{ kind: "contact", field: "hint" }],
      mode: "locked",
      outcome: "blocked",
    });

    const { rows } = await query<{ outcome: string }>(
      "select outcome from filter_events where id = $1",
      [id],
    );
    expect(rows[0].outcome).toBe("blocked");
  });

  it("플래그가 없어도 넣는다 — low 즉시 게시", async () => {
    const id = await recordFilterEvent({
      risk: "low",
      flags: [],
      mode: "open",
      outcome: "published",
    });
    const { rows } = await query<{ flags: unknown }>(
      "select flags from filter_events where id = $1",
      [id],
    );
    expect(rows[0].flags).toEqual([]);
  });
});

describe("markFilterEventPublished — warned → published (05-api §1)", () => {
  it("인터스티셜을 보고 강행한 재제출을 published로 올린다", async () => {
    const id = await recordFilterEvent({
      risk: "medium",
      flags: [{ kind: "company", field: "body" }],
      mode: "open",
      outcome: "warned",
    });

    expect(await markFilterEventPublished(id)).toBe(true);

    const { rows } = await query<{ outcome: string }>(
      "select outcome from filter_events where id = $1",
      [id],
    );
    expect(rows[0].outcome).toBe("published");
  });

  it("blocked 행은 뒤집지 않는다 — 관측되지 않은 사실을 만들지 않는다", async () => {
    const id = await recordFilterEvent({
      risk: "high",
      flags: [{ kind: "url", field: "body" }],
      mode: "open",
      outcome: "blocked",
    });

    expect(await markFilterEventPublished(id)).toBe(false);

    const { rows } = await query<{ outcome: string }>(
      "select outcome from filter_events where id = $1",
      [id],
    );
    expect(rows[0].outcome).toBe("blocked");
  });

  it("없는 id면 false다 — 편지 생성을 실패시킬 이유가 되지 않는다", async () => {
    expect(await markFilterEventPublished(2_147_483_647)).toBe(false);
  });
});

describe("편지 내용이 들어갈 자리가 없다 (04 「저장하지 않는 것」)", () => {
  it("filter_events에는 텍스트 컬럼이 통계용 셋뿐이다", async () => {
    const { rows } = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'filter_events' order by ordinal_position`,
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      "id",
      "risk_level",
      "flags",
      "mode",
      "outcome",
      "created_at",
    ]);
  });
});
