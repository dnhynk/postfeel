// 주간 리뷰 — docs/06-analytics.md §5 · §6.
//
//   node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/weekly.ts
//   npm run weekly
//
// **일곱 개만 본다. 순서를 바꾸지 않는다.** 06 §6이 "매주 같은 숫자를 같은 순서로 본다.
// 늘리지 않는다"고 못박았다. 순서가 흔들리면 지난주 출력과 눈으로 대조할 수 없고, 지표가
// 늘어나면 그 순간부터 아무도 전부 보지 않는다.
//
// 성장 지표(#1~#4)와 방어 지표(#5~#7)를 **같은 화면에서** 본다 (01 제품 원칙 6).
//
// ── #5 · #7은 전환 트리거와 같은 식이다 ──────────────────────
// 02 §7의 전환 트리거(신고율 3% 초과 · 24시간 내 삭제율 5% 초과)는 이 파일의 같은 함수로
// 계산된다. 06 §6이 "계측되지 않는 정의를 트리거에 두면 발동 여부를 판정할 수 없다"고
// 적은 그대로다. 식이 두 벌이 되면 트리거가 걸렸는지 아닌지를 판정하는 근거가 사라진다.
//
// ── 이 파일은 로컬 import가 없다 ─────────────────────────────
// scripts/migrate.ts와 같은 이유다 — Node의 타입 스트리핑으로 그대로 실행되게 두기
// 위해서다. `@/lib/db`를 import 하면 별칭이 풀리지 않아 `node scripts/weekly.ts`가 죽는다.
// 대신 쿼리 함수가 `Queryable`을 받아, 테스트는 `@/lib/db`의 `query`를, CLI는 `pg.Client`를
// 넘긴다. 같은 SQL이 양쪽에서 돈다.

import { pathToFileURL } from "node:url";
import pg from "pg";

/** `@/lib/db`의 `query`와 `pg.Client`가 둘 다 만족하는 최소 형태. */
export interface Queryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[] }>;
}

/** 06 §5 · §6이 전부 "주간"이다. */
export const DEFAULT_DAYS = 7;

/** 02 §7 전환 트리거. **이 값이 06 §6 「나쁜 신호」의 임계값과 같은 값이다.** */
export const REPORT_RATE_TRIGGER = 0.03;
export const DELETE_RATE_TRIGGER = 0.05;

/** 06 §6 #7 — "24시간 내" 삭제. S-9(작성자 후회)의 크기다. */
export const RECENT_DELETE_HOURS = 24;

// ── 세는 함수들 ────────────────────────────────────────────
//
// 전부 "최근 N일" 창이다. 창 시작점은 **DB 시계로** 계산한다 — 스크립트를 돌리는 노트북의
// 시계와 DB의 시계가 다르면 경계에 걸친 행이 주마다 들어왔다 나갔다 한다.

async function scalar(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const { rows } = await db.query(sql, params);
  const row = rows[0] as { value?: string | number | null } | undefined;
  return Number(row?.value ?? 0);
}

/**
 * #1 북극성 — 주간 "본인에게 온 편지였다" 응답 열람 수 (06 §5).
 *
 * **`l.status = 'published'` 조건을 빼지 않는다.** 06 §5가 "이후 내려간 편지는 제외"라고
 * 적었고 그게 01 제품 정의의 "안전하게"에 해당한다 — 나중에 신고로 내려간 편지의 열람을
 * 성과로 세면, 지표가 올라갈수록 제품이 나빠지는 상태를 우리가 못 본다.
 *
 * 이벤트 테이블이 아니라 `unlocks` 행을 센다. 06 §5의 SQL 그대로다.
 */
export async function northStar(
  db: Queryable,
  days: number = DEFAULT_DAYS,
): Promise<number> {
  return scalar(
    db,
    `select count(*) as value
       from unlocks u
       join letters l on l.id = u.letter_id
      where u.recipient_response = 'yes'
        and u.responded_at >= now() - make_interval(days => $1)
        and l.status = 'published'`,
    [days],
  );
}

/** 창 안의 이벤트 수. 이름만으로 센다. */
export async function countEvents(
  db: Queryable,
  name: string,
  days: number = DEFAULT_DAYS,
): Promise<number> {
  return scalar(
    db,
    `select count(*) as value
       from events
      where name = $1
        and created_at >= now() - make_interval(days => $2)`,
    [name, days],
  );
}

