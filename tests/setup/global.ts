// vitest globalSetup — 실행마다 한 번.
//
// 마이그레이션을 적용한 템플릿 DB를 하나 만들어 둔다. 테스트 파일은 이걸 template으로
// 복제해서 자기 DB를 얻는다 (tests/setup/db.ts). 파일마다 DDL을 다시 실행하지 않기
// 위해서다.
//
// 템플릿 이름에 실행 ID가 들어가므로 동시에 도는 다른 실행과 템플릿을 공유하지 않는다.
// 공유하면 CREATE DATABASE ... TEMPLATE이 "source database is being accessed by
// other users"로 실패할 수 있다.

import type { TestProject } from "vitest/node";
import { runMigrations } from "../../scripts/migrate.ts";
import {
  createDatabase,
  dropDatabase,
  dropDatabasesLike,
  randomId,
  templateDatabaseName,
  testDatabasePattern,
  urlForDatabase,
} from "./database.ts";

declare module "vitest" {
  export interface ProvidedContext {
    testRunId: string;
  }
}

export default async function setup(project: TestProject) {
  const runId = randomId(6);
  const template = templateDatabaseName(runId);

  await createDatabase(template);
  await runMigrations(urlForDatabase(template));

  project.provide("testRunId", runId);
  // globalSetup은 워커와 다른 프로세스라 provide()가 정식 경로다. env는 보조 수단.
  process.env.POSTFEEL_TEST_RUN_ID = runId;

  return async () => {
    // 파일 단위 teardown이 실패했거나 워커가 죽어도 남은 DB를 여기서 정리한다.
    await dropDatabasesLike(testDatabasePattern(runId));
    await dropDatabase(template);
  };
}
