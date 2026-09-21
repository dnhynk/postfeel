// 발송 표면 — 이메일 4종 (Resend)
//
// 안전 회귀 테스트. 기능 테스트가 아니라 **배포를 막는 테스트**다.
//
// ── 실제 발송은 절대 하지 않는다 ────────────────────────────
// `.env.test`의 `RESEND_API_KEY`는 비어 있고, 여기서는 그 위에 두 겹을 더 둔다:
//   · 빈도·문구 검증은 `MailSender`를 주입해서 본다 (email.ts의 주입 지점)
//   · 전송 계층은 `fetch`를 스텁으로 바꿔 본다 (#20의 HTTP 페이로드 단언)
// 두 경로 어디에도 진짜 네트워크 호출이 없다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postContact } from "@/app/api/manage/[token]/contact/route";
import UnsubscribePage from "@/app/unsubscribe/[token]/page";
import { query } from "@/lib/db";
import {
  MAIL_FROM,
  notifyAutoHidden,
  notifyFirstUnlock,
  notifyManageLink,
  notifyRecipientYes,
  sendViaResend,
  type MailSender,
  type OutgoingMail,
} from "@/lib/notify/email";
import { emailHash } from "@/lib/notify/suppression";
import { insertLetter, randomFpHash } from "../fixtures/letters.ts";

/** 어떤 메일에도 나오면 안 되는 문자열. 편지 본문이다. */
const BODY = "그날 네가 먼저 미안하다고 했는데 나는 아무 말도 못 했다.";

const UNSUBSCRIBE_NOTICE = "이 알림을 요청한 적이 없다면 여기서 끄세요.";

function recorder(): { sent: OutgoingMail[]; sender: MailSender } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    sender: async (mail) => {
      sent.push(mail);
    },
  };
}

async function insertContact(letterId: string, email: string): Promise<string> {
  const token = `unsub-${letterId}`;
  await query(
    `insert into author_contacts (letter_id, email, unsubscribe_token)
     values ($1, $2, $3)`,
    [letterId, email, token],
  );
  return token;
}

/** 열람 기록 한 건. 서로 다른 사람이 열었다는 뜻으로 fp를 매번 새로 만든다 (04 §2). */
async function insertUnlock(
  letterId: string,
  response: "yes" | "no" | "unknown" | null = null,
): Promise<string> {
  const unlockId = `unlock-${letterId}-${Math.random().toString(36).slice(2, 10)}`;
  await query(
    `insert into unlocks (unlock_id, letter_id, fp_hash, recipient_response, responded_at)
     values ($1, $2, $3, $4, case when $4::text is null then null else now() end)`,
    [unlockId, letterId, randomFpHash(), response],
  );
  return unlockId;
}

/** 편지 하나 + 이메일 등록 하나. 네 종 전부의 출발점이다. */
async function letterWithContact(email = "author@example.com") {
  const { letter, manageToken } = await insertLetter({ body: BODY });
  const unsubscribeToken = await insertContact(letter.id, email);
  return { letter, manageToken, unsubscribeToken, email };
}

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

/** 해지 링크를 한 번 여는 것 = 이 호출. 확인 화면도 두 번째 요청도 없다 (09 §1). */
async function clickUnsubscribe(token: string, kind: string): Promise<string> {
  const element = await UnsubscribePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve({ k: kind }),
  });
  return renderToStaticMarkup(element).replace(/<[^>]*>/g, " ");
}

beforeEach(async () => {
  await query("delete from events");
});