/** 창 안의 이벤트 중 `props->>key = value`인 것. */
export async function countEventsWhereProp(
  db: Queryable,
  name: string,
  key: string,
  value: string,
  days: number = DEFAULT_DAYS,
): Promise<number> {
  return scalar(
    db,
    `select count(*) as value
       from events
      where name = $1
        and created_at >= now() - make_interval(days => $4)
        and props->>($2::text) = $3`,
    [name, key, value, days],
  );
}

/**
 * #7의 분자 — `letter_deleted` 중 `ageHours < 24`인 것 (06 §6 · 02 §7).
 *
 * `ageHours`가 없는 행은 세지 않는다. 나이를 모르는 삭제를 "24시간 내"에 넣으면 트리거가
 * 있지도 않은 후회를 근거로 발동한다.
 *
 * `jsonb_typeof`로 숫자인지 먼저 본다. 없는 키를 거르는 것과 같은 조건이면서, 숫자가
 * 아닌 값이 섞였을 때 `::numeric`이 던져 **주간 리뷰 전체가 죽는 것**을 막는다.
 */
export async function countRecentDeletes(
  db: Queryable,
  days: number = DEFAULT_DAYS,
): Promise<number> {
  return scalar(
    db,
    `select count(*) as value
       from events
      where name = 'letter_deleted'
        and created_at >= now() - make_interval(days => $1)
        and jsonb_typeof(props->'ageHours') = 'number'
        and (props->>'ageHours')::numeric < $2::numeric`,
    [days, RECENT_DELETE_HOURS],
  );
}

// ── 지표 ──────────────────────────────────────────────────

export interface Ratio {
  numerator: number;
  denominator: number;
  /** 분모가 0이면 **null이다. 0%가 아니다.** 없는 비율을 0으로 적으면 없는 신호가 된다. */
  value: number | null;
}

function ratio(numerator: number, denominator: number): Ratio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

export interface Metric {
  /** 06 §6 표의 번호. 순서다. */
  no: number;
  label: string;
  /** 06 §6 「계산」 열. 출력에 그대로 찍어 식이 무엇인지 매주 보이게 한다. */
  formula: string;
  count?: number;
  ratio?: Ratio;
  /** 임계값을 넘었나. 넘지 않는 지표는 `undefined`다. */
  trigger?: { threshold: number; exceeded: boolean; note: string };
}

export interface WeeklyReview {
  days: number;
  metrics: Metric[];
}

/**
 * 06 §6의 일곱 개를 **문서 순서 그대로** 낸다.
 *
 * 배열 순서가 곧 출력 순서이고, 그게 이 함수의 계약이다.
 */
