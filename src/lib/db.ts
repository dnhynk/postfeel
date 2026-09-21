// Postgres 접근. raw SQL만 쓴다 (D-018). ORM도 쿼리 빌더도 두지 않는다.
//
// 서버리스(D-018)라 인스턴스가 수시로 새로 뜨고 죽는다. 그래서 커넥션 풀 말고는
// 프로세스 로컬 상태를 만들지 않는다 — 레이트리밋 카운트, 킬 스위치 값, 캐시 전부
// Postgres에서 읽는다 (05-api §5 · §6).

import pg from "pg";
import { env } from "./env";

const { Pool } = pg;

// 풀 자체는 프로세스 로컬 상태지만 캐시가 아니라 소켓 관리다.
// globalThis에 두는 이유는 dev HMR과 테스트 재적재에서 풀이 누적되는 걸 막기 위해서다.
const globalForDb = globalThis as typeof globalThis & {
  __postfeelPool?: pg.Pool;
};

function getPool(): pg.Pool {
  if (!globalForDb.__postfeelPool) {
    globalForDb.__postfeelPool = new Pool({
      connectionString: env.DATABASE_URL,
      // 서버리스 인스턴스 하나가 동시에 처리하는 요청은 많지 않다.
      // 인스턴스 수만큼 곱해지므로 인스턴스당 풀은 작게 잡는다.
      max: 5,
    });
  }
  return globalForDb.__postfeelPool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, params as unknown[] | undefined);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // 연결이 이미 끊긴 경우. 원래 오류를 덮지 않는다.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** 테스트·스크립트 종료용. 애플리케이션 경로에서는 부르지 않는다. */
export async function closePool(): Promise<void> {
  const pool = globalForDb.__postfeelPool;
  if (!pool) return;
  globalForDb.__postfeelPool = undefined;
  await pool.end();
}
