// 공개 읽기 표면의 데이터 접근 — `GET /api/feed` · `GET /api/letters/:id` · `/` · `/m/:id`.
//
// API와 화면이 **같은 함수**를 부른다. 두 벌이 되면 킬 스위치나 상태 필터가 한쪽에만
// 반영되는 날이 오고, 그게 05-api §2가 "여기가 비어 있으면 비공개 편지가 링크로 계속
// 읽히는 사고가 난다"고 쓴 그 사고다.
//
// ── 이 파일이 지키는 규칙 ────────────────────────────────────
//
// 1. **피드 노출 조건을 저장하지 않는다** (04 §3). `feed_visible` 컬럼을 만들지 않고
//    `status='published' and risk_level='low'`로 파생한다. 부분 인덱스
//    `letters_feed`·`letters_relationship`이 그 조건을 그대로 담고 있다.
// 2. **잠긴 편지의 본문은 Postgres 밖으로 나오지 않는다.** 가져온 뒤 응답에서 빼는 게
//    아니라 애초에 select 하지 않는다 — 05-api §7 #1이 "직렬화 실수로 새기 쉬운
//    지점"이라고 지목한 자리라, 새어나갈 값이 프로세스 안에 없는 편이 낫다.
// 3. **편지 상태를 여기서 바꾸지 않는다.** 읽기 전용이다 (letters/deletion.ts 규약).

import { query } from "../db";
import { publicReadEnabled } from "../settings";
import { attemptState } from "../unlock/attempts";

// ── 상수 ──────────────────────────────────────────────────

export const RELATIONSHIPS = [
  "ex",
  "friend",
  "family",
  "coworker",
  "other",
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** 03 흐름 1-1의 문구. 화면 문구는 문서가 진실이다. */
export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  ex: "옛 연인",
  friend: "친구",
  family: "가족",
  coworker: "동료",
  other: "그 외",
};

export type LetterMode = "open" | "locked";

/** 05-api §2의 `?limit=20`. */
export const FEED_LIMIT_DEFAULT = 20;
/** 한 번에 퍼갈 수 있는 양의 상한. 가설값 — 실측 후 조정. */
export const FEED_LIMIT_MAX = 50;

/**
 * `open` 카드 미리보기 길이. **가설값 — 실측 후 조정한다.**
 *
 * 03 흐름 0의 카드가 두 줄 남짓이고 본문 상한이 500자(04 §2)다. 넘으면 말줄임표를 붙인다.
 */
export const PREVIEW_LENGTH = 100;

/**
 * 해제 쿠키 이름 (04 §4 「재열람」).
 *
 * **쿠키를 굽는 쪽은 `POST /api/letters/:id/unlock`(B모드 워커)이고, 여기는 읽기만
 * 한다.** 이름이 갈라지면 재방문한 사람이 답을 다시 맞혀야 하고, 그건 03 흐름 2가
 * "제품 실패"라고 부른 상태다. 그래서 이름은 읽는 쪽에 두고 쓰는 쪽이 import 한다.
 * 수명·HttpOnly 같은 굽는 조건은 굽는 쪽이 정한다 (05-api §2: 30일, 가설값).
 */
export const UNLOCK_COOKIE = "pf_unlock";

// ── 응답 형태 (05-api §2) ─────────────────────────────────

export interface FeedItem {
  id: string;
  mode: LetterMode;
  relationship: string;
  createdAt: string;
  /** open은 본문 앞부분, locked는 `hint`. */
  preview: string;
  reactions: Record<string, number>;
}

export interface FeedResult {
  items: FeedItem[];
  nextCursor: string | null;
  /** `public_read_enabled = false`일 때만 붙는다 (05-api §2). */
  disabled?: true;
}

/**
 * `mode='open'` 응답. **해제 쿠키로 열린 잠긴 편지도 이 형태다.**
 *
 * 05-api §2의 "`open`과 같은 형태로 `body`를 반환한다"에서 같은 것은 **필드 집합**이고,
 * `mode`는 실제 값 `'locked'`를 유지한다. `'open'`으로 내리면 06-analytics §3의
 * `letter_view { mode }`가 거짓이 되어 A/B 모드별 지표가 조용히 망가지고, 클라이언트가
 * "이미 연 잠긴 편지"와 "원래 공개 편지"를 구분할 수 없다.
 */
export interface OpenLetterResponse {
  id: string;
  mode: LetterMode;
  relationship: string;
  createdAt: string;
  body: string;
  reactions: Record<string, number>;
}

/** `mode='locked'` 미해제 응답. **`body` 키가 없다** (05-api §7 #1). */
export interface LockedLetterResponse {
  id: string;
  mode: "locked";
  relationship: string;
  createdAt: string;
  hint: string;
  question: string;
  attemptsRemaining: number;
  lockedUntil: string | null;
}