export async function weeklyReview(
  db: Queryable,
  days: number = DEFAULT_DAYS,
): Promise<WeeklyReview> {
  // **순차로 돈다.** `Queryable`은 커넥션 하나(`pg.Client`)일 수 있고, 그때 동시에 쏘면
  // pg가 큐에 밀어넣으면서 폐기 예정 경고를 낸다(pg@9에서 제거). 짧은 count 11개라
  // 주간에 한 번 도는 스크립트에서 지연은 문제가 되지 않는다.
  const star = await northStar(db, days);
  const feedView = await countEvents(db, "feed_view", days);
  const letterCreated = await countEvents(db, "letter_created", days);
  const letterView = await countEvents(db, "letter_view", days);
  const letterViewLink = await countEventsWhereProp(
    db,
    "letter_view",
    "source",
    "link",
    days,
  );
  const recipientResponse = await countEvents(db, "recipient_response", days);
  const postUnlockContinue = await countEvents(db, "post_unlock_continue", days);
  const reportSubmitted = await countEvents(db, "report_submitted", days);
  const filterWarned = await countEvents(db, "filter_warned", days);
  const filterRevised = await countEvents(db, "filter_revised", days);
  const recentDeletes = await countRecentDeletes(db, days);

  const reportRate = ratio(reportSubmitted, letterCreated);
  const deleteRate = ratio(recentDeletes, letterCreated);

  return {
    days,
    metrics: [
      {
        no: 1,
        label: "북극성 — 주간 '본인에게 온 편지였다' 응답 열람 수",
        formula: "unlocks.recipient_response='yes' ∧ letters.status='published' (06 §5)",
        count: star,
      },
      {
        no: 2,
        label: "작성 전환율",
        formula: "letter_created / feed_view",
        ratio: ratio(letterCreated, feedView),
      },
      {
        no: 3,
        label: "링크 유입 비중",
        formula: "letter_view(source=link) / letter_view",
        ratio: ratio(letterViewLink, letterView),
      },
      {
        no: 4,
        label: "루프 유지율",
        formula: "post_unlock_continue / recipient_response",
        ratio: ratio(postUnlockContinue, recipientResponse),
      },
      {
        no: 5,
        label: "신고율",
        formula: "report_submitted / letter_created",
        ratio: reportRate,
        trigger: {
          threshold: REPORT_RATE_TRIGGER,
          exceeded: exceeds(reportRate, REPORT_RATE_TRIGGER),
          note: "02 §7 전환 트리거 — 사전 검토 전환을 재검토한다",
        },
      },
      {
        no: 6,
        label: "인터스티셜 회귀율",
        formula: "filter_revised / filter_warned",
        ratio: ratio(filterRevised, filterWarned),
      },
      {
        no: 7,
        label: "24시간 내 삭제율",
        formula: "letter_deleted(ageHours<24) / letter_created",
        ratio: deleteRate,
        trigger: {
          threshold: DELETE_RATE_TRIGGER,
          exceeded: exceeds(deleteRate, DELETE_RATE_TRIGGER),
          note: "02 §7 전환 트리거 — 사전 검토 전환을 재검토한다",
        },
      },
    ],
  };
}

/** 분모가 0이면 초과가 아니다 — 판정할 근거가 없는 것과 통과는 다르지만, 발동시키지 않는다. */
export function exceeds(value: Ratio, threshold: number): boolean {
  return value.value !== null && value.value > threshold;
}

// ── 출력 ──────────────────────────────────────────────────

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ratioLine(value: Ratio): string {
  if (value.value === null) {
    // 06 §7의 태도 그대로 — 없는 값을 추정치로 채우지 않는다.
    return `— (분모 0: ${value.numerator} / ${value.denominator})`;
  }
  return `${percent(value.value)}  (${value.numerator} / ${value.denominator})`;
}

/**
 * 06 §6이 적어 둔 한계. **숫자와 함께 찍는다.**
 *
 * 이 문장이 없으면 #5·#7을 그 주에 생성된 편지의 신고율·삭제율로 읽게 되는데 그게 아니다.
 * 숫자만 보면 오해하는 종류의 지표라 매주 같이 나가야 한다.
 */
export const CAVEAT = [
  "한계 (06 §6): #5 · #7의 분자는 그 주에 **접수된** 신고 · 삭제이고 분모는 그 주에",
  "**생성된** 편지라 코호트가 정확히 일치하지 않는다. 추세를 보는 용도이고, 편지 수가",
  "주마다 크게 흔들리면 이 비율이 실제보다 커진다.",
].join("\n");

export function format(review: WeeklyReview): string {
  const lines: string[] = [
    `주간 리뷰 — 최근 ${review.days}일 (docs/06-analytics.md §6)`,
    "이 일곱 개만 본다. 순서를 바꾸지 않는다.",
    "",
  ];

  for (const metric of review.metrics) {
    lines.push(`${metric.no}. ${metric.label}`);
    lines.push(`   ${metric.formula}`);
    if (metric.count !== undefined) {
      lines.push(`   → ${metric.count}`);
    }
    if (metric.ratio) {
      lines.push(`   → ${ratioLine(metric.ratio)}`);
    }
    if (metric.trigger) {
      lines.push(
        metric.trigger.exceeded
          ? `   ⚠ 임계값 ${percent(metric.trigger.threshold)} 초과 → ${metric.trigger.note}`
          : `   임계값 ${percent(metric.trigger.threshold)} 이하`,
      );
    }
    lines.push("");
  }

  lines.push(CAVEAT);
  return lines.join("\n");
}

