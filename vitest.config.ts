import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// .env.test를 이 프로세스에 먼저 싣는다. 워커는 여기서 파생되므로 값을 물려받고,
// globalSetup(이 프로세스에서 돈다)도 같은 DATABASE_URL을 본다. 양쪽이 다른 서버를
// 보면 템플릿 DB와 파일 DB가 갈라진다.
// 이미 설정된 진짜 환경변수(CI 등)가 이긴다 — process.loadEnvFile은 덮어쓰지 않는다.
const testEnvFile = path.join(rootDir, ".env.test");
if (existsSync(testEnvFile)) {
  process.loadEnvFile(testEnvFile);
}

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(rootDir, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/setup/global.ts"],
    setupFiles: ["./tests/setup/db.ts"],
    // DB 생성·드롭이 붙어 있어 기본값으로는 빠듯하다.
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
