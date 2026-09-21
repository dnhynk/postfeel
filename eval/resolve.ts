// `node`가 `src/`의 TypeScript를 그대로 불러올 수 있게 하는 해석 훅.
//
//   node --import ./eval/resolve.ts eval/run.ts
//
// ── 왜 필요한가 ─────────────────────────────────────────────
// Node 24는 `.ts`를 타입 스트리핑으로 그냥 실행한다. 막히는 건 **해석**이다. ESM은
// 완전한 지정자를 요구하는데 `src/`의 파일들은 번들러 기준으로 쓰여 있어서
// (`tsconfig.json`의 `moduleResolution: "bundler"`) 확장자가 없다:
//
//   src/lib/safety/layer1.ts:22  import { findDictionaryHits } from "./dictionaries/match";
//
// 실측 — 훅 없이 그대로 실행하면 이렇게 죽는다:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//     '...\src\lib\safety\dictionaries\match' imported from ...\layer1.ts
//
// scripts/gate.ts가 "이 파일은 로컬 import가 없다 — 타입 스트리핑으로 그대로 실행되게
// 두기 위해서다"라고 적어둔 것이 같은 제약이다. gate.ts는 vitest를 spawn해서 피했지만
// 평가 러너는 출력이 표 하나라 그 방법이 맞지 않는다. 대신 해석만 손본다.
//
// **`src/`를 고치는 대신 여기서 푼다.** 확장자를 붙이는 편집은 공용 lib 전체를 건드리고
// 머지되지 않은 워크트리 11개와 부딪힌다 (README 「소유 파일 규약」).
//
// 훅이 하는 일은 둘뿐이다. 변환은 하지 않는다 — 타입 스트리핑은 Node가 한다.
//   1. `@/x`  → `<repo>/src/x`   (tsconfig.json의 paths와 같은 규칙)
//   2. 확장자 없는 상대 지정자 → `.ts` · `/index.ts`가 실제로 있으면 그것으로

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

/** 이미 확장자가 붙어 있으면 손대지 않는다. */
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/u;
const RELATIVE_OR_FILE = /^(?:\.{1,2}\/|file:)/u;

registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;

    if (spec.startsWith("@/")) {
      spec = pathToFileURL(path.join(SRC_DIR, spec.slice(2))).href;
    }

    if (RELATIVE_OR_FILE.test(spec) && !HAS_EXTENSION.test(spec)) {
      const base = context.parentURL ?? import.meta.url;
      const filePath = fileURLToPath(new URL(spec, base));
      for (const candidate of [`${filePath}.ts`, path.join(filePath, "index.ts")]) {
        if (existsSync(candidate)) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    }

    return nextResolve(spec, context);
  },
});
