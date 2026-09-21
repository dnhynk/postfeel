// vitest setupFiles — 테스트 파일마다 한 번.
//
// 파일마다 자기 DB를 갖는다. 그래야 파일을 병렬로 돌려도 서로의 행을 보지 않는다
// (피드 개수를 세는 테스트가 옆 파일이 넣은 편지를 보면 그때부터 flaky다).
//
// DB 생성과 DATABASE_URL 설정을 최상위 await로 한다. beforeAll에서 하면 늦다 —
// 테스트 파일의 import가 먼저 평가되고, src/lib/env.ts가 그 시점에 DATABASE_URL을
// 읽어 고정하기 때문이다. 같은 이유로 여기서는 @/lib/db를 정적 import 하지 않는다.

import { afterAll, inject } from "vitest";
import {
  createDatabase,
  dropDatabase,
  templateDatabaseName,
  testDatabaseName,
  urlForDatabase,
} from "./database.ts";

const runId = inject("testRunId") || process.env.POSTFEEL_TEST_RUN_ID;
if (!runId) {
  throw new Error(
    "테스트 실행 ID가 없다. vitest.config.ts의 globalSetup이 돌지 않았다.",
  );
}

const database = testDatabaseName(runId);
await createDatabase(database, templateDatabaseName(runId));

process.env.DATABASE_URL = urlForDatabase(database);

afterAll(async () => {
  // 동적 import — 위 대입 이후에 @/lib/env가 평가되게 한다.
  //
  // **DB를 지우기 전에 배경 작업을 먼저 비운다.** 라우트가 응답 뒤로 미룬 일은 요청
  // 스코프 밖(테스트)에서 `after()` 대신 폴백으로 도는데, 그게 파일보다 오래 살면 뒤늦은
  // 쿼리가 사라진 DB를 향해 커넥션을 새로 열고 드롭에 끊기면서 pg가 핸들러 없는 오류로
  // 런 전체를 죽인다. 근거는 src/lib/notify/schedule.ts의 `drainAfterResponse`.
  const { drainAfterResponse } = await import("@/lib/notify/schedule");
  await drainAfterResponse();

  const { closePool } = await import("@/lib/db");
  await closePool();
  await dropDatabase(database);
});
