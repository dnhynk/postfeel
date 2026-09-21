// 관리 표면 — /api/manage/:token 계열
//
// 안전 회귀 테스트. 구현은 이 표면을 맡은 워커가 채운다.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { POST as postAppeal } from "@/app/api/manage/[token]/appeal/route";
import { POST as postContact } from "@/app/api/manage/[token]/contact/route";
import { DELETE, GET } from "@/app/api/manage/[token]/route";
import { insertLetter } from "../fixtures/letters.ts";

// 05-api §2 표의 200/410은 **API가 지는 책임이다.** 화면은 그 응답을 렌더할 뿐이라
// 여기서는 라우트 핸들러를 직접 부른다.
const context = (token: string) => ({ params: Promise.resolve({ token }) });
const manageUrl = (token: string) => `http://localhost/api/manage/${token}`;

const get = (token: string) => GET(new Request(manageUrl(token)), context(token));
const del = (token: string) =>
  DELETE(new Request(manageUrl(token), { method: "DELETE" }), context(token));
const appeal = (token: string) =>
  postAppeal(
    new Request(`${manageUrl(token)}/appeal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    context(token),
  );
const contact = (token: string, body: unknown) =>
  postContact(
    new Request(`${manageUrl(token)}/contact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context(token),
  );

/** 저장 여부가 이 번호들의 단언이다 — 상태 코드만 보면 "400인데 저장됨"을 놓친다. */
async function contactCount(letterId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from author_contacts where letter_id = $1",
    [letterId],
  );
  return Number(rows[0]?.count ?? 0);
}

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const LETTERS_API = path.join(SRC, "app", "api", "letters");

