// 격리 — D-028 · migrations/0005 · src/lib/letters/deletion.ts
//
// 25번(완전 파기)과 같은 종류의 실패를 잰다: **격리했다고 적혀 있는데 본문이 letters에
// 그대로 남아 있는 상태.** 화면으로는 보이지 않는다 — 편지는 정상적으로 내려가 있고
// 판정 화면도 본문을 보여주기 때문이다. 다른 점은 파기가 아니라 이동이라, 되돌릴 수
// 있어야 한다는 것까지 함께 재야 한다.

import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { POST } from "@/app/api/letters/[id]/report/route";
import { resolveReport } from "@/lib/admin/queue";
import { insertLetter, sha256 } from "../fixtures/letters.ts";

let uaCounter = 0;

function report(letterId: string, reason: string): Promise<Response> {
  uaCounter += 1;
  return POST(
    new Request(`http://localhost/api/letters/${letterId}/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `safety-quarantine-${uaCounter}`,
      },
      body: JSON.stringify({ reason }),
    }),
    { params: Promise.resolve({ id: letterId }) },
  );
}

interface LetterContent {
  body: string | null;
  hint: string | null;
  question: string | null;
  answer_hmac: Buffer | null;
  answer_variant_hmacs: Buffer[];
  quarantined_at: Date | null;
}

async function contentOf(id: string): Promise<LetterContent> {
  const { rows } = await query<LetterContent>(
    `select body, hint, question, answer_hmac, answer_variant_hmacs, quarantined_at
       from letters where id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error("편지가 없다.");
  return rows[0];
}

const LOCKED = {
  mode: "locked" as const,
  body: "격리되어야 하는 본문이다",
  hint: "우리가 자주 가던 골목",
  question: "거기 카페 이름은?",
  answerHmac: sha256("스타벅스"),
  answerVariantHmacs: [sha256("스벅")],
};

// docs/05-api.md §7 #27 · docs/00-decisions.md D-028 · docs/04-data-model.md §3
describe("safety#27 · 격리된 편지의 본문이 letters에 남아 있지 않다", () => {
  it("심각 카테고리 신고 후 letters의 본문 계열이 전부 비고 quarantine에 한 행이 생긴다", async () => {
    const { letter } = await insertLetter(LOCKED);

    expect((await report(letter.id, "doxx")).status).toBe(204);

    const row = await contentOf(letter.id);
    expect(row.quarantined_at).not.toBeNull();
    expect(row.body).toBeNull();
    expect(row.hint).toBeNull();
    expect(row.question).toBeNull();
    expect(row.answer_hmac).toBeNull();
    expect(row.answer_variant_hmacs).toEqual([]);

    const { rows } = await query<{ count: string }>(
      "select count(*) as count from quarantine.letter_content where letter_id = $1",
      [letter.id],
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(1);
  });

  it("격리된 본문이 평문으로 저장되지 않는다", async () => {
    const { letter } = await insertLetter(LOCKED);
    await report(letter.id, "sexual");

    const { rows } = await query<{ dump: string }>(
      `select letter_content::text as dump
         from quarantine.letter_content where letter_id = $1`,
      [letter.id],
    );
    expect(rows[0]?.dump).toBeDefined();
    expect(rows[0]?.dump).not.toContain(LOCKED.body);
    expect(rows[0]?.dump).not.toContain(LOCKED.hint);
    expect(rows[0]?.dump).not.toContain(LOCKED.question);
  });

  it("일반 신고는 격리하지 않는다", async () => {
    // 신고 넷은 대부분 dismiss된다. 전부 옮기면 판정 화면이 매번 복호를 탄다
    // (migrations/0005 주석). 대상 범위가 바뀌면 이 단언이 먼저 깨져야 한다.
    const { letter } = await insertLetter(LOCKED);

    await report(letter.id, "targeting");

    const row = await contentOf(letter.id);
    expect(row.quarantined_at).toBeNull();
    expect(row.body).toBe(LOCKED.body);
  });
});

describe("격리는 되돌릴 수 있다 (D-028 종결 ② 복원)", () => {
  it("dismiss하면 본문·단서·질문·답 해시·변형 해시가 정확히 되돌아온다", async () => {
    const { letter } = await insertLetter(LOCKED);
    await report(letter.id, "doxx");
    expect((await contentOf(letter.id)).body).toBeNull();

    const { rows } = await query<{ id: string }>(
      "select id from reports where letter_id = $1",
      [letter.id],
    );
    expect(await resolveReport(Number(rows[0]!.id), "dismiss", null)).toBe("ok");

    const row = await contentOf(letter.id);
    expect(row.quarantined_at).toBeNull();
    expect(row.body).toBe(LOCKED.body);
    expect(row.hint).toBe(LOCKED.hint);
    expect(row.question).toBe(LOCKED.question);
    // bytea 왕복이 깨지면 잠긴 편지가 영영 안 열린다. 값까지 본다.
    expect(row.answer_hmac?.equals(LOCKED.answerHmac)).toBe(true);
    expect(row.answer_variant_hmacs).toHaveLength(1);
    expect(row.answer_variant_hmacs[0]?.equals(LOCKED.answerVariantHmacs[0]!)).toBe(
      true,
    );

    // 복원된 편지는 격리 행을 남기지 않는다.
    const { rows: left } = await query<{ count: string }>(
      "select count(*) as count from quarantine.letter_content where letter_id = $1",
      [letter.id],
    );
    expect(Number(left[0]?.count ?? -1)).toBe(0);
  });
});
