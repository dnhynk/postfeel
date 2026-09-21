// src/lib/letters/deletion.ts — 04 §3 상태 기계 · L-007 격리 지점

import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { autoHide, deleteByAuthor, hideByAdmin } from "@/lib/letters/deletion";
import {
  notifyAutoHidden,
  notifyFirstUnlock,
  type MailSender,
  type OutgoingMail,
} from "@/lib/notify/email";
import { insertLetter } from "../fixtures/letters.ts";

async function statusOf(
  id: string,
): Promise<{ status: string; deleted_at: Date | null }> {
  const { rows } = await query<{ status: string; deleted_at: Date | null }>(
    "select status, deleted_at from letters where id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error("편지가 없다.");
  return row;
}

describe("deleteByAuthor — 현재 정책은 soft delete다 (04 §3)", () => {
  it("status와 deleted_at을 함께 세운다", async () => {
    const { letter } = await insertLetter();
    expect(await deleteByAuthor(letter.id)).toBe(true);

    const row = await statusOf(letter.id);
    expect(row.status).toBe("deleted_by_author");
    expect(row.deleted_at).toBeInstanceOf(Date);
  });

  it("이미 지운 편지에는 false — 관리 화면이 410을 돌려줄 수 있게 (05-api §2)", async () => {
    const { letter } = await insertLetter();
    await deleteByAuthor(letter.id);
    expect(await deleteByAuthor(letter.id)).toBe(false);
  });

  it("비공개 상태에서도 지울 수 있다", async () => {
    const { letter } = await insertLetter({ status: "hidden_admin" });
    expect(await deleteByAuthor(letter.id)).toBe(true);
    expect((await statusOf(letter.id)).status).toBe("deleted_by_author");
  });

  it("없는 편지에는 false", async () => {
    expect(await deleteByAuthor("존재하지않는편지")).toBe(false);
  });
});

// ── 편지를 지우면 이메일도 지운다 (04 §1-3 · 07 §5 · 09 §4) ──
//
// `author_contacts.letter_id`에 `on delete cascade`가 있지만 삭제가 soft delete라
// cascade가 돌지 않는다. 그래서 deleteByAuthorTx가 명시적으로 지운다.

async function insertContact(letterId: string): Promise<void> {
  await query(
    `insert into author_contacts (letter_id, email, unsubscribe_token)
     values ($1, $2, $3)`,
    [letterId, "author@example.com", `unsub-${letterId}`],
  );
}

async function contactCount(letterId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from author_contacts where letter_id = $1",
    [letterId],
  );
  return Number(rows[0]?.count ?? 0);
}

function recorder(): { sent: OutgoingMail[]; sender: MailSender } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    sender: async (mail) => {
      sent.push(mail);
    },
  };
}

describe("작성자 삭제는 author_contacts 행을 함께 지운다", () => {
  it("행이 없어지고, 이후 발송 시도가 아무것도 보내지 않는다", async () => {
    const { letter } = await insertLetter();
    await insertContact(letter.id);

    expect(await deleteByAuthor(letter.id)).toBe(true);
    expect(await contactCount(letter.id)).toBe(0);

    // 09 §4 「행을 지우면 발송이 전부 멈춘다」. 선점 UPDATE도 조회도 0행을 받는다.
    const unlock = recorder();
    await notifyFirstUnlock(letter.id, unlock.sender);
    expect(unlock.sent).toEqual([]);

    const hidden = recorder();
    await notifyAutoHidden(letter.id, hidden.sender);
    expect(hidden.sent).toEqual([]);
  });

  it("email_suppressions에는 넣지 않는다 — 삭제는 거부가 아니다 (09 §1)", async () => {
    // 넣으면 같은 사람이 새 편지에 같은 주소를 등록하려 할 때 막힌다.
    const { letter } = await insertLetter();
    await insertContact(letter.id);
    await deleteByAuthor(letter.id);

    const { rows } = await query("select 1 from email_suppressions");
    expect(rows).toHaveLength(0);
  });

  it("hidden_auto에서는 행이 남는다 — 3번 메일이 그 상태를 알리는 메일이다", async () => {
    // 여기서 지우면 작성자가 자기 편지가 내려간 걸 영영 모른다. 되살아날 수도 있다.
    const { letter } = await insertLetter();
    await insertContact(letter.id);

    expect(await autoHide(letter.id)).toBe(true);
    expect(await contactCount(letter.id)).toBe(1);
  });

  it("hidden_admin에서도 행이 남는다 — 이의 제기로 복귀할 수 있다", async () => {
    const { letter } = await insertLetter();
    await insertContact(letter.id);

    expect(await hideByAdmin(letter.id, null)).toBe(true);
    expect(await contactCount(letter.id)).toBe(1);
  });
});

describe("autoHide — 신고 1건에 의한 자동 비공개 (02 §4)", () => {
  it("published를 hidden_auto로 내린다", async () => {
    const { letter } = await insertLetter();
    expect(await autoHide(letter.id)).toBe(true);
    expect((await statusOf(letter.id)).status).toBe("hidden_auto");
  });

  it("이미 지운 편지를 되살리지 않는다", async () => {
    const { letter } = await insertLetter();
    await deleteByAuthor(letter.id);
    expect(await autoHide(letter.id)).toBe(false);
    expect((await statusOf(letter.id)).status).toBe("deleted_by_author");
  });
});

describe("hideByAdmin — 운영자 조치 (04 §3 · 05-api §4)", () => {
  it("hidden_admin으로 내리고 admin_actions에 기록한다", async () => {
    const { letter } = await insertLetter();
    expect(await hideByAdmin(letter.id, "신상 노출")).toBe(true);
    expect((await statusOf(letter.id)).status).toBe("hidden_admin");

    const { rows } = await query<{ action: string; note: string }>(
      "select action, note from admin_actions where target_id = $1",
      [letter.id],
    );
    expect(rows).toEqual([{ action: "hide_letter", note: "신상 노출" }]);
  });

  it("이미 지운 편지에는 아무것도 하지 않는다 — 기록도 남기지 않는다", async () => {
    const { letter } = await insertLetter();
    await deleteByAuthor(letter.id);

    expect(await hideByAdmin(letter.id, "뒤늦은 조치")).toBe(false);
    const { rows } = await query(
      "select 1 from admin_actions where target_id = $1",
      [letter.id],
    );
    expect(rows).toHaveLength(0);
  });
});