// ── 운영 점검 (07 §7) ──────────────────────────────────────
//
// **위 일곱 개와 다른 목록이다.** 06 §6은 "매주 같은 숫자를 같은 순서로 본다. 늘리지
// 않는다"이고, 07 §7의 주간 점검 30분은 그 일곱 개를 1번 항목으로 포함하는 **운영
// 절차**다. 그래서 여기 있는 것을 `weeklyReview`의 `metrics` 배열에 넣지 않는다 —
// 넣는 순간 06이 금지한 여덟 번째 지표가 된다.
//
// 지금 재는 것은 07 §7 **5번** 하나다: 분류기 초안 판정 vs 최종 판정의 불일치율.
// 나머지 항목(2 · 3 · 4 · 6 · 7)은 SQL로 나오는 값이 아니라 사람이 하는 대조라 여기
// 없다.
//
// **모델을 부르지 않는다.** 07 §7의 "3번과 5번은 배치로 돌린다"에서 5번이 빠진 이유가
// 이것이다 — 초안은 07 §2대로 **신고가 접수될 때 이미 만들어져** `admin_actions`에
// 저장돼 있고, 이 점검은 그 행과 최종 판정을 세는 집계뿐이다.

/**
 * 초안이 들어간 `admin_actions.action`.
 *
 * 값의 출처는 `src/lib/admin/queue.ts`의 `REPORT_DRAFT_ACTION`이고 저장 형식은
 * `src/lib/reports/draft.ts`의 `draftNote`다. 여기서 문자열로 다시 적는 이유는 이
 * 파일이 별칭 import를 쓸 수 없기 때문이다(머리말) — 두 값이 갈라지지 않게 테스트가
 * 양쪽을 함께 읽어 대조한다.
 */
export const DRAFT_ACTION = "report_draft";

/**
 * 07 §2 판정표에서 **조치가 조건 없이 정해진 유일한 행**이다: "기타 | — | 위 항목에 안
 * 걸리면 복구".
 *
 * 나머지 행은 조치 열이 조건부라(`저격·비방`은 "하나만이면 복구", `사칭`은 "1건은 보류",
 * `성적 내용`은 "성인 간이면 노골적일 때만") 행에서 조치를 유도할 수 없다. 유도하면
 * 그게 07 §2가 금지한 "분류기에 조치를 맡기는" 쪽이다.
 */
const DISMISS_ROW = "other";

/** `note` 접두사를 읽지 못한 행. 형식이 바뀌면 조용히 사라지는 대신 여기 모인다. */
export const UNKNOWN_ROW = "?";

export interface DraftRowOutcome {
  /** 초안이 고른 판정표의 행. */
  row: string;
  upheld: number;
  dismissed: number;
}

export interface DraftAgreement {
  /** 초안이 붙은 채로 판정이 끝난 신고 수 = 불일치율의 분모. */
  resolved: number;
  mismatched: number;
  rate: Ratio;
  /** 행별 최종 판정 분포. **해석은 사람이 한다** — 여기서 조치를 제안하지 않는다. */
  rows: DraftRowOutcome[];
  /** `note` 형식을 읽지 못해 대조에서 뺀 건수. */
  unknown: number;
}

/**
 * 07 §7 #5 — 초안 판정과 최종 판정이 어긋난 비율 (07 §2).
 *
 * 창은 **최종 판정 시각**(`reports.resolved_at`)으로 잡는다. 이 점검이 보는 것은 "이번
 * 주에 내가 내린 판정이 초안과 얼마나 달랐나"이고, 신고 접수 시각으로 자르면 지난주에
 * 들어와 이번 주에 판정한 건이 어느 주에도 안 잡힌다.
 *
 * 초안이 없는 신고는 분모에 넣지 않는다 — 대조할 것이 없다. 초안이 두 번 붙었으면
 * 마지막 것만 본다 (큐 화면이 읽는 것과 같은 행).
 */
