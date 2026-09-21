// 파기 작업 — D-031 · migrations/0006 · src/lib/retention/purge.ts
//
// 두 방향을 함께 잰다.
//   · **지워야 할 것이 지워지는가** — 안 지워지면 보유기간 위반이 조용히 쌓인다
//   · **지우면 안 될 것이 남는가** — 과다 파기는 되돌릴 수 없다
//
// 두 번째가 없으면 "전부 지운다"가 첫 번째를 통과한다.

import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/letters/route";
import { query } from "@/lib/db";
import { overdueQuarantine, runPurgeJob } from "@/lib/retention/purge";
import { setRetentionHealthy } from "@/lib/settings";
import { insertLetter, randomFpHash } from "../fixtures/letters.ts";

/** 나이를 뒤로 미는 헬퍼. `interval`을 문자열로 받아 SQL에 그대로 준다. */
async function age(sql: string, params: unknown[] = []): Promise<void> {
  await query(sql, params);
}

async function countOf(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await query<{ count: string }>(sql, params);
  return Number(rows[0]?.count ?? -1);
}

/** 격리 행 하나를 만든다. 실제 봉인 경로를 타지 않고 값만 넣는다 — 여기서 재는 것은 시한이다. */
async function insertQuarantined(letterId: string, daysAgo: number): Promise<void> {
  await query(
    `insert into quarantine.letter_content
       (letter_id, content_ciphertext, content_iv, content_tag, quarantined_at)
     values ($1, $2, $3, $4, now() - make_interval(days => $5))`,
    [letterId, Buffer.from("x"), Buffer.alloc(12), Buffer.alloc(16), daysAgo],
  );
  await query(
    `update letters
        set quarantined_at = now() - make_interval(days => $2),
            body = null, hint = null, question = null,
            answer_hmac = null, answer_variant_hmacs = '{}'
      where id = $1`,
    [letterId, daysAgo],
  );
}

beforeEach(async () => {
  await setRetentionHealthy(true);
});

// docs/05-api.md §7 #28 · docs/00-decisions.md D-031
describe("safety#28 · 보유기간이 지난 데이터가 실제로 파기된다", () => {
  it("30일 지난 격리 본문이 파기된다", async () => {
    const { letter } = await insertLetter({ status: "hidden_auto" });
    await insertQuarantined(letter.id, 31);

    await runPurgeJob();

    expect(
      await countOf(
        "select count(*) as count from quarantine.letter_content where letter_id = $1",
        [letter.id],
      ),
    ).toBe(0);
  });

  it("3개월 지난 접속기록이 사라진다", async () => {
    await query(
      `insert into audit.access_log
         (ip_ciphertext, ip_iv, ip_tag, channel, captured_at)
       values ($1, $2, $3, 'app', now() - make_interval(days => 100))`,
      [Buffer.from("x"), Buffer.alloc(12), Buffer.alloc(16)],
    );
    const before = await countOf("select count(*) as count from audit.access_log");
    expect(before).toBeGreaterThan(0);

    await runPurgeJob();

    expect(
      await countOf(
        "select count(*) as count from audit.access_log where captured_at < now() - make_interval(days => 92)",
      ),
    ).toBe(0);
  });

  it("90일 지난 fp_hash가 익명화된다 — 32바이트가 남지 않는다", async () => {
    const { letter } = await insertLetter({ authorFpHash: randomFpHash() });
    await age("update letters set created_at = now() - make_interval(days => 100) where id = $1", [
      letter.id,
    ]);

    await runPurgeJob();

    const { rows } = await query<{ len: number }>(
      "select length(author_fp_hash) as len from letters where id = $1",
      [letter.id],
    );
    // 진짜 fp_hash는 HMAC-SHA256이라 32바이트다. 16이면 덮어썼다는 뜻이다.
    expect(rows[0]?.len).toBe(16);
  });

  it("90일 지난 원시 이벤트와 열람 시도가 사라진다", async () => {
    await query(
      `insert into events (name, session_id, created_at)
       values ('feed_view', 'purge-test', now() - make_interval(days => 100))`,
    );
    const { letter } = await insertLetter();
    await query(
      `insert into unlock_attempts (letter_id, fp_hash, succeeded, attempted_at)
       values ($1, $2, false, now() - make_interval(days => 100))`,
      [letter.id, randomFpHash()],
    );

    await runPurgeJob();

    expect(
      await countOf(
        "select count(*) as count from events where created_at < now() - make_interval(days => 90)",
      ),
    ).toBe(0);
    expect(
      await countOf(
        "select count(*) as count from unlock_attempts where attempted_at < now() - make_interval(days => 90)",
      ),
    ).toBe(0);
  });

  it("사건이 끝난 지 30일 지난 연락처·자유 텍스트가 비워진다", async () => {
    await query(
      `insert into deletion_requests (body_excerpt, contact, status, resolved_at)
       values ('본문 조각', 'a@example.com', 'resolved', now() - make_interval(days => 40))`,
    );
    const { letter } = await insertLetter({ status: "hidden_admin" });
    await query(
      `insert into appeals (letter_id, message, status, resolved_at)
       values ($1, '이의 제기 사유입니다', 'rejected', now() - make_interval(days => 40))`,
      [letter.id],
    );

    await runPurgeJob();

    expect(
      await countOf(
        "select count(*) as count from deletion_requests where contact is not null and resolved_at < now() - make_interval(days => 30)",
      ),
    ).toBe(0);
    expect(
      await countOf(
        "select count(*) as count from appeals where message is not null and resolved_at < now() - make_interval(days => 30)",
      ),
    ).toBe(0);
  });

  it("보유기간 안의 데이터는 건드리지 않는다", async () => {
    // 과다 파기는 되돌릴 수 없다. 이 단언이 없으면 "전부 지운다"가 위 전부를 통과한다.
    const fp = randomFpHash();
    const { letter } = await insertLetter({
      authorFpHash: fp,
      body: "최근 편지라 남아 있어야 한다",
    });
    await insertQuarantined(
      (await insertLetter({ status: "hidden_auto" })).letter.id,
      3,
    );

    await runPurgeJob();

    const { rows } = await query<{ body: string | null; len: number }>(
      "select body, length(author_fp_hash) as len from letters where id = $1",
      [letter.id],
    );
    expect(rows[0]?.body).toBe("최근 편지라 남아 있어야 한다");
    expect(rows[0]?.len).toBe(32);
    expect(
      await countOf(
        "select count(*) as count from quarantine.letter_content where quarantined_at > now() - make_interval(days => 30)",
      ),
    ).toBeGreaterThan(0);
  });
});

