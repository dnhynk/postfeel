// src/lib/ratelimit.ts — 05-api §5
//
// 별도 카운터 테이블 없이 있는 테이블로 세는지 확인한다.

import { describe, expect, it } from "vitest";
import { query, withTransaction } from "@/lib/db";
import {
  LIMITS,
  countLettersByAuthor,
  countReportsByReporter,
  countUnlockAttemptsByFp,
  countUnlockAttemptsByLetter,
  countUnlockAttemptsByLetterAndFp,
  exceeded,
} from "@/lib/ratelimit";
import { insertLetter, randomFpHash } from "../fixtures/letters.ts";

const HOUR = 60 * 60 * 1000;

async function insertAttempt(
  letterId: string,
  fpHash: Buffer,
  attemptedAt: Date,
): Promise<void> {
  await query(
    `insert into unlock_attempts (letter_id, fp_hash, succeeded, attempted_at)
     values ($1, $2, false, $3)`,
    [letterId, fpHash, attemptedAt],
  );
}

describe("임계값 표 (05-api §5)", () => {
  it("문서의 숫자를 그대로 옮겼다", () => {
    expect(LIMITS.letterCreatePerHour).toEqual({ limit: 10, windowMs: HOUR });
    expect(LIMITS.letterCreatePerMinute).toEqual({ limit: 3, windowMs: 60_000 });
    expect(LIMITS.unlockPerLetterAndFpPerDay.limit).toBe(3);
    expect(LIMITS.unlockPerLetterPerDay.limit).toBe(50);
    expect(LIMITS.unlockPerFpPer10Min).toEqual({
      limit: 30,
      windowMs: 10 * 60_000,
    });
    expect(LIMITS.reportPerDay.limit).toBe(20);
    expect(LIMITS.contactCreatePerHour.limit).toBe(5);
  });

  it("exceeded는 한도를 채운 순간부터 true다", () => {
    expect(exceeded(2, LIMITS.letterCreatePerMinute)).toBe(false);
    expect(exceeded(3, LIMITS.letterCreatePerMinute)).toBe(true);
  });
});

describe("작성 — letters.author_fp_hash로 센다", () => {
  it("창 안의 편지만 센다", async () => {
    const fp = randomFpHash();
    await insertLetter({ authorFpHash: fp });
    await insertLetter({ authorFpHash: fp });
    // 창 밖(2시간 전)은 세지 않는다.
    await insertLetter({
      authorFpHash: fp,
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    // 다른 사람의 편지도 세지 않는다.
    await insertLetter({ authorFpHash: randomFpHash() });

    expect(await countLettersByAuthor(fp, HOUR)).toBe(2);
  });
});

describe("열람 — unlock_attempts로 센다", () => {
  it("(letter, fp) · letter 전역 · fp 전역이 각각 독립으로 센다", async () => {
    const { letter: a } = await insertLetter();
    const { letter: b } = await insertLetter();
    const fp = randomFpHash();
    const other = randomFpHash();
    const now = new Date();

    await insertAttempt(a.id, fp, now);
    await insertAttempt(a.id, fp, now);
    await insertAttempt(a.id, other, now);
    await insertAttempt(b.id, fp, now);

    expect(await countUnlockAttemptsByLetterAndFp(a.id, fp, HOUR)).toBe(2);
    // fp를 갈아치워도 letter 전역 한도는 따로 찬다 (안전 테스트 6).
    expect(await countUnlockAttemptsByLetter(a.id, HOUR)).toBe(3);
    expect(await countUnlockAttemptsByFp(fp, HOUR)).toBe(3);
  });

  it("창 밖의 시도는 세지 않는다", async () => {
    const { letter } = await insertLetter();
    const fp = randomFpHash();
    await insertAttempt(letter.id, fp, new Date(Date.now() - 2 * HOUR));
    expect(await countUnlockAttemptsByLetterAndFp(letter.id, fp, HOUR)).toBe(0);
  });

  it("트랜잭션 클라이언트로도 셀 수 있다 — 삽입과 카운트를 한 트랜잭션에 묶는다", async () => {
    // 05-api §5: 열람 시도만 이렇게 묶는다. 여기만 초과의 대가가 "잠긴 편지가 열린다"다.
    const { letter } = await insertLetter();
    const fp = randomFpHash();

    const count = await withTransaction(async (client) => {
      await client.query(
        `insert into unlock_attempts (letter_id, fp_hash, succeeded)
         values ($1, $2, false)`,
        [letter.id, fp],
      );
      return countUnlockAttemptsByLetterAndFp(letter.id, fp, HOUR, client);
    });

    // 커밋 전에도 자기 트랜잭션이 넣은 행이 보인다.
    expect(count).toBe(1);
  });
});

describe("신고 — reports.reporter_fp_hash로 센다", () => {
  it("창 안의 신고만 센다", async () => {
    const { letter } = await insertLetter();
    const fp = randomFpHash();
    await query(
      `insert into reports (letter_id, reason, reporter_fp_hash, created_at)
       values ($1, 'spam', $2, now()), ($1, 'other', $2, now() - interval '2 hours')`,
      [letter.id, fp],
    );
    expect(await countReportsByReporter(fp, HOUR)).toBe(1);
  });
});
