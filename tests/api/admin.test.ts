// 운영자 표면 — `/api/admin/*` (05-api §4 · 07 §1 · §2 · §3 · §5).
//
// 라우트 핸들러를 직접 부른다. 인증은 `Request`의 쿠키 헤더로 넘긴다 — 핸들러가
// `next/headers`가 아니라 요청 자체를 보기 때문에 Next 런타임 없이 돈다.

import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { POST as login } from "@/app/api/admin/login/route";
import { GET as queue } from "@/app/api/admin/queue/route";
import { POST as resolveReport } from "@/app/api/admin/reports/[id]/resolve/route";
import { POST as resolveAppeal } from "@/app/api/admin/appeals/[id]/resolve/route";
import { POST as resolveDeletionRequest } from "@/app/api/admin/deletion-requests/[id]/resolve/route";
import { POST as hideLetter } from "@/app/api/admin/letters/[id]/hide/route";
import { POST as settings } from "@/app/api/admin/settings/route";
import { ADMIN_COOKIE, issueSession } from "@/lib/admin/session";
import { LOGIN_FAILURE_LIMIT } from "@/lib/admin/login";
import type { QueueView } from "@/lib/admin/queue";
import { insertLetter, randomLetterId } from "../fixtures/letters.ts";

const PASSWORD = process.env.ADMIN_PASSWORD ?? "";

function loginRequest(password: string, userAgent: string): Promise<Response> {
  return login(
    new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify({ password }),
    }),
  );
}

/** 로그인해서 쿠키 헤더 하나를 얻는다. */
async function sessionCookie(userAgent = "admin-test"): Promise<string> {
  const response = await loginRequest(PASSWORD, userAgent);
  if (response.status !== 204) throw new Error("로그인이 실패했다.");
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Set-Cookie가 없다.");
  return setCookie.split(";")[0]!;
}

function authed(url: string, cookie: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "user-agent": "admin-test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const context = (id: string | number) => ({
  params: Promise.resolve({ id: String(id) }),
});

async function letterRow(id: string) {
  const { rows } = await query<{ status: string; auto_hide_exempt: boolean }>(
    "select status, auto_hide_exempt from letters where id = $1",
    [id],
  );
  return rows[0];
}

async function insertReport(letterId: string, reason = "targeting") {
  const { rows } = await query<{ id: string }>(
    `insert into reports (letter_id, reason, reporter_fp_hash)
     values ($1, $2, $3) returning id`,
    [letterId, reason, Buffer.alloc(32, 1)],
  );
  return Number(rows[0]!.id);
}

async function insertAppeal(letterId: string) {
  const { rows } = await query<{ id: string }>(
    "insert into appeals (letter_id, message) values ($1, $2) returning id",
    [letterId, "잘못된 신고입니다."],
  );
  return Number(rows[0]!.id);
}

async function adminActions(action: string, targetId: string) {
  const { rows } = await query<{ note: string | null }>(
    "select note from admin_actions where action = $1 and target_id = $2",
    [action, targetId],
  );
  return rows;
}