describe("파기를 멈추는 두 조건 (D-028 · D-031)", () => {
  it("legal_hold면 30일이 지나도 파기하지 않는다", async () => {
    const { letter } = await insertLetter({ status: "hidden_admin" });
    await insertQuarantined(letter.id, 100);
    await query(
      "update quarantine.letter_content set legal_hold = true where letter_id = $1",
      [letter.id],
    );

    await runPurgeJob();

    expect(
      await countOf(
        "select count(*) as count from quarantine.letter_content where letter_id = $1",
        [letter.id],
      ),
    ).toBe(1);
  });

  it("이의 제기가 열려 있으면 파기하지 않고 큐에 드러낸다", async () => {
    const { letter } = await insertLetter({ status: "hidden_admin" });
    await insertQuarantined(letter.id, 40);
    await query(
      "insert into appeals (letter_id, message, status) values ($1, '되살려 주세요', 'pending')",
      [letter.id],
    );

    const outcome = await runPurgeJob();

    expect(
      await countOf(
        "select count(*) as count from quarantine.letter_content where letter_id = $1",
        [letter.id],
      ),
    ).toBe(1);
    expect(outcome.quarantineHeld).toBeGreaterThan(0);
    // 조용히 남지 않는다 — 넘긴 사실이 운영 큐에 뜬다.
    const overdue = await overdueQuarantine();
    expect(overdue.map((item) => item.letterId)).toContain(letter.id);
  });
});

describe("파기가 실패하면 신규 작성이 막힌다 (D-031 · 세 번째 킬 스위치)", () => {
  it("retention_healthy가 꺼져 있으면 POST /api/letters가 503이고 편지가 생기지 않는다", async () => {
    // 파기되지 않는 상태에서 계속 받으면 위반 규모가 커진다. 멈추는 쪽이 낫다.
    const body = "파기가 멈춘 동안에는 이 편지가 만들어지면 안 된다.";
    await setRetentionHealthy(false);

    const response = await POST(
      new Request("http://localhost/api/letters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "open", relationship: "friend", body }),
      }),
    );

    expect(response.status).toBe(503);
    // 상태 코드만 보면 "503인데 저장됨"을 놓친다. 이 파일의 다른 테스트가 만든 편지가
    // 이미 있으므로 전체 건수가 아니라 **이 본문**이 없는지를 본다.
    expect(
      await countOf("select count(*) as count from letters where body = $1", [
        body,
      ]),
    ).toBe(0);
  });

  it("성공한 회차는 스위치를 다시 켠다", async () => {
    await setRetentionHealthy(false);
    await runPurgeJob();

    const { rows } = await query<{ value: unknown }>(
      "select value from app_settings where key = 'retention_healthy'",
    );
    expect(rows[0]?.value).toBe(true);
  });
});
