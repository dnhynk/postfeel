// 신고 표면 — `POST /api/letters/:id/report` (05-api §2 · 02 §4 · D-025).
//
// 라우트 핸들러를 직접 부른다. 핸들러가 `Request`와 `Response`만 쓰기 때문에 Next 런타임
// 없이도 그대로 실행된다 (tests/api/manage.test.ts와 같은 방식).

import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { POST } from "@/app/api/letters/[id]/report/route";
import { fpHash } from "@/lib/fingerprint";
import { LIMITS } from "@/lib/ratelimit";
import { insertLetter, randomLetterId } from "../fixtures/letters.ts";

/** UA가 fp를 가른다 (05-api §5). 테스트마다 달리해 20/24시간 한도를 격리한다. */
function post(
  letterId: string,
  body: unknown,
  userAgent = `report-test-${Math.random()}`,
): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/letters/${letterId}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify(body),
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

async function reportCount(letterId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from reports where letter_id = $1",
    [letterId],
  );
  return Number(rows[0]?.count ?? 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("사유 검증 (05-api §2)", () => {
  it("문서에 없는 사유는 400이고 접수되지 않는다", async () => {
    const { letter } = await insertLetter();

    for (const body of [{}, { reason: "" }, { reason: "hate" }, "not-json"]) {
      const response = await post(letter.id, body);
      expect(response.status).toBe(400);
    }
    expect(await reportCount(letter.id)).toBe(0);
    expect(await statusOf(letter.id)).toBe("published");
  });

  it("일곱 사유를 전부 받는다", async () => {
    for (const reason of [
      "doxx",
      "targeting",
      "impersonation",
      "sexual",
      "selfharm",
      "spam",
      "other",
    ]) {
      const { letter } = await insertLetter();
      expect((await post(letter.id, { reason })).status).toBe(204);
      expect(await reportCount(letter.id)).toBe(1);
    }
  });
});

describe("대상 편지 (05-api §2 「상태별 표면 응답」)", () => {
  it("없는 편지는 404다 — 403이 아니다", async () => {
    const response = await post(randomLetterId(), { reason: "spam" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "편지를 찾을 수 없습니다." },
    });
  });

  it("작성자가 지운 편지는 404이고 접수되지 않는다", async () => {
    const { letter } = await insertLetter({ status: "deleted_by_author" });
    expect((await post(letter.id, { reason: "spam" })).status).toBe(404);
    expect(await reportCount(letter.id)).toBe(0);
  });

  it("이미 비공개인 편지도 신고를 받는다 — 건수가 판정 근거다 (07 §2 사칭)", async () => {
    const { letter } = await insertLetter({ status: "hidden_auto" });

    expect((await post(letter.id, { reason: "impersonation" })).status).toBe(
      204,
    );
    expect(await reportCount(letter.id)).toBe(1);
    // 이미 내려가 있으므로 상태는 그대로다.
    expect(await statusOf(letter.id)).toBe("hidden_auto");
  });
});

describe("자동 비공개 (02 §4 · D-025)", () => {
  it("일반 신고는 exempt가 아닌 편지를 내린다", async () => {
    const { letter } = await insertLetter();
    await post(letter.id, { reason: "spam" });
    expect(await statusOf(letter.id)).toBe("hidden_auto");
  });

  it("심각 카테고리는 exempt를 뚫고, 일반 신고는 막힌다", async () => {
    const exempt = await insertLetter({ autoHideExempt: true });
    await post(exempt.letter.id, { reason: "other" });
    expect(await statusOf(exempt.letter.id)).toBe("published");

    await post(exempt.letter.id, { reason: "selfharm" });
    expect(await statusOf(exempt.letter.id)).toBe("hidden_auto");
  });
});

describe("레이트리밋 20 / 24시간 (05-api §5)", () => {
  it("같은 fp의 21번째 신고가 429이고 retryAfter가 붙는다", async () => {
    const userAgent = "report-test-ratelimit";
    const target = await insertLetter();

    for (let i = 0; i < LIMITS.reportPerDay.limit; i += 1) {
      const { letter } = await insertLetter();
      expect((await post(letter.id, { reason: "spam" }, userAgent)).status).toBe(
        204,
      );
    }

    const response = await post(target.letter.id, { reason: "spam" }, userAgent);
    expect(response.status).toBe(429);

    const body = (await response.json()) as {
      error: { code: string; retryAfter: number };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfter).toBeGreaterThan(0);
    expect(body.error.retryAfter).toBeLessThanOrEqual(
      LIMITS.reportPerDay.windowMs / 1000,
    );

    // 한도를 넘긴 요청은 접수되지 않는다 — 편지도 그대로다.
    expect(await reportCount(target.letter.id)).toBe(0);
    expect(await statusOf(target.letter.id)).toBe("published");

    // 다른 fp는 영향받지 않는다.
    expect(
      (await post(target.letter.id, { reason: "spam" }, "report-test-other"))
        .status,
    ).toBe(204);
  });

  it("카운터 테이블 없이 reports.reporter_fp_hash로 센다 (05-api §5)", async () => {
    const userAgent = "report-test-fp";
    const { letter } = await insertLetter();
    await post(letter.id, { reason: "spam" }, userAgent);

    const { rows } = await query<{ reporter_fp_hash: Buffer }>(
      "select reporter_fp_hash from reports where letter_id = $1",
      [letter.id],
    );
    // 헤더가 없으면 IP는 0.0.0.0으로 접힌다 (fingerprint.ts UNKNOWN_IP).
    expect(rows[0]?.reporter_fp_hash).toEqual(fpHash("0.0.0.0", userAgent));
  });
});