export type LetterResponse = OpenLetterResponse | LockedLetterResponse;

/** 두 형태를 가르는 것은 `body`의 존재다. 별도 판별 필드를 두지 않는다 — 응답에서 빼야 할 키가 하나 늘면 그게 곧 #1의 사고 경로다. */
export function isUnlocked(
  letter: LetterResponse,
): letter is OpenLetterResponse {
  return "body" in letter;
}

// ── 커서 ──────────────────────────────────────────────────
//
// 05-api §2: **커서는 `created_at` 단독이 아니라 `(created_at, id)`다.** 편지 두 통이
// 같은 타임스탬프를 가지면 단독 커서로는 한 통이 누락되거나 중복된다.

/**
 * `created_at`을 마이크로초까지 남기는 ISO 문자열로 뽑는다.
 *
 * `timestamptz`는 마이크로초 정밀도이고 JS `Date`는 밀리초다. 커서를 `Date`로 왕복시키면
 * 1밀리초 안에 들어온 편지들이 같은 값으로 접혀 **커서가 막으려던 누락·중복이 그대로
 * 돌아온다.** 그래서 DB가 만든 문자열을 그대로 커서에 싣고 그대로 되돌려준다.
 */
const CREATED_AT_ISO = `to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * **이 별칭을 `created_at`으로 지으면 안 된다.**
 *
 * `ORDER BY`는 출력 컬럼 이름을 먼저 본다. 별칭이 `created_at`이면 `order by created_at
 * desc`가 테이블 컬럼이 아니라 위 `to_char(...)` 문자열을 가리키게 되고, 그러면 부분
 * 인덱스 `letters_feed`·`letters_relationship`을 타지 못한다 — 실측으로 확인했다
 * (Seq Scan 71 buffers / 3.7ms → Index Scan 4 buffers / 0.2ms).
 *
 * 결과 순서는 우연히 같다(고정폭 UTC 문자열이라 사전순 = 시간순). 그래서 테스트로는
 * 안 잡히고 `explain`으로만 보인다.
 */
const CREATED_AT_ALIAS = "created_at_iso";

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** 04 §1-1의 공개 ID — base64url 문자셋. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return `${cursor.createdAt}_${cursor.id}`;
}

/**
 * `<created_at>_<id>` 를 되돌린다. 형식이 어긋나면 null — 부르는 쪽이 400을 낸다.
 *
 * **첫 번째 `_`에서 자른다.** 공개 ID는 base64url이라 `_`를 포함할 수 있고(04 §1-1),
 * 마지막 `_`나 `split('_')`로 자르면 그런 ID를 가진 편지에서 커서가 깨진다.
 * 타임스탬프 쪽에는 `_`가 없으므로 첫 번째 것이 항상 구분자다.
 */
export function parseCursor(raw: string): Cursor | null {
  const separator = raw.indexOf("_");
  if (separator === -1) return null;

  const createdAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  // 형식을 여기서 막지 않으면 이상한 값이 ::timestamptz로 내려가 500이 된다.
  if (!TIMESTAMP_PATTERN.test(createdAt)) return null;
  if (!ID_PATTERN.test(id)) return null;
  return { createdAt, id };
}

/** 쿼리스트링의 `relationship`. 목록 밖이면 null — 부르는 쪽이 400을 내거나 무시한다. */
export function parseRelationship(raw: string | null): Relationship | null {
  if (raw === null) return null;
  return (RELATIONSHIPS as readonly string[]).includes(raw)
    ? (raw as Relationship)
    : null;
}

/** 쿼리스트링의 `limit`. 범위 밖이거나 정수가 아니면 null. */
export function parseLimit(raw: string | null): number | null {
  if (raw === null) return FEED_LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  if (limit < 1 || limit > FEED_LIMIT_MAX) return null;
  return limit;
}

// ── 피드 ──────────────────────────────────────────────────

export interface FeedQuery {
  relationship?: Relationship | null;
  cursor?: Cursor | null;
  limit?: number;
}

interface FeedRow {
  id: string;
  mode: LetterMode;
  relationship: string;
  created_at_iso: string;
  /** `mode='open'`일 때만 값이 있다. 아래 select의 case가 그렇게 만든다. */
  body_head: string | null;
  hint: string | null;
}

/**
 * 피드 한 페이지 (05-api §2).
 *
 * **조건을 문자열로 조립하는 이유**: `($1::text is null or relationship = $1)` 처럼 한
 * 문장으로 쓰면 플래너가 `relationship`을 인덱스 조건이 아니라 필터로 다루고, 그러면
 * 부분 인덱스 `letters_relationship`을 타지 않는다. 조건이 실제로 있을 때만 SQL에
 * 넣는다. 쿼리 빌더를 만드는 게 아니라 술어 두 개를 붙이고 뗀다.
 */
export async function feedPage(options: FeedQuery = {}): Promise<FeedResult> {
  const limit = options.limit ?? FEED_LIMIT_DEFAULT;
  const params: unknown[] = [];

  // 04 §3 — 파생 조건. 두 부분 인덱스의 술어와 글자 그대로 같다.
  const conditions = ["status = 'published'", "risk_level = 'low'"];

  params.push(PREVIEW_LENGTH + 1); // +1: 잘렸는지 알아야 말줄임표를 붙인다
  const previewParam = `$${params.length}`;

  if (options.relationship) {
    params.push(options.relationship);
    conditions.push(`relationship = $${params.length}`);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.id);
    conditions.push(
      `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`,
    );
  }

  // 한 건 더 받아 "다음 페이지가 있는가"를 센다. 없으면 nextCursor는 null이다.
  params.push(limit + 1);
  const limitParam = `$${params.length}`;

  const { rows } = await query<FeedRow>(
    `select id, mode, relationship,
            ${CREATED_AT_ISO} as ${CREATED_AT_ALIAS},
            case when mode = 'open' then left(body, ${previewParam}) end as body_head,
            hint
       from letters
      where ${conditions.join(" and ")}
      order by created_at desc, id desc
      limit ${limitParam}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const reactions = await reactionsFor(page.map((row) => row.id));

  const items: FeedItem[] = page.map((row) => ({
    id: row.id,
    mode: row.mode,
    relationship: row.relationship,
    createdAt: row.created_at_iso,
    preview: preview(row),
    reactions: reactions.get(row.id) ?? {},
  }));

  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.created_at_iso, id: last.id })
        : null,
  };
}

