// 법정 접속기록 — D-030 · migrations/0004 · src/lib/access-log.ts
//
// 이 번호가 지키는 것은 **없어야 할 것이 없다**는 성질이다. 있어야 할 것이 있는지를
// 재는 다른 번호들과 방향이 반대라, 통과해도 화면에서는 아무것도 보이지 않는다.
// 그래서 테스트가 아니면 아무도 깨진 것을 모른다.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { channelOf, recordAccess } from "@/lib/access-log";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

// docs/05-api.md §7 #26 · docs/00-decisions.md D-030 · docs/04-data-model.md
describe("safety#26 · 법정 접속기록이 서비스 데이터와 연결되지 않는다", () => {
  // D-030이 금지한 목록 그대로. 하나라도 컬럼으로 생기면 "이 편지를 누가 썼는가"에
  // 답할 수 있게 되고, 무계정으로 얻은 익명성이 그 순간 끝난다.
  const FORBIDDEN = [
    "letter_id",
    "letterid",
    "session_id",
    "sessionid",
    "fp_hash",
    "fphash",
    "email",
    "user_agent",
    "useragent",
    "referer",
    "referrer",
    "query_string",
    "querystring",
    "body",
    "hint",
    "question",
    "answer",
    "cookie",
    "request_id",
    "requestid",
  ];

  it("금지된 컬럼이 하나도 없다", async () => {
    const { rows } = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'audit' and table_name = 'access_log'`,
    );
    expect(rows.length).toBeGreaterThan(0); // 표가 실제로 있다

    const names = rows.map((row) => row.column_name.toLowerCase());
    for (const forbidden of FORBIDDEN) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("다른 표로 향하는 외래키가 없다", async () => {
    // 조인 키를 두지 않는다 (D-030). 외래키가 하나라도 생기면 조인이 가능해진다.
    const { rows } = await query<{ count: string }>(
      `select count(*) as count
         from information_schema.table_constraints
        where table_schema = 'audit'
          and table_name = 'access_log'
          and constraint_type = 'FOREIGN KEY'`,
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });

  it("`public` 스키마가 아니다 — 논리적으로 분리돼 있다", async () => {
    const { rows } = await query<{ count: string }>(
      `select count(*) as count from information_schema.tables
        where table_schema = 'public' and table_name = 'access_log'`,
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });

  it("이 표를 읽는 코드가 src/에 없다", async () => {
    // D-030: 앱 일반 코드는 **쓰기만** 가능하다. DB 권한 분리는 배포 시 하고,
    // 코드 쪽 방어는 읽는 경로를 만들지 않는 것이다 (access-log.ts 주석).
    const offenders = filesUnder(SRC).filter((file) => {
      if (!/\.(ts|tsx)$/.test(file)) return false;
      const source = readFileSync(file, "utf8");
      if (!source.includes("access_log")) return false;
      // 유일하게 허용되는 문장은 INSERT다.
      return /select[\s\S]{0,200}?access_log/i.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe("접속기록의 저장 형태 (D-030)", () => {
  it("원본 IP가 평문으로 저장되지 않는다", async () => {
    const ip = "203.0.113.77";
    await recordAccess(ip, "app");

    // 봉인된 바이트 어디에도 평문이 없어야 한다. 컬럼을 하나씩 세지 않고
    // 행 전체를 문자열로 만들어 찾는다 — 컬럼이 늘어도 이 단언은 유효하다.
    const { rows } = await query<{ dump: string }>(
      `select access_log::text as dump from audit.access_log
        order by id desc limit 1`,
    );
    expect(rows[0]?.dump).toBeDefined();
    expect(rows[0]?.dump).not.toContain(ip);
  });

  it("같은 IP를 두 번 남겨도 저장된 값이 서로 다르다", async () => {
    // IV가 매번 새로 나오므로 같은 IP가 같은 바이트로 남지 않는다. 같은 값이면
    // 저장된 것만 보고 "같은 사람이 두 번 왔다"를 셀 수 있게 된다.
    const ip = "198.51.100.9";
    await recordAccess(ip, "app");
    await recordAccess(ip, "app");

    const { rows } = await query<{ ct: Buffer }>(
      `select ip_ciphertext as ct from audit.access_log
        order by id desc limit 2`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ct.equals(rows[1]!.ct)).toBe(false);
  });
});

describe("요청 분류는 작성과 열람을 구분하지 않는다 (D-030)", () => {
  // 구분하면 letters.created_at과 captured_at을 맞춰 "이 IP가 이 시각에 편지를 썼다"가
  // 나온다. 조인 키를 없앤 이유가 그 자리에서 무너진다.
  it("편지 작성과 피드 열람이 같은 분류로 접힌다", () => {
    expect(channelOf("/api/letters")).toBe("app");
    expect(channelOf("/api/feed")).toBe("app");
    expect(channelOf("/write")).toBe("app");
    expect(channelOf("/m/abc123")).toBe("app");
    expect(channelOf("/api/letters/abc123/unlock")).toBe("app");
  });

  it("운영자와 크론만 갈라진다", () => {
    expect(channelOf("/admin/queue")).toBe("admin");
    expect(channelOf("/api/admin/settings")).toBe("admin");
    expect(channelOf("/api/cron/reclassify")).toBe("cron");
  });
});