// docs/09-notifications.md §6 #18 · §1 · docs/00-decisions.md D-006 · D-019
describe("safety#18 · 해지 링크를 누르면 author_contacts 행이 지워지고 이후 발송이 없다", () => {
  // 행만 지우면 "이 주소는 거부했다"는 기록도 사라져 재등록이 그대로 성공한다.
  // 그래서 email_suppressions에 주소 해시만 남긴다.
  it("해지 링크 1회 클릭으로 확인 화면 없이 행이 지워진다", async () => {
    const { letter, unsubscribeToken, email } = await letterWithContact(
      "wrong-person@example.com",
    );

    const rendered = await clickUnsubscribe(unsubscribeToken, "first_unlock");

    // 화면은 결과만 보여준다 (03 화면 목록). 확인 버튼도, 두 번째 요청도 없다.
    expect(rendered).toContain("알림을 껐습니다.");

    const { rowCount } = await query(
      "select 1 from author_contacts where letter_id = $1",
      [letter.id],
    );
    expect(rowCount ?? 0).toBe(0);

    // 원문 주소는 억제 목록에도 없다 — 해시만 남는다 (09 §1 · 04 §1-3).
    const { rows } = await query<{ email_hash: Buffer }>(
      "select email_hash from email_suppressions",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email_hash.equals(emailHash(email))).toBe(true);
    expect(JSON.stringify(rows[0])).not.toContain("wrong-person@example.com");
  });

  it("같은 주소를 다시 등록하려 하면 400이고 저장되지 않는다", async () => {
    const { unsubscribeToken, email } = await letterWithContact(
      "wrong-person@example.com",
    );
    await clickUnsubscribe(unsubscribeToken, "first_unlock");

    // 작성자가 다른 편지에 같은 주소를 다시 넣는다. 대소문자·공백은 normalize가 흡수한다.
    const { letter: another, manageToken } = await insertLetter();
    const response = await postContact(
      new Request(`http://localhost/api/manage/${manageToken}/contact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `  ${email.toUpperCase()}  `,
          ageConfirmed: true,
        }),
      }),
      { params: Promise.resolve({ token: manageToken }) },
    );

    expect(response.status).toBe(400);
    // **문구까지 본다.** 형식 오류로도 400이 나기 때문에 상태 코드만 보면 "공백 때문에
    // 막혔는데 억제가 작동한다고 착각하는" 초록이 만들어진다 — 실제로 한 번 그랬다.
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message:
          "이 주소로는 알림을 보낼 수 없습니다. 이전에 알림을 끈 주소입니다.",
      },
    });
    const { rowCount } = await query(
      "select 1 from author_contacts where letter_id = $1",
      [another.id],
    );
    expect(rowCount ?? 0).toBe(0);
  });

  it("해지한 뒤에는 어떤 메일도 나가지 않는다", async () => {
    const { letter, unsubscribeToken } = await letterWithContact();
    const unlockId = await insertUnlock(letter.id, "yes");

    await clickUnsubscribe(unsubscribeToken, "manage_link");

    const { sent, sender } = recorder();
    await notifyFirstUnlock(letter.id, sender);
    await notifyRecipientYes(unlockId, sender);
    await notifyAutoHidden(letter.id, sender);

    expect(sent).toEqual([]);
  });
});

// docs/09-notifications.md §6 #19 · §2 「2번은 편지당 딱 한 통이다」
describe("safety#19 · 같은 편지가 두 번 열려도 '누군가 열었습니다'는 한 통만 나간다", () => {
  // 잠긴 편지는 제3자도 연다. 열릴 때마다 보내면 알림이 아니라 소음이 된다.
  // first_unlock_notified_at으로 고정한다.
  it("서로 다른 fp가 두 번 열어도 발송은 1회다", async () => {
    const { letter } = await letterWithContact();
    await insertUnlock(letter.id);
    await insertUnlock(letter.id);

    const { sent, sender } = recorder();
    // 해제 표면이 열람 성공마다 부르는 함수다. 두 번 열렸다 = 두 번 불렸다.
    await notifyFirstUnlock(letter.id, sender);
    await notifyFirstUnlock(letter.id, sender);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("누군가 편지를 열었습니다");

    const { rows } = await query<{ first_unlock_notified_at: Date | null }>(
      "select first_unlock_notified_at from author_contacts where letter_id = $1",
      [letter.id],
    );
    expect(rows[0]?.first_unlock_notified_at).not.toBeNull();
  });

  it("동시에 두 번 열려도 1회다 — 선점이 UPDATE 한 방이라", async () => {
    const { letter } = await letterWithContact();

    const { sent, sender } = recorder();
    await Promise.all([
      notifyFirstUnlock(letter.id, sender),
      notifyFirstUnlock(letter.id, sender),
    ]);

    expect(sent).toHaveLength(1);
  });

  it("해제 표면이 실제로 이 함수를 부른다", () => {
    // 빈도를 아무리 고정해도 부르는 자리가 없으면 메일이 안 나간다. 반대로 조건문으로
    // 빈도를 지키게 만들면 그 조건문이 언젠가 느슨해진다 — 그래서 표면은 부르기만 한다.
    //
    // 부르는 형태가 F5에서 바뀌었다: 맨 프로미스(`void ...`)는 서버리스에서 응답이 나간
    // 뒤 조용히 사라질 수 있어 `after()` 예약으로 감쌌다 (src/lib/notify/schedule.ts).
    // **성질은 그대로다** — 표면은 여전히 부르기만 하고 빈도는 UPDATE가 지킨다. 맨
    // 프로미스로 되돌아가면 아래 두 번째 단언이 걸린다.
    const route = source("src/app/api/letters/[id]/unlock/route.ts");
    expect(route).toContain(
      'scheduleAfterResponse("first_unlock", () => notifyFirstUnlock(id))',
    );
    expect(route).not.toContain("void notifyFirstUnlock");
  });
});

// docs/09-notifications.md §6 #20 · §2 「본문을 메일에 넣지 않는다」
describe("safety#20 · 어떤 메일에도 편지 본문이 포함되지 않는다", () => {
  // 메일은 전달·인용되며 우리 통제를 벗어나고, 편지를 지워도 메일함에 남는다.
  it("4종 메일 본문 어디에도 편지 body 문자열이 없다", async () => {
    const { letter, manageToken, unsubscribeToken, email } =
      await letterWithContact();
    const unlockId = await insertUnlock(letter.id, "yes");

    const { sent, sender } = recorder();
    await notifyManageLink(
      { email, unsubscribeToken, manageToken },
      sender,
    );
    await notifyFirstUnlock(letter.id, sender);
    await notifyAutoHidden(letter.id, sender);
    await notifyRecipientYes(unlockId, sender);

    expect(sent).toHaveLength(4);
    expect(sent.map((mail) => mail.subject)).toEqual([
      // 09 §2의 제목 열 그대로다.
      "편지 관리 링크",
      "누군가 편지를 열었습니다",
      "편지가 비공개로 바뀌었습니다",
      "편지를 연 사람이 답을 남겼습니다",
    ]);

    for (const mail of sent) {
      const whole = `${mail.subject}\n${mail.text}`;
      expect(whole).not.toContain(BODY);
      // 본문 조각도 안 된다. 앞 12자만 잘라 넣는 식의 "요약"도 여기서 막힌다.
      expect(whole).not.toContain(BODY.slice(0, 12));
      // 09 §1 — 해지 링크는 모든 메일 하단. 예외 없음.
      expect(whole).toContain(UNSUBSCRIBE_NOTICE);
      expect(whole).toContain(`/unsubscribe/${unsubscribeToken}?k=`);
    }
  });

  it("전송 계층이 실어 보내는 페이로드에도 본문이 없다", async () => {
    const { letter, unsubscribeToken } = await letterWithContact();

    // 여기서만 fetch를 스텁으로 바꾼다. 실제 네트워크 호출은 일어나지 않는다.
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url: String(url), body: String(init.body) });
        return new Response(null, { status: 200 });
      }),
    );

    try {
      await notifyFirstUnlock(letter.id, (mail) =>
        sendViaResend(mail, "test-key-not-a-real-secret"),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as {
      from: string;
      to: string;
      subject: string;
      text: string;
      html?: string;
    };
    expect(payload.from).toBe(MAIL_FROM);
    expect(payload.html).toBeUndefined();
    expect(calls[0]?.body).not.toContain(BODY);
    expect(payload.text).toContain(UNSUBSCRIBE_NOTICE);
    expect(payload.text).toContain(`/unsubscribe/${unsubscribeToken}?k=first_unlock`);
  });
});

// docs/09-notifications.md §6 #24 · §2 「4번의 문구는 신원을 주장하지 않는다」 · D-023
describe("safety#24 · no·unknown·무응답에는 4번 메일이 나가지 않고 yes가 두 번 와도 한 통만 나간다", () => {
  // 안 온 답을 알릴 이유가 없다. recipient_yes_notified_at으로 편지당 1회를 고정한다.
  it("recipient_response가 no·unknown이거나 없으면 발송이 없다", async () => {
    const { sent, sender } = recorder();

    for (const response of ["no", "unknown", null] as const) {
      const { letter } = await letterWithContact(`a-${response}@example.com`);
      const unlockId = await insertUnlock(letter.id, response);

      await notifyRecipientYes(unlockId, sender);

      const { rows } = await query<{ recipient_yes_notified_at: Date | null }>(
        "select recipient_yes_notified_at from author_contacts where letter_id = $1",
        [letter.id],
      );
      // 보내지 않았을 뿐 아니라 "보냈다"고 표시하지도 않는다.
      expect(rows[0]?.recipient_yes_notified_at).toBeNull();
    }

    expect(sent).toEqual([]);
  });

  it("yes 응답이 두 번 와도 발송은 1회다", async () => {
    const { letter } = await letterWithContact();
    // 두 사람이 열고 둘 다 "나에게 온 것 같아요"를 눌렀다.
    const first = await insertUnlock(letter.id, "yes");
    const second = await insertUnlock(letter.id, "yes");

    const { sent, sender } = recorder();
    await notifyRecipientYes(first, sender);
    await notifyRecipientYes(second, sender);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("편지를 연 사람이 답을 남겼습니다");
    // D-023 — 주어는 "편지를 연 사람"이다. 신원을 주장하지 않는다.
    expect(sent[0]?.text).toContain(
      '편지를 연 사람이 "나에게 온 것 같다"고 답했습니다.',
    );
    expect(sent[0]?.text).not.toContain("상대가");
  });

  it("응답 표면은 처음 기록된 yes에만 이 함수를 부른다", () => {
    const route = source("src/app/api/unlocks/[unlockId]/response/route.ts");
    expect(route).toContain(
      'if (result === "recorded" && parsed.data.response === "yes")',
    );
  });
});