describe("인증 (05-api §4)", () => {
  it("쿠키 없이 부른 운영자 API는 전부 401이다", async () => {
    const { letter } = await insertLetter();
    const responses = await Promise.all([
      queue(new Request("http://localhost/api/admin/queue")),
      resolveReport(
        new Request("http://localhost/api/admin/reports/1/resolve", {
          method: "POST",
          body: JSON.stringify({ action: "dismiss" }),
        }),
        context(1),
      ),
      resolveAppeal(
        new Request("http://localhost/api/admin/appeals/1/resolve", {
          method: "POST",
          body: JSON.stringify({ action: "restore" }),
        }),
        context(1),
      ),
      resolveDeletionRequest(
        new Request("http://localhost/api/admin/deletion-requests/1/resolve", {
          method: "POST",
          body: JSON.stringify({ letterId: letter.id }),
        }),
        context(1),
      ),
      hideLetter(
        new Request(`http://localhost/api/admin/letters/${letter.id}/hide`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        context(letter.id),
      ),
      settings(
        new Request("http://localhost/api/admin/settings", {
          method: "POST",
          body: JSON.stringify({ writingEnabled: false }),
        }),
      ),
    ]);

    for (const response of responses) expect(response.status).toBe(401);
    // 인증 없는 호출은 아무것도 바꾸지 않는다.
    expect((await letterRow(letter.id))?.status).toBe("published");
  });

  it("위조·만료 쿠키로는 통과하지 않는다", async () => {
    const valid = await sessionCookie("admin-test-forge");
    const forged = `${ADMIN_COOKIE}=9999999999.not-a-real-signature`;
    const expired = `${ADMIN_COOKIE}=${issueSession(Date.now() - 8 * 24 * 60 * 60 * 1000)}`;

    expect(
      (await queue(authed("http://localhost/api/admin/queue", forged))).status,
    ).toBe(401);
    expect(
      (await queue(authed("http://localhost/api/admin/queue", expired))).status,
    ).toBe(401);
    expect(
      (await queue(authed("http://localhost/api/admin/queue", valid))).status,
    ).toBe(200);
  });

  it("비밀번호가 틀리면 401이고 5회 / 10분을 넘기면 429다", async () => {
    const userAgent = "admin-test-bruteforce";

    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      const response = await loginRequest("틀린 비밀번호", userAgent);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    // 한도를 넘기면 **맞는 비밀번호도** 막힌다 — 대조까지 가지 않는다.
    const blocked = await loginRequest(PASSWORD, userAgent);
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as {
      error: { code: string; retryAfter: number };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfter).toBeGreaterThan(0);

    // 다른 fp는 잠기지 않는다 — 공격자가 운영자를 잠글 수 없어야 한다 (07 §1).
    expect((await loginRequest(PASSWORD, "admin-test-other-fp")).status).toBe(
      204,
    );
  });
});

describe("GET /api/admin/queue (05-api §4)", () => {
  it("미판정 신고 · 자동 비공개 건 · 이의 제기 · 삭제 요청 넷을 준다", async () => {
    const cookie = await sessionCookie();
    const reported = await insertLetter({ status: "hidden_auto" });
    const reportId = await insertReport(reported.letter.id, "doxx");
    const appealed = await insertLetter({ status: "hidden_admin" });
    const appealId = await insertAppeal(appealed.letter.id);
    await query(
      "insert into deletion_requests (body_excerpt, contact) values ($1, $2)",
      ["그때 네가 먼저", "someone@example.com"],
    );

    const response = await queue(
      authed("http://localhost/api/admin/queue", cookie),
    );
    expect(response.status).toBe(200);
    const view = (await response.json()) as QueueView;

    const report = view.reports.find((item) => item.id === reportId);
    expect(report?.reason).toBe("doxx");
    expect(report?.letter.id).toBe(reported.letter.id);
    // 판정에 필요한 값이 화면까지 온다 (07 §2).
    expect(report?.letter.body).toBe(reported.letter.body);
    expect(report?.letter.reportCount).toBe(1);
    // 초안은 아직 없다 — S2의 draftReportVerdict가 붙기 전이다.
    expect(report?.draft).toBeNull();

    expect(view.autoHidden.map((item) => item.id)).toContain(
      reported.letter.id,
    );
    expect(view.appeals.map((item) => item.id)).toContain(appealId);
    expect(view.deletionRequests.map((item) => item.bodyExcerpt)).toContain(
      "그때 네가 먼저",
    );
  });
});

describe("POST /api/admin/reports/:id/resolve (05-api §4 · 07 §2)", () => {
  it("dismiss는 published로 되돌리고 auto_hide_exempt를 세운다", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter({ status: "hidden_auto" });
    const reportId = await insertReport(letter.id);

    const response = await resolveReport(
      authed(`http://localhost/api/admin/reports/${reportId}/resolve`, cookie, {
        action: "dismiss",
        note: "저격으로 보기 어렵다",
      }),
      context(reportId),
    );
    expect(response.status).toBe(204);

    expect(await letterRow(letter.id)).toEqual({
      status: "published",
      auto_hide_exempt: true,
    });

    const { rows } = await query<{ status: string; resolved_at: Date | null }>(
      "select status, resolved_at from reports where id = $1",
      [reportId],
    );
    expect(rows[0]?.status).toBe("dismissed");
    expect(rows[0]?.resolved_at).toBeInstanceOf(Date);

    // 07 §2 원칙 3 — 판정 이유 한 줄.
    expect(await adminActions("report_dismissed", String(reportId))).toEqual([
      { note: "저격으로 보기 어렵다" },
    ]);
  });

  it("dismiss 뒤 같은 편지는 일반 신고로는 안 내려가고 심각 카테고리로는 내려간다", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter({ status: "hidden_auto" });
    const reportId = await insertReport(letter.id);
    await resolveReport(
      authed(`http://localhost/api/admin/reports/${reportId}/resolve`, cookie, {
        action: "dismiss",
      }),
      context(reportId),
    );

    const { POST: report } = await import(
      "@/app/api/letters/[id]/report/route"
    );
    const send = (reason: string, ua: string) =>
      report(
        new Request(`http://localhost/api/letters/${letter.id}/report`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": ua },
          body: JSON.stringify({ reason }),
        }),
        context(letter.id),
      );

    await send("targeting", "admin-test-again-1");
    expect((await letterRow(letter.id))?.status).toBe("published");

    await send("doxx", "admin-test-again-2");
    expect((await letterRow(letter.id))?.status).toBe("hidden_auto");
  });

  it("uphold는 hidden_admin으로 내린다", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter({ status: "hidden_auto" });
    const reportId = await insertReport(letter.id, "doxx");

    expect(
      (
        await resolveReport(
          authed(
            `http://localhost/api/admin/reports/${reportId}/resolve`,
            cookie,
            { action: "uphold", note: "실명과 학교가 본문에 있다" },
          ),
          context(reportId),
        )
      ).status,
    ).toBe(204);

    expect((await letterRow(letter.id))?.status).toBe("hidden_admin");
    expect(await adminActions("report_upheld", String(reportId))).toHaveLength(
      1,
    );
  });

  it("두 번째 판정은 409, 없는 신고는 404, 이상한 action은 400", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter({ status: "hidden_auto" });
    const reportId = await insertReport(letter.id);

    const resolve = (body: unknown, id: number = reportId) =>
      resolveReport(
        authed(`http://localhost/api/admin/reports/${id}/resolve`, cookie, body),
        context(id),
      );

    expect((await resolve({ action: "uphold" })).status).toBe(204);
    expect((await resolve({ action: "dismiss" })).status).toBe(409);
    expect((await resolve({ action: "delete" })).status).toBe(400);
    expect((await resolve({ action: "uphold" }, 999_999)).status).toBe(404);
  });
});

