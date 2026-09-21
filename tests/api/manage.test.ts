// 관리 표면 — `/api/manage/:token` 계열 + `/api/deletion-requests` (05-api §3 · §2).
//
// 라우트 핸들러를 직접 부른다. 핸들러가 `Request`와 `Response`만 쓰기 때문에 Next 런타임
// 없이도 그대로 실행된다 — `next/headers` 같은 요청 컨텍스트 의존이 없다.

import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { POST as postDeletionRequest } from "@/app/api/deletion-requests/route";
import { POST as postAppeal } from "@/app/api/manage/[token]/appeal/route";
import { DELETE, GET } from "@/app/api/manage/[token]/route";
import { insertLetter, randomManageToken } from "../fixtures/letters.ts";

interface ManageBody {
  id: string;
  status: string;
  statusReason?: string;
  canAppeal: boolean;
  pendingReview: boolean;
  opened: boolean;
  recipientSaidYes: boolean;
}

const context = (token: string) => ({ params: Promise.resolve({ token }) });
const manageUrl = (token: string) => `http://localhost/api/manage/${token}`;

function get(token: string) {
  return GET(new Request(manageUrl(token)), context(token));
}

function del(token: string) {
  return DELETE(new Request(manageUrl(token), { method: "DELETE" }), context(token));
}

