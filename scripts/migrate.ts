// 마이그레이션 러너.
//
// D-018이 "마이그레이션은 raw SQL 파일"로 못박았으므로 ORM도 마이그레이션 프레임워크도 쓰지 않는다.
// migrations/*.sql을 파일명 순서로 한 번씩만 적용하고, 적용 기록을 schema_migrations에 남긴다.
//
//   node scripts/migrate.ts            아직 적용되지 않은 마이그레이션만 적용 (idempotent)
//   node scripts/migrate.ts --reset    DATABASE_URL의 DB를 드롭 후 재생성하고 전부 다시 적용
//
// 이 파일은 로컬 import가 없다 — Node의 타입 스트리핑으로 그대로 실행되게 두기 위해서다.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

const SCHEMA_MIGRATIONS = `
create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);`;

/** Postgres 식별자 인용. DB 이름은 파라미터 바인딩이 안 되는 자리에 들어간다. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 같은 서버의 다른 DB(기본 `postgres`)를 가리키는 URL. CREATE/DROP DATABASE용. */
export function adminUrl(databaseUrl: string, database = "postgres"): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** URL이 가리키는 DB 이름. */
export function databaseNameOf(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!name) throw new Error(`DATABASE_URL에 DB 이름이 없다: ${databaseUrl}`);
  return name;
}

/** 아직 적용되지 않은 마이그레이션을 순서대로 적용하고, 실제로 적용한 버전 목록을 돌려준다. */
export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(SCHEMA_MIGRATIONS);
    const { rows } = await client.query<{ version: string }>(
      "select version from schema_migrations",
    );
    const done = new Set(rows.map((row) => row.version));

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      // 한 마이그레이션은 통째로 성공하거나 통째로 없던 일이 된다.
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into schema_migrations (version) values ($1)",
          [version],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`마이그레이션 실패: ${file}`, { cause: error });
      }
      applied.push(version);
    }
  } finally {
    await client.end();
  }

  return applied;
}

/**
 * DATABASE_URL이 가리키는 DB를 드롭하고 다시 만든다. 로컬 개발용.
 *
 * 원격 호스트에서는 기본적으로 거부한다 — 이 명령의 실패 모드가 "운영 DB가 사라졌다"이고,
 * 그건 되돌릴 수 없다. 정말 필요하면 --force.
 */
export async function resetDatabase(
  databaseUrl: string,
  options: { force?: boolean } = {},
): Promise<string> {
  const name = databaseNameOf(databaseUrl);
  const host = new URL(databaseUrl).hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocal && !options.force) {
    throw new Error(
      `db:reset은 로컬 DB만 드롭한다. host=${host}. 정말 원하면 --force.`,
    );
  }

  const client = new Client({ connectionString: adminUrl(databaseUrl) });
  await client.connect();
  try {
    await client.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(`drop database if exists ${quoteIdent(name)}`);
    await client.query(`create database ${quoteIdent(name)}`);
  } finally {
    await client.end();
  }
  return name;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL이 없다. .env.example을 참고해 설정한다.");
  }

  if (process.argv.includes("--reset")) {
    const name = await resetDatabase(databaseUrl, {
      force: process.argv.includes("--force"),
    });
    console.log(`드롭 후 재생성: ${name}`);
  }

  const applied = await runMigrations(databaseUrl);
  if (applied.length === 0) {
    console.log("적용할 마이그레이션 없음 (이미 최신)");
  } else {
    for (const version of applied) console.log(`적용: ${version}`);
  }
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