describe("POST /api/admin/appeals/:id/resolve (05-api §4 · 04 §3)", () => {
  it("restore는 published + auto_hide_exempt다", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter({ status: "hidden_admin" });
    const appealId = await insertAppeal(letter.id);

    const response = await resolveAppeal(
      authed(`http://localhost/api/admin/appeals/${appealId}/resolve`, cookie, {
        action: "restore",
        note: "신고가 과했다",
      }),
      context(appealId),
    );
    expect(response.status).toBe(204);

    expect(await letterRow(letter.id)).toEqual({
      status: "published",
      auto_hide_exempt: true,
    });
    const { rows } = await query<{ status: string }>(
      "select status from appeals where id = $1",
      [appealId],
    );
    expect(rows[0]?.status).toBe("restored");
    expect(await adminActions("appeal_restored", String(appealId))).toEqual([
      { note: "신고가 과했다" },
    ]);
  });

  it("reject는 편지 상태를 바꾸지 않고 appeals.status만 기록한다", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter({ status: "hidden_admin" });
    const appealId = await insertAppeal(letter.id);

    expect(
      (
        await resolveAppeal(
          authed(
            `http://localhost/api/admin/appeals/${appealId}/resolve`,
            cookie,
            { action: "reject" },
          ),
          context(appealId),
        )
      ).status,
    ).toBe(204);

    expect(await letterRow(letter.id)).toEqual({
      status: "hidden_admin",
      auto_hide_exempt: false,
    });
    const { rows } = await query<{ status: string }>(
      "select status from appeals where id = $1",
      [appealId],
    );
    expect(rows[0]?.status).toBe("rejected");
  });
});