/** 디렉터리 아래의 모든 파일. 하위 디렉터리까지 훑는다. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

// docs/05-api.md §7 #11 · §2 「상태별 표면 응답」 · docs/04-data-model.md §5 발견 2
describe("safety#11 · 비공개·삭제 상태에서도 /manage/:token은 응답한다", () => {
  // 이의 제기 경로가 여기밖에 없다. 삭제는 410, 나머지는 200 + 이의 제기 가능.
  it("hidden_auto·hidden_admin은 200이고 canAppeal이 true다", async () => {
    for (const status of ["hidden_auto", "hidden_admin"] as const) {
      const { letter, manageToken } = await insertLetter({ status });

      const response = await get(manageToken);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        canAppeal: boolean;
      };
      expect(body.status).toBe(status);
      expect(body.canAppeal).toBe(true);

      // "이의 제기 가능"이 화면 표시로 끝나면 안 된다 — 실제로 접수돼야 한다.
      expect((await appeal(manageToken)).status).toBe(204);
      const { rows } = await query("select 1 from appeals where letter_id = $1", [
        letter.id,
      ]);
      expect(rows).toHaveLength(1);
    }
  });

  it("deleted_by_author는 410이다", async () => {
    const { manageToken } = await insertLetter({ status: "deleted_by_author" });

    const response = await get(manageToken);
    expect(response.status).toBe(410);
    // 토큰 소지자는 작성자 본인이므로 "이미 지웠다"를 알려준다 (05-api §2).
    expect(await response.json()).toEqual({
      error: {
        code: "gone",
        message: "이미 삭제된 편지입니다. 되돌릴 수 없습니다.",
      },
    });
  });
});

// docs/05-api.md §7 #25 · docs/00-decisions.md D-027 · migrations/0003
describe("safety#25 · 삭제된 편지의 원문이 DB에 남아 있지 않다", () => {
  // 10번은 **표면이 404인지**만 본다. 겉이 404여도 본문이 DB에 그대로 있으면 파기가
  // 아니다 — 그리고 그 상태는 코드를 읽어서는 보이지 않는다. 여기서 DB를 직접 본다.
  const PURGED_BODY = "여기에 절대 남으면 안 되는 본문이 있다";
  const PURGED_HINT = "우리가 자주 가던 그 골목";
  const PURGED_QUESTION = "거기 카페 이름은?";

  interface PurgeRow {
    body: string | null;
    hint: string | null;
    question: string | null;
    answer_hmac: Buffer | null;
    answer_variant_hmacs: Buffer[];
    status: string;
    manage_token_hash: Buffer | null;
  }

  const insertLocked = () =>
    insertLetter({
      mode: "locked",
      body: PURGED_BODY,
      hint: PURGED_HINT,
      question: PURGED_QUESTION,
      answerHmac: Buffer.alloc(32, 7),
      answerVariantHmacs: [Buffer.alloc(32, 8), Buffer.alloc(32, 9)],
    });

  it("DELETE 후 본문·단서·질문·답 해시·변형 해시가 전부 비워진다", async () => {
    const { letter, manageToken } = await insertLocked();

    expect((await del(manageToken)).status).toBe(204);

    const { rows } = await query<PurgeRow>(
      `select body, hint, question, answer_hmac, answer_variant_hmacs,
              status, manage_token_hash
         from letters where id = $1`,
      [letter.id],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.body).toBeNull();
    expect(row?.hint).toBeNull();
    expect(row?.question).toBeNull();
    expect(row?.answer_hmac).toBeNull();
    expect(row?.answer_variant_hmacs).toEqual([]);
  });

  it("tombstone은 남는다 — 그래야 11번의 410이 성립한다", async () => {
    const { letter, manageToken } = await insertLocked();

    await del(manageToken);

    // 행을 통째로 지우면 토큰을 못 찾아 404가 되고, 작성자가 "내가 지웠다"와
    // "운영자가 내렸다"를 구분하지 못한다 (migrations/0003 주석).
    const { rows } = await query<PurgeRow>(
      "select status, manage_token_hash from letters where id = $1",
      [letter.id],
    );
    expect(rows[0]?.status).toBe("deleted_by_author");
    expect(rows[0]?.manage_token_hash).not.toBeNull();
    expect((await get(manageToken)).status).toBe(410);
  });

  it("본문 문자열이 letters 어디에도 남지 않는다", async () => {
    const { manageToken } = await insertLocked();

    await del(manageToken);

    // 컬럼을 하나씩 세는 대신 테이블 전체에서 찾는다 — 나중에 본문 조각을 담는
    // 컬럼이 생기면 위 단언은 통과하고 이 단언만 깨진다.
    const { rows } = await query<{ count: string }>(
      `select count(*) as count from letters
        where body like $1 or hint like $1 or question like $1`,
      [`%${PURGED_BODY}%`],
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });
});

// docs/05-api.md §7 #14 · §3 「POST /api/manage/:token/contact」 · docs/00-decisions.md D-013
describe("safety#14 · ageConfirmed가 없거나 false면 이메일이 저장되지 않는다", () => {
  // 클라이언트 체크박스만으로는 안 된다. 아동 개인정보를 수집하지 않기 위한
  // 유일한 방어선이라 우회 가능하면 의미가 없다.
  it("ageConfirmed 누락이면 400이고 author_contacts에 행이 없다", async () => {
    const { letter, manageToken } = await insertLetter();

    const response = await contact(manageToken, { email: "a@example.com" });

    expect(response.status).toBe(400);
    expect(await contactCount(letter.id)).toBe(0);
  });

  it("ageConfirmed=false면 400이고 author_contacts에 행이 없다", async () => {
    const { letter, manageToken } = await insertLetter();

    const response = await contact(manageToken, {
      email: "a@example.com",
      ageConfirmed: false,
    });

    expect(response.status).toBe(400);
    expect(await contactCount(letter.id)).toBe(0);
  });

  it("문자열 'true'처럼 참 같은 값도 통과하지 못한다", async () => {
    const { letter, manageToken } = await insertLetter();

    // 05-api §3: `ageConfirmed !== true`면 400이다. 느슨한 비교로 열어두면 클라이언트가
    // 아무 값이나 넣어 우회할 수 있다.
    for (const value of ["true", 1, {}, null]) {
      const response = await contact(manageToken, {
        email: "a@example.com",
        ageConfirmed: value,
      });
      expect(response.status).toBe(400);
    }
    expect(await contactCount(letter.id)).toBe(0);
  });
});

// docs/05-api.md §7 #15 · §6 「킬 스위치 확인 위치」
describe("safety#15 · public_read_enabled=false에서 /manage/:token은 계속 동작한다", () => {
  // 사고 대응 중에도 작성자는 자기 편지를 지울 수 있어야 한다.
  it("공개 읽기를 끈 상태에서 관리 화면 조회와 삭제가 모두 동작한다", async () => {
    const { letter, manageToken } = await insertLetter();
    await query(
      "update app_settings set value = 'false'::jsonb where key = 'public_read_enabled'",
    );

    // 킬 스위치는 매 요청 DB에서 읽힌다. 이 상태에서 피드와 /m/:id는 죽어 있다.
    const { rows } = await query<{ value: unknown }>(
      "select value from app_settings where key = 'public_read_enabled'",
    );
    expect(rows[0]?.value).toBe(false);

    expect((await get(manageToken)).status).toBe(200);
    expect((await del(manageToken)).status).toBe(204);

    const { rows: after } = await query<{ status: string }>(
      "select status from letters where id = $1",
      [letter.id],
    );
    expect(after[0]?.status).toBe("deleted_by_author");

    await query(
      "update app_settings set value = 'true'::jsonb where key = 'public_read_enabled'",
    );
  });
});

// docs/05-api.md §7 #17 · §3 「편지 ID가 아니라 관리 토큰으로 받는다」
describe("safety#17 · 관리 토큰 없이 /api/letters/:id 계열 경로로 이메일을 등록할 수 없다", () => {
  // ID를 키로 두면 편지 링크를 본 사람 누구나 이메일을 붙일 수 있고, 그 제3자에게
  // "누군가 열었습니다" 메일이 나간다 — D-006이 뚫리는 경로다.
  it("편지 ID로 이메일을 등록하는 엔드포인트가 존재하지 않는다", () => {
    // 라우트가 생기는 순간 이 단언이 깨진다. "안 만들었다"는 실행으로 확인할 수 없어
    // 파일로 확인한다.
    expect(existsSync(path.join(LETTERS_API, "[id]", "contact", "route.ts"))).toBe(
      false,
    );

    // 이름을 다르게 지어도(`subscribe` 등) 저장할 곳은 `author_contacts` 하나다. 그래서
    // "이 경로에 라우트가 없다"가 아니라 **"삽입하는 파일이 어디인가"**를 고정한다 —
    // 등록 경로가 하나뿐이면 관리 토큰 없이 등록되는 길도 없다.
    const inserting = filesUnder(SRC)
      .filter((file) => /insert\s+into\s+author_contacts/i.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file).replaceAll(path.sep, "/"));

    expect(inserting).toEqual(["app/api/manage/[token]/contact/route.ts"]);
  });

  it("등록 경로는 편지 ID를 토큰 자리에 넣어도 열리지 않는다", async () => {
    const { letter } = await insertLetter();

    // 편지 링크를 본 사람이 아는 값은 ID뿐이다. 그 값으로는 아무것도 되지 않는다 —
    // 관리 토큰은 작성 응답에서만 나오므로 소지자가 곧 작성자다 (05-api §3 · D-014).
    const response = await contact(letter.id, {
      email: "stranger@example.com",
      ageConfirmed: true,
    });

    expect(response.status).toBe(404);
    expect(await contactCount(letter.id)).toBe(0);
  });
});
