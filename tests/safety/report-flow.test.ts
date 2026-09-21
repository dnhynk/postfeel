// 신고 표면 — POST /api/letters/:id/report
//
// 안전 회귀 테스트. 기능 테스트가 아니라 **배포를 막는 테스트**다.

import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { POST } from "@/app/api/letters/[id]/report/route";
import { insertLetter } from "../fixtures/letters.ts";

/**
 * fp는 IP + User-Agent로 만든다 (05-api §5). 테스트마다 UA를 달리해 신고 20/24시간
 * 한도가 파일 안에서 서로에게 새지 않게 한다.
 */
let uaCounter = 0;

function report(letterId: string, reason: string): Promise<Response> {
  uaCounter += 1;
  return POST(
    new Request(`http://localhost/api/letters/${letterId}/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `safety-report-${uaCounter}`,
      },
      body: JSON.stringify({ reason }),
    }),
    { params: Promise.resolve({ id: letterId }) },
  );
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await query<{ status: string }>(
    "select status from letters where id = $1",
    [id],
  );
  if (!rows[0]) throw new Error("편지가 없다.");
  return rows[0].status;
}

// docs/05-api.md §7 #7 · docs/02-threat-model.md §4 · docs/04-data-model.md §3
describe("safety#7 · 신고 1건으로 status가 hidden_auto가 된다", () => {
  // 사람 판단 없이 즉시 비공개. 판정은 그 다음에 한다. 되돌릴 수 있는 조치라
  // 오작동 비용이 낮다.
  it("신고 1건이 접수되면 편지가 즉시 hidden_auto가 된다", async () => {
    const { letter } = await insertLetter();
    expect(letter.status).toBe("published");

    const response = await report(letter.id, "targeting");
    expect(response.status).toBe(204);

    // 운영자가 아무것도 하지 않은 상태에서 이미 내려가 있어야 한다.
    expect(await statusOf(letter.id)).toBe("hidden_auto");

    const { rows } = await query<{ reason: string; status: string }>(
      "select reason, status from reports where letter_id = $1",
      [letter.id],
    );
    expect(rows).toEqual([{ reason: "targeting", status: "pending" }]);
  });
});

// docs/05-api.md §7 #8 · docs/00-decisions.md D-025 · docs/04-data-model.md §3
describe("safety#8 · auto_hide_exempt 편지는 일반 신고에는 published를 유지하고 심각 카테고리에는 hidden_auto가 된다", () => {
  // 심각 카테고리 = reason in ('doxx','sexual','selfharm'). S-5가 S-8을 이긴다.
  it("exempt 편지에 targeting·impersonation·spam·other 신고가 와도 published다", async () => {
    for (const reason of ["targeting", "impersonation", "spam", "other"]) {
      const { letter } = await insertLetter({ autoHideExempt: true });

      const response = await report(letter.id, reason);
      expect(response.status).toBe(204);

      // 편지는 그대로 있고 신고는 큐에만 쌓인다 (04 §3).
      expect(await statusOf(letter.id)).toBe("published");
      const { rows } = await query(
        "select 1 from reports where letter_id = $1 and status = 'pending'",
        [letter.id],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("exempt 편지에 doxx·sexual·selfharm 신고가 오면 hidden_auto가 된다", async () => {
    for (const reason of ["doxx", "sexual", "selfharm"]) {
      const { letter } = await insertLetter({ autoHideExempt: true });

      const response = await report(letter.id, reason);
      expect(response.status).toBe(204);

      // exempt를 뚫는다 (D-025). exempt 값 자체는 건드리지 않는다 — 판정 이력이다.
      const { rows } = await query<{
        status: string;
        auto_hide_exempt: boolean;
      }>("select status, auto_hide_exempt from letters where id = $1", [
        letter.id,
      ]);
      expect(rows[0]).toEqual({
        status: "hidden_auto",
        auto_hide_exempt: true,
      });
    }
  });
});