/**
 * 05-api §2: `open`은 본문 앞부분, `locked`는 `hint`.
 *
 * `body_head`는 locked 행에서 null이다 — 잠긴 편지의 본문은 select 자체에서 빠진다.
 */
function preview(row: FeedRow): string {
  if (row.mode === "locked") return row.hint ?? "";
  const head = row.body_head ?? "";
  // 코드 포인트로 자른다. 이모지가 섞여도 문자가 반토막 나지 않는다.
  const characters = Array.from(head);
  return characters.length > PREVIEW_LENGTH
    ? `${characters.slice(0, PREVIEW_LENGTH).join("")}…`
    : head;
}

/** 카드마다 세면 N+1이 된다. 페이지 하나를 한 번에 센다. */
async function reactionsFor(
  letterIds: string[],
): Promise<Map<string, Record<string, number>>> {
  const counts = new Map<string, Record<string, number>>();
  if (letterIds.length === 0) return counts;

  const { rows } = await query<{
    letter_id: string;
    kind: string;
    count: number;
  }>(
    `select letter_id, kind, count(*)::int as count
       from reactions
      where letter_id = any($1::text[])
      group by letter_id, kind`,
    [letterIds],
  );

  for (const row of rows) {
    const forLetter = counts.get(row.letter_id) ?? {};
    forLetter[row.kind] = row.count;
    counts.set(row.letter_id, forLetter);
  }
  return counts;
}

// ── 편지 한 통 ────────────────────────────────────────────

export interface ReadOptions {
  /**
   * 해제 쿠키에 들어 있던 `unlock_id`.
   *
   * **DB 대조로만 검증한다** (04 §4 · 05-api §7 #16). 쿠키에 든 값이 어느 편지의 것인지는
   * 믿지 않는다 — 아래 `hasUnlock`이 URL의 편지 ID와 대조한다.
   */
  unlockId?: string | null;
  /** 미해제 잠긴 편지의 "남은 시도 N번"을 계산할 식별자 (05-api §5). */
  fpHash: Buffer;
}

interface LetterRow {
  id: string;
  mode: LetterMode;
  relationship: string;
  created_at_iso: string;
  hint: string | null;
  question: string | null;
  /** 열람 자격이 있을 때만 값이 있다. 아래 select의 case가 그렇게 만든다. */
  body: string | null;
}

/**
 * 편지 한 통 (05-api §2). 없거나 볼 수 없으면 null — 부르는 쪽이 **404**를 낸다.
 *
 * `status='published'`만 통과한다. `hidden_auto`·`hidden_admin`·`deleted_by_author`는
 * 404다(05-api §2 표 · §7 #10). **403이 아니라 404를 쓴다** — 403은 편지의 존재를
 * 확인해준다. 등급 `medium`은 여기서 정상 조회된다. 링크 접근은 허용이고 피드 노출만
 * 제외다.
 */
