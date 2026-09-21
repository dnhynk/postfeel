import { vi } from "vitest";

/**
 * 분류기 모듈을 **가짜 API 키와 함께 새로** 싣는다.
 *
 * `src/lib/env.ts`는 모듈 평가 시점에 `process.env`를 한 번 읽어 고정한다(그게 그 파일이
 * 존재하는 이유다). `.env.test`의 `OPENAI_API_KEY`는 비어 있으므로 — 실제 API를 CI에서
 * 부르지 않기 위해 의도적으로 비워 둔 값이다 — 키를 넣은 **뒤에** 모듈 레지스트리를 비우고
 * 다시 import 해야 한다.
 *
 * 커넥션 풀은 `globalThis`에 있어 모듈을 다시 실어도 그대로다 (`src/lib/db.ts`).
 */
export async function loadClassifier(): Promise<
  typeof import("@/lib/safety/classifier")
> {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-a-real-key");
  vi.resetModules();
  return import("@/lib/safety/classifier");
}

export async function loadReclassify(): Promise<
  typeof import("@/lib/safety/reclassify")
> {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-a-real-key");
  vi.resetModules();
  return import("@/lib/safety/reclassify");
}
