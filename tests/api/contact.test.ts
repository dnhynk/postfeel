// 이메일 등록 — `POST /api/manage/:token/contact` (05-api §3 · 03 §1-6 · 09 §1 · §2 #1).
//
// 라우트 핸들러를 직접 부른다 (tests/api/manage.test.ts와 같은 방식). 핸들러가 `Request`와
// `Response`만 쓰기 때문에 Next 런타임 없이 그대로 돈다.
//
// **실제 발송은 하지 않는다.** `.env.test`의 `RESEND_API_KEY`가 비어 있어 `resendSender()`가
// null을 돌려주고 발송은 건너뛴다. 메일 내용은 `MailSender`를 주입해서 본다 (09 §2).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as postContact } from "@/app/api/manage/[token]/contact/route";
import { DoneScreen } from "@/components/write/done-screen";
import { query } from "@/lib/db";
import { fingerprint } from "@/lib/fingerprint";
import {
  deliver,
  notifyManageLink,
  type MailSender,
  type OutgoingMail,
} from "@/lib/notify/email";
import { emailHash } from "@/lib/notify/suppression";
import { insertLetter, randomManageToken } from "../fixtures/letters.ts";

const context = (token: string) => ({ params: Promise.resolve({ token }) });

const IP = "203.0.113.7";
const UA = "postfeel-test";

function headers(ip: string = IP): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-forwarded-for": ip,
    "user-agent": UA,
  });
}

function post(token: string, body: unknown, ip: string = IP) {
  return postContact(
    new Request(`http://localhost/api/manage/${token}/contact`, {
      method: "POST",
      headers: headers(ip),
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    context(token),
  );
}

interface ContactRow {
  letter_id: string;
  email: string;
  unsubscribe_token: string;
  first_unlock_notified_at: Date | null;
  recipient_yes_notified_at: Date | null;
}

async function contactsOf(letterId: string): Promise<ContactRow[]> {
  const { rows } = await query<ContactRow>(
    "select * from author_contacts where letter_id = $1",
    [letterId],
  );
  return rows;
}

// 파일 하나가 DB 하나를 쓴다 (tests/setup/db.ts). 계측을 세는 테스트가 앞 테스트의 행을
// 보면 그때부터 flaky해지므로 매번 비운다.
beforeEach(async () => {
  await query("delete from events");
});

/** 발송 관측용. 실제 HTTP는 일어나지 않는다. */
function recorder(): { sent: OutgoingMail[]; sender: MailSender } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    sender: async (mail) => {
      sent.push(mail);
    },
  };
}

