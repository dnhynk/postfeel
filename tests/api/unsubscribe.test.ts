// 해지 — `/unsubscribe/:token` (09 §1 · 03 화면 목록).
//
// 화면을 통해 부른다. 09 §1이 요구한 것은 "클릭 1회"이고, **요청 한 번으로 해지가 끝나는
// 것 자체가 명세**라 lib 함수만 부르면 그 부분이 검증되지 않는다. 서버 컴포넌트라 함수를
// 그대로 부를 수 있다 (tests/ui/write-copy.test.ts와 같은 방식).

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import UnsubscribePage from "@/app/unsubscribe/[token]/page";
import { query } from "@/lib/db";
import { emailHash } from "@/lib/notify/suppression";
import { insertLetter } from "../fixtures/letters.ts";

/** 해지 링크를 한 번 여는 것 = 이 호출. 확인 화면도, 두 번째 요청도 없다. */
async function open(token: string, kind?: string): Promise<string> {
  const element = await UnsubscribePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(kind === undefined ? {} : { k: kind }),
  });
  return renderToStaticMarkup(element)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function insertContact(email: string, token: string): Promise<string> {
  const { letter } = await insertLetter();
  await query(
    `insert into author_contacts (letter_id, email, unsubscribe_token)
     values ($1, $2, $3)`,
    [letter.id, email, token],
  );
  return letter.id;
}

async function contactCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from author_contacts",
  );
  return Number(rows[0]?.count ?? 0);
}

// 이 파일의 단언은 전역 개수(행이 하나도 안 남았는가)를 본다. 파일 하나가 DB 하나를
// 쓰므로(tests/setup/db.ts) 앞 테스트가 남긴 행이 보이면 그때부터 뜻이 달라진다.
beforeEach(async () => {
  await query("delete from events");
  await query("delete from author_contacts");
  await query("delete from email_suppressions");
});

describe("/unsubscribe/:token", () => {
  it("한 번 열면 행이 지워지고 억제 목록에 해시가 남는다", async () => {
    await insertContact("wrong@example.com", "token-a");

    const rendered = await open("token-a", "first_unlock");

    expect(rendered).toContain("알림을 껐습니다.");
    expect(await contactCount()).toBe(0);

    const { rows } = await query<{ email_hash: Buffer }>(
      "select email_hash from email_suppressions",
    );
    expect(rows).toHaveLength(1);
    // 원문 주소는 어디에도 남지 않는다 (09 §1 · 04 §1-3).
    expect(rows[0]?.email_hash.equals(emailHash("wrong@example.com"))).toBe(true);
  });

  it("같은 주소가 여러 편지에 등록돼 있으면 전부 지운다", async () => {
    await insertContact("same@example.com", "token-b1");
    await insertContact("Same@Example.com", "token-b2");
    await insertContact("other@example.com", "token-b3");

    await open("token-b1", "manage_link");

    const { rows } = await query<{ email: string }>(
      "select email from author_contacts",
    );
    expect(rows.map((row) => row.email)).toEqual(["other@example.com"]);
  });

  it("09 §5 — email_unsubscribed { kind }를 서버가 기록한다", async () => {
    await insertContact("k@example.com", "token-c");

    await open("token-c", "recipient_yes");

    const { rows } = await query<{ props: { kind?: string } }>(
      "select props from events where name = 'email_unsubscribed'",
    );
    // 이메일도 편지 ID도 담기지 않는다 (06 §2 · 09 §5).
    expect(rows).toEqual([{ props: { kind: "recipient_yes" } }]);
  });

  it("kind가 없거나 모르는 값이면 추측해서 채우지 않는다", async () => {
    await insertContact("k2@example.com", "token-d");

    await open("token-d");

    const { rows } = await query<{ props: unknown }>(
      "select props from events where name = 'email_unsubscribed'",
    );
    expect(rows).toEqual([{ props: {} }]);
  });

  it("모르는 토큰은 결과만 다르고 아무것도 바꾸지 않는다", async () => {
    await insertContact("keep@example.com", "token-e");

    const rendered = await open("아무-토큰");

    expect(rendered).toContain("이미 해지된 링크입니다.");
    expect(await contactCount()).toBe(1);
    const { rowCount } = await query("select 1 from email_suppressions");
    expect(rowCount ?? 0).toBe(0);
    const { rowCount: events } = await query(
      "select 1 from events where name = 'email_unsubscribed'",
    );
    expect(events ?? 0).toBe(0);
  });

  it("두 번 눌러도 오류가 아니다 — 두 번째는 지울 것이 없을 뿐이다", async () => {
    await insertContact("twice@example.com", "token-f");

    await open("token-f", "auto_hidden");
    const second = await open("token-f", "auto_hidden");

    expect(second).toContain("이미 해지된 링크입니다.");
    const { rowCount } = await query("select 1 from email_suppressions");
    expect(rowCount ?? 0).toBe(1);
  });
});