export async function readLetter(
  id: string,
  options: ReadOptions,
): Promise<LetterResponse | null> {
  const unlocked = await hasUnlock(id, options.unlockId ?? null);

  // 본문은 열람 자격이 있을 때만 DB에서 나온다. 받아놓고 빼는 게 아니라 안 가져온다.
  const { rows } = await query<LetterRow>(
    `select id, mode, relationship,
            ${CREATED_AT_ISO} as ${CREATED_AT_ALIAS},
            hint, question,
            case when mode = 'open' or $2::boolean then body end as body
       from letters
      where id = $1 and status = 'published' and classifier_state = 'ok'`,
    [id, unlocked],
  );

  const row = rows[0];
  if (!row) return null;

  if (row.body !== null) {
    return {
      id: row.id,
      mode: row.mode,
      relationship: row.relationship,
      createdAt: row.created_at_iso,
      body: row.body,
      reactions: (await reactionsFor([row.id])).get(row.id) ?? {},
    };
  }

  if (row.hint === null || row.question === null) {
    // locked_fields 제약(04 §2)이 보장하는 값이다. 여기 오면 스키마가 깨진 것이라
    // 빈 문자열로 덮지 않고 죽는다 — 잠금 화면에 단서가 비어 보이는 것보다 낫다.
    throw new Error(`편지 ${id}: 본문이 가려졌는데 단서·질문이 비어 있다.`);
  }

  const { attemptsRemaining, lockedUntil } = await attemptState(
    row.id,
    options.fpHash,
  );

  return {
    id: row.id,
    mode: "locked",
    relationship: row.relationship,
    createdAt: row.created_at_iso,
    hint: row.hint,
    question: row.question,
    attemptsRemaining,
    lockedUntil,
  };
}

/**
 * 이 쿠키가 **이 편지**의 해제 기록인가 (04 §4 · 05-api §7 #16).
 *
 * `letter_id`는 URL에서 온 값이고 `unlock_id`는 쿠키에서 온 값이다. 둘이 같은 행에서
 * 만날 때만 참이다 — 쿠키가 스스로 말하는 편지 ID를 믿지 않는다. 위조한 값은 행이
 * 없어서, 다른 편지의 값은 `letter_id`가 달라서 걸린다.
 */
async function hasUnlock(
  letterId: string,
  unlockId: string | null,
): Promise<boolean> {
  if (!unlockId) return false;
  const { rowCount } = await query(
    "select 1 from unlocks where unlock_id = $1 and letter_id = $2",
    [unlockId, letterId],
  );
  return (rowCount ?? 0) > 0;
}

// ── 킬 스위치를 포함한 진입점 ──────────────────────────────
//
// 05-api §6: `public_read_enabled`는 `GET /api/feed` · `GET /api/letters/:id` · `/m/:id`를
// 막는다. **미들웨어가 아니라 핸들러에서** 확인한다 — 미들웨어 캐시 때문에 스위치가
// 즉시 반영되지 않으면 킬 스위치의 의미가 없다.

export type LetterLoad =
  | { state: "disabled" }
  | { state: "not_found" }
  | { state: "letter"; letter: LetterResponse };

/**
 * 스위치가 꺼져 있으면 **편지를 읽지 않는다.**
 *
 * 가져온 뒤 화면에서 숨기면 HTML 소스에 그대로 남는다. 여기서 일찍 끊어 본문이 애초에
 * 프로세스로 들어오지 않게 한다.
 */
export async function loadLetter(
  id: string,
  options: ReadOptions,
): Promise<LetterLoad> {
  if (!(await publicReadEnabled())) return { state: "disabled" };
  const letter = await readLetter(id, options);
  return letter === null
    ? { state: "not_found" }
    : { state: "letter", letter };
}

/** 스위치가 꺼져 있으면 빈 배열 + `disabled: true` (05-api §2). 쿼리를 돌리지 않는다. */
export async function loadFeed(options: FeedQuery = {}): Promise<FeedResult> {
  if (!(await publicReadEnabled())) {
    return { items: [], nextCursor: null, disabled: true };
  }
  return feedPage(options);
}

// ── 쿠키 ──────────────────────────────────────────────────

/**
 * Route Handler는 `Request`만 받으므로 `Cookie` 헤더를 직접 읽는다.
 * (서버 컴포넌트는 `next/headers`의 `cookies()`를 쓴다 — 거기엔 Request가 없다.)
 *
 * 값이 base64url(04 §1-1)이라 따옴표·인코딩을 다룰 일이 없다. 이름이 정확히 맞는
 * 첫 항목만 본다.
 */
export function unlockIdFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== UNLOCK_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}