describe("POST /api/manage/:token/contact", () => {
  it("등록에 성공하면 204이고 author_contacts에 행이 하나 생긴다", async () => {
    const { letter, manageToken } = await insertLetter();

    const response = await post(manageToken, {
      email: "author@example.com",
      ageConfirmed: true,
    });
    expect(response.status).toBe(204);

    const rows = await contactsOf(letter.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("author@example.com");
    // 09 §4 — 해지 링크용 랜덤 토큰. 관리 토큰과 별개다.
    expect(rows[0]?.unsubscribe_token.length).toBeGreaterThanOrEqual(43);
    expect(rows[0]?.unsubscribe_token).not.toBe(manageToken);
    // 아직 아무 알림도 나가지 않았다.
    expect(rows[0]?.first_unlock_notified_at).toBeNull();
    expect(rows[0]?.recipient_yes_notified_at).toBeNull();
  });

  it("06 §3 contact_added를 서버가 기록한다", async () => {
    const { manageToken } = await insertLetter();
    await post(manageToken, { email: "e@example.com", ageConfirmed: true });

    const { rows } = await query<{ props: unknown }>(
      "select props from events where name = 'contact_added'",
    );
    expect(rows).toHaveLength(1);
    // 06 §2 — 이메일도 편지 ID도 담지 않는다.
    expect(rows[0]?.props).toEqual({});
  });

  it("편지당 1회다. 두 번째 등록은 409이고 주소가 바뀌지 않는다", async () => {
    const { letter, manageToken } = await insertLetter();
    await post(manageToken, { email: "first@example.com", ageConfirmed: true });

    const second = await post(manageToken, {
      email: "second@example.com",
      ageConfirmed: true,
    });
    expect(second.status).toBe(409);

    const rows = await contactsOf(letter.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("first@example.com");
  });

  it("없는 토큰은 404다 — 어느 편지인지 알려주지 않는다", async () => {
    const { letter } = await insertLetter();

    const response = await post(randomManageToken(), {
      email: "someone@example.com",
      ageConfirmed: true,
    });
    expect(response.status).toBe(404);
    expect(await contactsOf(letter.id)).toHaveLength(0);
  });

  it("이미 지운 편지는 410이다 (05-api §2 표)", async () => {
    const { letter, manageToken } = await insertLetter({
      status: "deleted_by_author",
    });

    const response = await post(manageToken, {
      email: "author@example.com",
      ageConfirmed: true,
    });
    expect(response.status).toBe(410);
    expect(await contactsOf(letter.id)).toHaveLength(0);
  });

  it("비공개 편지에도 등록된다 — 상태 변화를 알 수 있어야 한다", async () => {
    const { letter, manageToken } = await insertLetter({ status: "hidden_auto" });

    const response = await post(manageToken, {
      email: "author@example.com",
      ageConfirmed: true,
    });
    expect(response.status).toBe(204);
    expect(await contactsOf(letter.id)).toHaveLength(1);
  });

  it("주소 형식이 아니면 400이고 저장하지 않는다", async () => {
    const { letter, manageToken } = await insertLetter();

    const response = await post(manageToken, {
      email: "not-an-email",
      ageConfirmed: true,
    });
    expect(response.status).toBe(400);
    expect(await contactsOf(letter.id)).toHaveLength(0);
  });

  it("본문이 JSON이 아니면 400이다", async () => {
    const { letter, manageToken } = await insertLetter();

    const response = await post(manageToken, "not json");
    expect(response.status).toBe(400);
    expect(await contactsOf(letter.id)).toHaveLength(0);
  });

  it("05-api §5 — 같은 fp의 등록이 5건이면 6번째는 429다", async () => {
    // 이 테스트만 쓰는 IP다. 기본 IP를 쓰면 여기서 채운 5건이 뒤에 오는 테스트의
    // 카운트에 남아 그 테스트가 429를 받는다 — 실제로 한 번 그랬다.
    const ip = "203.0.113.99";
    const fpHash = fingerprint(headers(ip));

    // 카운터는 `author_contacts` × `letters.author_fp_hash` 조인이다 (ratelimit.ts).
    // 카운터 테이블도 새 컬럼도 없다.
    for (let i = 0; i < 5; i += 1) {
      const { letter } = await insertLetter({ authorFpHash: fpHash });
      await query(
        `insert into author_contacts (letter_id, email, unsubscribe_token)
         values ($1, $2, $3)`,
        [letter.id, `filled${i}@example.com`, `token-${letter.id}`],
      );
    }

    const { letter, manageToken } = await insertLetter({ authorFpHash: fpHash });
    const response = await post(
      manageToken,
      { email: "sixth@example.com", ageConfirmed: true },
      ip,
    );
    expect(response.status).toBe(429);
    expect(
      (await response.json()) as { error: { retryAfter: number } },
    ).toMatchObject({ error: { code: "rate_limited", retryAfter: 3600 } });
    expect(await contactsOf(letter.id)).toHaveLength(0);

    // 다른 fp는 막히지 않는다 — 위 5건은 그 fp가 쓴 편지들에 붙은 등록이다.
    const other = await insertLetter();
    expect(
      (await post(other.manageToken, {
        email: "other@example.com",
        ageConfirmed: true,
      }, "198.51.100.9")).status,
    ).toBe(204);
  });

  it("09 §1 — 억제 목록에 있는 주소는 저장하지 않고 400이다", async () => {
    await query(
      "insert into email_suppressions (email_hash) values ($1)",
      [emailHash("gone@example.com")],
    );
    const { letter, manageToken } = await insertLetter();

    // 대소문자·앞뒤 공백은 normalize가 흡수한다 (09 §1).
    const response = await post(manageToken, {
      email: "  GONE@Example.com  ",
      ageConfirmed: true,
    });
    expect(response.status).toBe(400);
    // 형식 오류도 400이라 문구까지 본다 — 막힌 이유가 억제 목록이어야 한다.
    expect(await response.json()).toMatchObject({
      error: {
        message:
          "이 주소로는 알림을 보낼 수 없습니다. 이전에 알림을 끈 주소입니다.",
      },
    });
    expect(await contactsOf(letter.id)).toHaveLength(0);
  });
});

describe("09 §2 #1 — 등록 직후 관리 링크 메일", () => {
  it("관리 링크와 해지 링크가 들어가고 편지 본문은 없다", async () => {
    const { sent, sender } = recorder();
    await notifyManageLink(
      {
        email: "author@example.com",
        unsubscribeToken: "unsub-token",
        manageToken: "manage-token",
      },
      sender,
    );

    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail?.to).toBe("author@example.com");
    expect(mail?.subject).toBe("편지 관리 링크");
    expect(mail?.text).toContain("http://localhost:3000/manage/manage-token");
    expect(mail?.text).toContain(
      "http://localhost:3000/unsubscribe/unsub-token?k=manage_link",
    );
    expect(mail?.text).toContain("이 알림을 요청한 적이 없다면 여기서 끄세요.");
  });
});

// 이 엔드포인트의 클라이언트 절반이다. 문구는 03 §1-6에서 그대로 옮겼고 코드에서 옮기지
// 않았다. JSX 대신 createElement를 쓰는 이유는 tests/ui/write-copy.test.ts와 같다 —
// vitest include가 `tests/**/*.test.ts`라 .tsx는 실행되지 않는다.
describe("03 §1-6 — 완료 화면의 이메일 섹션", () => {
  const rendered = renderToStaticMarkup(
    // `letterId`·`mode`는 공유 카드가 쓴다 (03 흐름 3). 이 describe는 이메일 섹션만 본다.
    createElement(DoneScreen, {
      manageToken: "manage-token-value",
      letterId: "letter-id-value",
      mode: "open" as const,
    }),
  );
  const text = rendered.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  it("문구가 문서 그대로다", () => {
    expect(text).toContain("편지가 열리면 알려드릴까요?");
    expect(rendered).toContain('placeholder="이메일 (선택)"');
    expect(text).toContain("등록");
  });

  it("이메일 칸이 비어 있으면 연령 체크박스가 없다 (D-013)", () => {
    // 연령 확인은 **개인정보를 수집하는 순간에만** 붙는다. 빈 칸에도 띄우면 서비스
    // 전체 연령 게이트처럼 보인다.
    expect(text).not.toContain("만 14세 이상입니다");
    expect(rendered).not.toContain('type="checkbox"');
  });

  it("미체크 상태에서 등록이 비활성이다", () => {
    expect(rendered).toContain("disabled=\"\"");
  });

  it("건너뛰기가 이 화면에서 가장 눈에 띄는 동작이다", () => {
    // 03 §1-6 「이메일 없이 넘어가는 게 정상 경로다」. 건너뛰기가 PRIMARY, 등록이 SECONDARY다.
    expect(text).toContain("피드로 가기");
    const skip = rendered.indexOf("피드로 가기");
    const register = rendered.indexOf(">등록<");
    expect(skip).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(-1);
    expect(rendered.slice(0, skip)).toContain("bg-neutral-900");
  });
});

describe("09 §2 「실패하면」 — 재시도 1회 후 포기", () => {
  it("첫 시도가 실패해도 두 번째가 성공하면 email_sent가 남는다", async () => {
    let calls = 0;
    const sender: MailSender = async () => {
      calls += 1;
      if (calls === 1) throw new Error("일시 실패");
    };

    await deliver("manage_link", { to: "a@example.com", subject: "s", text: "t" }, sender);

    expect(calls).toBe(2);
    const { rows } = await query<{ name: string; props: { kind?: string } }>(
      "select name, props from events where name in ('email_sent','email_failed')",
    );
    expect(rows).toEqual([{ name: "email_sent", props: { kind: "manage_link" } }]);
  });

  it("두 번 다 실패하면 던지지 않고 email_failed만 남는다", async () => {
    let calls = 0;
    const sender: MailSender = async () => {
      calls += 1;
      throw new Error("계속 실패");
    };

    await expect(
      deliver("first_unlock", { to: "a@example.com", subject: "s", text: "t" }, sender),
    ).resolves.toBeUndefined();

    expect(calls).toBe(2);
    const { rows } = await query<{ name: string; props: { kind?: string } }>(
      "select name, props from events where name in ('email_sent','email_failed')",
    );
    expect(rows).toEqual([
      { name: "email_failed", props: { kind: "first_unlock" } },
    ]);
  });

  it("RESEND_API_KEY가 없으면 조용히 건너뛴다 — 이게 테스트·로컬의 정상 경로다", async () => {
    await expect(
      deliver("auto_hidden", { to: "a@example.com", subject: "s", text: "t" }, null),
    ).resolves.toBeUndefined();

    const { rowCount } = await query(
      "select 1 from events where name in ('email_sent','email_failed')",
    );
    expect(rowCount ?? 0).toBe(0);
  });
});