export async function reportDraftAgreement(
  db: Queryable,
  days: number = DEFAULT_DAYS,
): Promise<DraftAgreement> {
  const { rows } = await db.query(
    `select coalesce(substring(d.note from '^\\[([a-z]+)\\]'), $3) as row,
            r.status as status,
            count(*) as count
       from reports r
       join lateral (
              select a.note
                from admin_actions a
               where a.action = $2 and a.target_id = r.id::text
               order by a.created_at desc
               limit 1
            ) d on true
      where r.status in ('upheld', 'dismissed')
        and r.resolved_at >= now() - make_interval(days => $1)
      group by 1, 2
      order by 1`,
    [days, DRAFT_ACTION, UNKNOWN_ROW],
  );

  const byRow = new Map<string, DraftRowOutcome>();
  let resolved = 0;
  let mismatched = 0;
  let unknown = 0;

  for (const raw of rows as Array<{
    row: string;
    status: string;
    count: string | number;
  }>) {
    const count = Number(raw.count);
    const outcome = byRow.get(raw.row) ?? { row: raw.row, upheld: 0, dismissed: 0 };
    if (raw.status === "upheld") outcome.upheld += count;
    else outcome.dismissed += count;
    byRow.set(raw.row, outcome);

    if (raw.row === UNKNOWN_ROW) {
      unknown += count;
      continue;
    }
    resolved += count;
    // 초안이 "위 항목에 안 걸린다(other)"인데 위반으로 판정했거나, 어느 행에 걸린다고
    // 했는데 문제없음으로 되살렸으면 어긋난 것이다.
    const agrees =
      raw.row === DISMISS_ROW
        ? raw.status === "dismissed"
        : raw.status === "upheld";
    if (!agrees) mismatched += count;
  }

  return {
    resolved,
    mismatched,
    rate: ratio(mismatched, resolved),
    rows: [...byRow.values()].sort((a, b) => a.row.localeCompare(b.row)),
    unknown,
  };
}

/**
 * 07 §2가 이 지표를 둔 목적이 "초안을 믿어도 되나"라서, 비율만으로는 매주 같은 숫자를
 * 보고도 행동을 정할 수 없다. 그래서 **분모와 행별 분포를 함께** 찍는다.
 *
 * 조건부 행 때문에 비율이 부푸는 것은 숨기지 않고 한계로 적는다 — 06 §6의 코호트 한계를
 * 숫자와 함께 찍는 것과 같은 방식이다.
 */
export const DRAFT_CAVEAT = [
  "한계 (07 §2): 판정표의 `저격·비방` · `사칭` · `성적 내용`은 조치가 조건부라",
  "(\"하나만이면 복구\" · \"1건은 보류\") 초안 행이 맞아도 복구가 정답일 수 있다.",
  "그만큼 이 비율은 과대 계상된다. 어느 행이 실제로 안 맞는지는 위 분포를 본다.",
].join("\n");

export function formatOperations(check: DraftAgreement, days = DEFAULT_DAYS): string {
  const lines: string[] = [
    `운영 점검 — 최근 ${days}일 (docs/07-operations.md §7)`,
    "위 주간 리뷰 일곱 개와 별개 목록이다 (06 §6은 늘리지 않는다).",
    "",
    "5. 분류기 초안 판정 vs 최종 판정의 불일치율",
    `   초안이 붙은 채로 판정이 끝난 신고: ${check.resolved}건`,
    `   → ${ratioLine(check.rate)}`,
    "",
    "   초안 행 → 최종 판정",
  ];

  if (check.rows.length === 0) {
    lines.push("     (없음)");
  }
  for (const row of check.rows) {
    lines.push(
      `     ${row.row.padEnd(14)} uphold ${row.upheld} · dismiss ${row.dismissed}`,
    );
  }
  if (check.unknown > 0) {
    lines.push(
      "",
      `   note 형식을 읽지 못해 대조에서 뺀 건: ${check.unknown}건 (${UNKNOWN_ROW})`,
    );
  }

  lines.push("", DRAFT_CAVEAT);
  return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────

/**
 * `node scripts/weekly.ts`로 직접 돌렸을 때만 참. import 되면(테스트) 아무것도 하지 않는다.
 *
 * `pathToFileURL`을 쓴다 — 윈도우 경로(`C:\...`)를 문자열로 이어 붙이면 드라이브 문자가
 * URL의 호스트로 파싱돼 비교가 항상 실패한다.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL이 없다. .env.local을 확인한다.");
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log(format(await weeklyReview(client)));
    // 07 §7의 운영 점검은 06 §6의 일곱 개와 다른 목록이라 블록을 나눠 찍는다.
    console.log("");
    console.log(formatOperations(await reportDraftAgreement(client)));
  } finally {
    await client.end();
  }
}

if (isMain()) {
  await main();
}