function appeal(token: string, body?: unknown) {
  return postAppeal(
    new Request(`${manageUrl(token)}/appeal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    context(token),
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

/** 열람 기록 한 건. `unlocks`는 잠긴 편지를 실제로 연 사람만 남긴다 (04 §2). */
async function insertUnlock(
  letterId: string,
  response?: "yes" | "no" | "unknown",
): Promise<void> {
  await query(
    `insert into unlocks (unlock_id, letter_id, fp_hash, recipient_response, responded_at)
     values ($1, $2, $3, $4, case when $4::text is null then null else now() end)`,
    [
      `unlock_${Math.random().toString(36).slice(2, 12)}`,
      letterId,
      Buffer.from(`fp_${Math.random()}`),
      response ?? null,
    ],
  );
}

async function deletionRequestCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from deletion_requests",
  );
  return Number(rows[0]?.count ?? 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/manage/:token — 상태 확인 (05-api §3)", () => {
  it("published는 200이고 응답이 명세한 필드만 담는다", async () => {
    const { letter, manageToken } = await insertLetter();

    const response = await get(manageToken);
    expect(response.status).toBe(200);

    const body = (await response.json()) as ManageBody;
    expect(body).toEqual({
      id: letter.id,
      status: "published",
      canAppeal: false,
      // D-035 — 판정이 끝난 편지라 보류가 아니다. 이 필드가 없으면 작성자가
      // 보류 중인 편지와 공개된 편지를 구분할 수 없다 (05-api §3).
      pendingReview: false,
      opened: false,
      recipientSaidYes: false,
    });
    // 비공개가 아니면 필드 자체가 없다.
    expect("statusReason" in body).toBe(false);
  });

  it("opened·recipientSaidYes는 개수가 아니라 불리언이다 (D-007)", async () => {
    const { letter, manageToken } = await insertLetter();
    await insertUnlock(letter.id);
    await insertUnlock(letter.id, "no");

    const opened = (await (await get(manageToken)).json()) as ManageBody;
    expect(opened.opened).toBe(true);
    expect(opened.recipientSaidYes).toBe(false);

    await insertUnlock(letter.id, "yes");
    const answered = (await (await get(manageToken)).json()) as ManageBody;
    expect(answered.opened).toBe(true);
    expect(answered.recipientSaidYes).toBe(true);

    // 열람이 3건이지만 응답에는 개수도 시각도 없다 — 05-api §3이 정한 필드가 전부다.
    expect(Object.keys(answered).sort()).toEqual([
      "canAppeal",
      "id",
      "opened",
      "pendingReview",
      "recipientSaidYes",
      "status",
    ]);
  });

  it("이의 제기 이력이 있으면 canAppeal이 false다 — 편지당 1회 (가설값)", async () => {
    const { letter, manageToken } = await insertLetter({ status: "hidden_auto" });
    expect(((await (await get(manageToken)).json()) as ManageBody).canAppeal).toBe(
      true,
    );

    await query(
      "insert into appeals (letter_id, message, status) values ($1, null, 'rejected')",
      [letter.id],
    );
    expect(((await (await get(manageToken)).json()) as ManageBody).canAppeal).toBe(
      false,
    );
  });
});

describe("틀린 토큰은 어느 편지에 대한 시도인지 흘리지 않는다 (D-014)", () => {
  it("404 본문이 편지와 무관한 고정 문구 하나다", async () => {
    const { letter } = await insertLetter();
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    const response = await get(randomManageToken());
    expect(response.status).toBe(404);

    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "not_found", message: "편지를 찾을 수 없습니다." },
    });
    // 응답 어디에도 편지 ID가 없다 — 본문에도, 헤더에도.
    expect(text).not.toContain(letter.id);
    expect(JSON.stringify([...response.headers])).not.toContain(letter.id);
    // 로그에도 남기지 않는다. 이 표면은 아무것도 로그하지 않는다.
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("DELETE·appeal도 같은 404를 돌려준다", async () => {
    const token = randomManageToken();
    expect((await del(token)).status).toBe(404);
    expect((await appeal(token)).status).toBe(404);
  });
});

describe("DELETE /api/manage/:token — 작성자 삭제 (05-api §3 · S-9)", () => {
  it("204를 돌려주고 편지가 deleted_by_author가 된다", async () => {
    const { letter, manageToken } = await insertLetter();

    const response = await del(manageToken);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await statusOf(letter.id)).toBe("deleted_by_author");

    const { rows } = await query<{ deleted_at: Date | null }>(
      "select deleted_at from letters where id = $1",
      [letter.id],
    );
    expect(rows[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it("삭제하면 피드 조건에서 빠진다 (04 §3 · 05-api §2)", async () => {
    const { letter, manageToken } = await insertLetter();
    await del(manageToken);

    // 피드 노출 조건은 저장하지 않고 파생한다 — status='published' and risk_level='low'.
    const { rows } = await query(
      "select 1 from letters where id = $1 and status = 'published' and risk_level = 'low'",
      [letter.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("두 번째 삭제는 410이다 — 이미 지운 편지", async () => {
    const { manageToken } = await insertLetter();
    expect((await del(manageToken)).status).toBe(204);

    const second = await del(manageToken);
    expect(second.status).toBe(410);
    expect(await second.json()).toEqual({
      error: {
        code: "gone",
        message: "이미 삭제된 편지입니다. 되돌릴 수 없습니다.",
      },
    });
  });

  it("삭제 요청 본문을 읽지 않는다 — 사유를 묻지 않는다 (S-9)", async () => {
    const { manageToken } = await insertLetter();
    // 본문이 없는 DELETE가 정상 경로다. 위 테스트가 이미 그렇게 부르고 있고,
    // 여기서는 사유를 담아 보내도 아무 차이가 없다는 것만 고정한다.
    const response = await DELETE(
      new Request(manageUrl(manageToken), {
        method: "DELETE",
        body: JSON.stringify({ reason: "후회" }),
      }),
      context(manageToken),
    );
    expect(response.status).toBe(204);
  });
});

describe("POST /api/manage/:token/appeal — 이의 제기 (05-api §3 · 02 §4)", () => {
  it("비공개 편지에 204를 돌려주고 appeals에 한 행을 남긴다", async () => {
    const { letter, manageToken } = await insertLetter({ status: "hidden_auto" });

    const response = await appeal(manageToken, { message: "신고가 잘못됐습니다." });
    expect(response.status).toBe(204);

    const { rows } = await query<{ message: string | null; status: string }>(
      "select message, status from appeals where letter_id = $1",
      [letter.id],
    );
    expect(rows).toEqual([
      { message: "신고가 잘못됐습니다.", status: "pending" },
    ]);
  });

  it("message는 선택이다 — 빈 요청도 접수된다", async () => {
    const { letter, manageToken } = await insertLetter({ status: "hidden_admin" });
    expect((await appeal(manageToken)).status).toBe(204);

    const { rows } = await query<{ message: string | null }>(
      "select message from appeals where letter_id = $1",
      [letter.id],
    );
    expect(rows).toEqual([{ message: null }]);
  });

  it("두 번째 이의 제기는 409다 — 편지당 1회 (가설값)", async () => {
    const { manageToken } = await insertLetter({ status: "hidden_auto" });
    expect((await appeal(manageToken)).status).toBe(204);
    expect((await appeal(manageToken)).status).toBe(409);
  });

  it("published에는 400, deleted_by_author에는 410", async () => {
    const open = await insertLetter();
    expect((await appeal(open.manageToken)).status).toBe(400);

    const removed = await insertLetter({ status: "deleted_by_author" });
    expect((await appeal(removed.manageToken)).status).toBe(410);

    const { rows } = await query(
      "select 1 from appeals where letter_id = any($1::text[])",
      [[open.letter.id, removed.letter.id]],
    );
    expect(rows).toHaveLength(0);
  });

  it("1000자를 넘는 설명은 400이고 저장되지 않는다", async () => {
    const { letter, manageToken } = await insertLetter({ status: "hidden_auto" });
    const response = await appeal(manageToken, { message: "가".repeat(1001) });
    expect(response.status).toBe(400);

    const { rows } = await query("select 1 from appeals where letter_id = $1", [
      letter.id,
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/deletion-requests — 관리 링크 분실 (07 §5)", () => {
  const post = (body: unknown) =>
    postDeletionRequest(
      new Request("http://localhost/api/deletion-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("접수만 한다 — 편지를 찾지도 지우지도 않는다", async () => {
    const { letter } = await insertLetter({ body: "그때 네가 먼저 미안하다고 했는데" });

    const response = await post({
      bodyExcerpt: "그때 네가 먼저 미안하다고 했는데",
      contact: "someone@example.com",
    });
    expect(response.status).toBe(204);

    const { rows } = await query<{
      letter_id: string | null;
      body_excerpt: string;
      contact: string | null;
      status: string;
    }>(
      `select letter_id, body_excerpt, contact, status
         from deletion_requests
        where body_excerpt = $1`,
      ["그때 네가 먼저 미안하다고 했는데"],
    );
    expect(rows).toEqual([
      {
        letter_id: null, // 대조는 운영자가 사람으로 한다 (07 §5)
        body_excerpt: "그때 네가 먼저 미안하다고 했는데",
        contact: "someone@example.com",
        status: "pending",
      },
    ]);
    // 본문이 정확히 일치해도 편지는 그대로다.
    expect(await statusOf(letter.id)).toBe("published");
  });

  it("본문 발췌가 없거나 500자를 넘으면 400이고 접수되지 않는다", async () => {
    const before = await deletionRequestCount();

    expect((await post({})).status).toBe(400);
    expect((await post({ bodyExcerpt: "   " })).status).toBe(400);
    expect((await post({ bodyExcerpt: "가".repeat(501) })).status).toBe(400);

    expect(await deletionRequestCount()).toBe(before);
  });
});
