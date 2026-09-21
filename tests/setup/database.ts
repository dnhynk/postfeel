// 테스트용 데이터베이스를 만들고 지우는 헬퍼.
//
// 요구: 여러 워커가 각자 워크트리에서 같은 Postgres 컨테이너를 향해 동시에 테스트를
// 돌려도 서로를 깨뜨리지 않아야 한다. 그래서 공유 DB를 재사용하지 않고, 실행마다
// 새 DB를 만들고 끝나면 지운다. 이름에 실행 ID가 들어가 있어 다른 실행과 겹치지 않는다.

import { randomBytes } from "node:crypto";
import pg from "pg";
import { adminUrl, quoteIdent } from "../../scripts/migrate.ts";

const { Client } = pg;

/** 도커 컨테이너 postfeel-pg. DATABASE_URL이 없을 때의 폴백. */
const LOCAL_FALLBACK_URL =
  "postgresql://postfeel:postfeel@localhost:54329/postfeel";

/** 테스트가 붙을 서버. 이 URL이 가리키는 DB 자체는 건드리지 않는다. */
export function baseDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? LOCAL_FALLBACK_URL;
}

export function urlForDatabase(name: string): string {
  const url = new URL(baseDatabaseUrl());
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

export function randomId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

async function withAdminClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  // CREATE/DROP DATABASE는 대상 DB에 접속한 채로는 못 한다.
  const client = new Client({ connectionString: adminUrl(baseDatabaseUrl()) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createDatabase(
  name: string,
  template?: string,
): Promise<void> {
  const from = template ? ` template ${quoteIdent(template)}` : "";
  await withAdminClient((client) =>
    client.query(`create database ${quoteIdent(name)}${from}`),
  );
}

export async function dropDatabase(name: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(`drop database if exists ${quoteIdent(name)}`);
  });
}

/** 이 실행이 만든 DB를 이름 패턴으로 전부 지운다. 중간에 죽었을 때의 청소용. */
export async function dropDatabasesLike(pattern: string): Promise<string[]> {
  const names = await withAdminClient(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      "select datname from pg_database where datname like $1",
      [pattern],
    );
    return rows.map((row) => row.datname);
  });
  for (const name of names) await dropDatabase(name);
  return names;
}

export const templateDatabaseName = (runId: string) => `postfeel_tmpl_${runId}`;
export const testDatabasePattern = (runId: string) => `postfeel_test_${runId}_%`;
export const testDatabaseName = (runId: string) =>
  `postfeel_test_${runId}_${randomId(4)}`;
