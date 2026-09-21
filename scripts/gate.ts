// 출시 게이트 — 안전 회귀 테스트 24개의 진행 상황.
//
//   node scripts/gate.ts        (= npm run gate)
//
// 게이트 조건은 "31개 전부 통과"다 (08-milestones.md). 그래서 몇 개가 살아 있고 몇 개가
// 통과하는지 한 눈에 보여야 한다. 번호의 출처는 05-api §7(26건)과
// 09-notifications §6(5건)이고, 테스트 쪽 식별자는 describe 이름의 `safety#<번호>`다.
//
// **번호는 늘어날 수 있다. 줄어들 수는 없다.** 25~31은 M0 답과 그 답이 드러낸 충돌에서
// 나온 것이라 2026-08-16에 더했다 — 25(D-027 완전 파기) · 26(D-030 접속기록) ·
// 27(D-028 격리) · 28(D-031 파기 작업) · 29(D-032 연령) · 30(D-033 민감정보) ·
// 31(D-035 판정 전 보류). 통과시키려고 번호를 빼는 것은 금지다.
//
// 이 파일은 로컬 import가 없다 — Node의 타입 스트리핑으로 그대로 실행되게 두기 위해서다
// (scripts/migrate.ts와 같은 이유).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 05-api §7 26건 + 09-notifications §6 5건. */
const TOTAL = 31;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

interface AssertionResult {
  ancestorTitles: string[];
  fullName: string;
  title: string;
  status: string;
}

interface FileResult {
  name: string;
  assertionResults: AssertionResult[];
}

interface JsonReport {
  testResults: FileResult[];
}

/** todo·skip은 "아직 구현되지 않음"이다. 나머지는 실제로 돈 것이다. */
function isInactive(status: string): boolean {
  return status === "todo" || status === "pending" || status === "skipped";
}

function run(): JsonReport {
  const dir = mkdtempSync(path.join(tmpdir(), "postfeel-gate-"));
  const outputFile = path.join(dir, "safety.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        VITEST,
        "run",
        "tests/safety",
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
    );
    if (result.error) throw result.error;

    let raw: string;
    try {
      raw = readFileSync(outputFile, "utf8");
    } catch {
      throw new Error(
        "vitest가 결과를 남기지 못했다. 위 stderr를 본다 — 보통 Postgres가 안 떠 있는 경우다.",
      );
    }
    return JSON.parse(raw) as JsonReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Entry {
  files: Set<string>;
  total: number;
  passed: number;
  failed: number;
  inactive: number;
}

function collect(report: JsonReport): Map<number, Entry> {
  const entries = new Map<number, Entry>();

  for (const file of report.testResults) {
    for (const assertion of file.assertionResults) {
      const source = [...assertion.ancestorTitles, assertion.title].join(" ");
      const match = /safety#(\d+)/.exec(source);
      if (!match) continue;
      const number = Number(match[1]);

      let entry = entries.get(number);
      if (!entry) {
        entry = { files: new Set(), total: 0, passed: 0, failed: 0, inactive: 0 };
        entries.set(number, entry);
      }
      entry.files.add(path.relative(ROOT, file.name));
      entry.total += 1;
      if (assertion.status === "passed") entry.passed += 1;
      else if (assertion.status === "failed") entry.failed += 1;
      else if (isInactive(assertion.status)) entry.inactive += 1;
      else entry.failed += 1; // 모르는 상태는 통과로 세지 않는다
    }
  }

  return entries;
}

function main(): void {
  const entries = collect(run());

  const missing: number[] = [];
  const notImplemented: number[] = [];
  const failing: number[] = [];
  let active = 0;
  let passing = 0;

  for (let number = 1; number <= TOTAL; number += 1) {
    const entry = entries.get(number);
    if (!entry || entry.total === 0) {
      missing.push(number);
      continue;
    }
    // 활성 = 실제로 도는 it이 하나라도 있다.
    if (entry.inactive === entry.total) {
      notImplemented.push(number);
      continue;
    }
    active += 1;
    // 통과 = 그 번호의 it이 전부 통과했다. 하나라도 남아 있으면 아직 아니다.
    if (entry.passed === entry.total) passing += 1;
    else failing.push(number);
  }

  const extra = [...entries.keys()].filter((n) => n < 1 || n > TOTAL).sort();
  const duplicated = [...entries.entries()]
    .filter(([, entry]) => entry.files.size > 1)
    .map(([number]) => number)
    .sort((a, b) => a - b);

  const list = (numbers: number[]): string =>
    numbers.map((n) => `#${n}`).join(" ");

  // 미구현 = 활성이 아닌 전부. 번호 자체가 없는 것도 여기 포함되고, 그건 아래에서
  // 따로 오류로 다시 말한다.
  console.log(
    `안전 회귀 테스트: ${active}/${TOTAL} 활성 · ${passing} 통과 · ${
      TOTAL - active
    } 미구현`,
  );
  if (notImplemented.length > 0) console.log(`미구현: ${list(notImplemented)}`);
  if (failing.length > 0) console.log(`미통과: ${list(failing)}`);

  let ok = true;

  if (missing.length > 0) {
    console.error(
      `\n번호가 없다: ${list(missing)}\n` +
        `  05-api §7과 09-notifications §6의 24건은 하나도 빠지면 안 된다.\n` +
        `  describe 이름에 'safety#<번호>'가 들어가야 게이트가 센다.`,
    );
    ok = false;
  }
  if (extra.length > 0) {
    console.error(`\n1~${TOTAL} 밖의 번호가 있다: ${list(extra)}`);
    ok = false;
  }
  if (duplicated.length > 0) {
    console.error(
      `\n한 번호가 여러 파일에 흩어져 있다: ${list(duplicated)}\n` +
        `  한 번호는 한 파일에 둔다. 안 그러면 구현이 반쪽만 남는다.`,
    );
    ok = false;
  }
  if (failing.length > 0) ok = false;

  process.exit(ok ? 0 : 1);
}

main();