describe("POST /api/admin/letters/:id/hide (05-api §4 · 07 §4)", () => {
  it("hidden_admin으로 내리고 admin_actions에 기록한다", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter();

    expect(
      (
        await hideLetter(
          authed(
            `http://localhost/api/admin/letters/${letter.id}/hide`,
            cookie,
            { note: "긴급 대응" },
          ),
          context(letter.id),
        )
      ).status,
    ).toBe(204);

    expect((await letterRow(letter.id))?.status).toBe("hidden_admin");
    expect(await adminActions("hide_letter", letter.id)).toEqual([
      { note: "긴급 대응" },
    ]);
  });

  it("없는 편지는 404다", async () => {
    const cookie = await sessionCookie();
    const id = randomLetterId();
    expect(
      (
        await hideLetter(
          authed(`http://localhost/api/admin/letters/${id}/hide`, cookie, {}),
          context(id),
        )
      ).status,
    ).toBe(404);
  });
});

describe("POST /api/admin/settings — 킬 스위치 (05-api §4 · 07 §3)", () => {
  it("스위치를 끄고 켜면 app_settings가 바뀌고 기록이 남는다", async () => {
    const cookie = await sessionCookie();

    const off = await settings(
      authed("http://localhost/api/admin/settings", cookie, {
        writingEnabled: false,
        note: "자리를 비운다",
      }),
    );
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({
      publicReadEnabled: true,
      writingEnabled: false,
    });

    const { rows } = await query<{ value: unknown }>(
      "select value from app_settings where key = 'writing_enabled'",
    );
    expect(rows[0]?.value).toBe(false);
    expect(await adminActions("setting_disabled", "writing_enabled")).toEqual([
      { note: "자리를 비운다" },
    ]);

    const on = await settings(
      authed("http://localhost/api/admin/settings", cookie, {
        writingEnabled: true,
      }),
    );
    expect(await on.json()).toEqual({
      publicReadEnabled: true,
      writingEnabled: true,
    });
    expect(await adminActions("setting_enabled", "writing_enabled")).toEqual([
      { note: null },
    ]);
  });

  it("바꿀 스위치가 없으면 400이다", async () => {
    const cookie = await sessionCookie();
    expect(
      (
        await settings(
          authed("http://localhost/api/admin/settings", cookie, {
            note: "아무것도 안 바꿈",
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("POST /api/admin/deletion-requests/:id/resolve (07 §5)", () => {
  it("대조한 편지를 deleted_by_author로 지우고 요청을 처리 완료로 내린다", async () => {
    const cookie = await sessionCookie();
    const { letter } = await insertLetter({ body: "그때 네가 먼저" });
    const { rows } = await query<{ id: string }>(
      "insert into deletion_requests (body_excerpt) values ($1) returning id",
      ["그때 네가 먼저"],
    );
    const requestId = Number(rows[0]!.id);

    const response = await resolveDeletionRequest(
      authed(
        `http://localhost/api/admin/deletion-requests/${requestId}/resolve`,
        cookie,
        { letterId: letter.id, note: "본문 일치" },
      ),
      context(requestId),
    );
    expect(response.status).toBe(204);

    // 관리 링크를 잃어버렸을 뿐 결국 작성자 본인의 삭제다 (07 §5).
    expect((await letterRow(letter.id))?.status).toBe("deleted_by_author");

    const { rows: after } = await query<{
      status: string;
      letter_id: string | null;
      resolved_at: Date | null;
    }>(
      "select status, letter_id, resolved_at from deletion_requests where id = $1",
      [requestId],
    );
    expect(after[0]?.status).toBe("resolved");
    expect(after[0]?.letter_id).toBe(letter.id);
    expect(after[0]?.resolved_at).toBeInstanceOf(Date);
  });

  it("편지 ID가 없거나 그 ID의 편지가 없으면 400이고 요청은 그대로 남는다", async () => {
    const cookie = await sessionCookie();
    const { rows } = await query<{ id: string }>(
      "insert into deletion_requests (body_excerpt) values ($1) returning id",
      ["대조 실패"],
    );
    const requestId = Number(rows[0]!.id);

    const call = (body: unknown) =>
      resolveDeletionRequest(
        authed(
          `http://localhost/api/admin/deletion-requests/${requestId}/resolve`,
          cookie,
          body,
        ),
        context(requestId),
      );

    expect((await call({})).status).toBe(400);
    expect((await call({ letterId: randomLetterId() })).status).toBe(400);

    const { rows: after } = await query<{ status: string }>(
      "select status from deletion_requests where id = $1",
      [requestId],
    );
    expect(after[0]?.status).toBe("pending");
  });
});
