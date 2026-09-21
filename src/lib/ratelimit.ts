// 레이트리밋 (05-api §5).
//
// **별도 카운터 테이블을 만들지 않는다.** 05-api §5가 명시했다 — 작성은
// `letters.author_fp_hash`, 열람은 `unlock_attempts`, 신고는 `reports.reporter_fp_hash`로
// 이미 셀 수 있다. 없는 걸 만들기 전에 있는 걸 센다. 저장소는 Postgres다. 서버리스라
// 인메모리 카운터가 인스턴스 간에 공유되지 않는다 (D-018).
//
// 여기에는 **상수와 세는 법**만 있다. 각 엔드포인트에 실제로 적용하는 것은 그 표면을
// 맡은 워커가 한다.
//
// 동시 요청이 한도를 넘길 수 있다. v0에서는 감수하고, **열람 시도만** 삽입과 카운트를
// 한 트랜잭션에 묶는다 — 여기만 초과의 대가가 "잠긴 편지가 열린다"이기 때문이다.
// 그래서 아래 카운터는 트랜잭션 클라이언트를 받을 수 있다.

import { query } from "./db";

export interface Rule {
  limit: number;
  windowMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 05-api §5의 임계값 표. **전부 가설값이다 — 실측 후 조정한다.**
 *
 * 특히 한국 모바일 캐리어 NAT 때문에 다수 사용자가 IP를 공유한다. 넉넉하게 잡지 않으면
 * 정상 사용자가 걸린다.
 */
export const LIMITS = {
  /** 편지 작성 · fp · 가설값 — 실측 후 조정 */
  letterCreatePerHour: { limit: 10, windowMs: HOUR },
  /** 편지 작성 · fp · 가설값 — 실측 후 조정 */
  letterCreatePerMinute: { limit: 3, windowMs: MINUTE },
  /** 열람 시도 · (letter, fp) · UI의 "남은 시도 3번" · 가설값 — 실측 후 조정 */
  unlockPerLetterAndFpPerDay: { limit: 3, windowMs: DAY },
  /**
   * 열람 시도 · letter 전역 · 가설값 — 실측 후 조정.
   *
   * `(letter, fp)` 제한만으로는 부족하다 — fp를 갈아치우면 무한 시도가 된다.
   * 감수하는 트레이드오프: 공격자가 특정 편지의 하루치 시도를 소진시켜 진짜 수신자를
   * 막을 수 있다. 50회는 정상 사용자가 닿기 어렵고, 진짜 수신자는 보통 공유 링크로
   * 임의 시점에 들어온다 (05-api §5).
   */
  unlockPerLetterPerDay: { limit: 50, windowMs: DAY },
  /** 열람 시도 · fp 전역 · 가설값 — 실측 후 조정 */
  unlockPerFpPer10Min: { limit: 30, windowMs: 10 * MINUTE },
  /** 신고 · fp · 가설값 — 실측 후 조정 */
  reportPerDay: { limit: 20, windowMs: DAY },
  /**
   * 이메일 등록 · fp · 가설값 — 실측 후 조정.
   *
   * `author_contacts`에 fp 컬럼이 없어(04 §2) 셀 곳이 없어 보였지만, `letters`를 조인하면
   * `author_fp_hash`로 셀 수 있다 — 아래 `countContactsByAuthorFp`. 새 컬럼도 새 테이블도
   * 만들지 않는다 (05-api §5 「없는 걸 만들기 전에 있는 걸 센다」, 2026-08-15 코디네이터 확인).
   */
  contactCreatePerHour: { limit: 5, windowMs: HOUR },
} as const satisfies Record<string, Rule>;

/** 한도를 이미 채웠는가. `count`는 창 안의 **기존** 건수다. */
export function exceeded(count: number, rule: Rule): boolean {
  return count >= rule.limit;
}

/**
 * `query()`이거나 트랜잭션 클라이언트다.
 *
 * 열람 시도는 삽입과 카운트가 한 트랜잭션이어야 해서(05-api §5) 카운터가 클라이언트를
 * 받을 수 있어야 한다. 이것 말고 다른 이유로 주입 지점을 늘리지 않는다.
 */
export interface SqlRunner {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Array<{ count: string }> }>;
}

const defaultRunner: SqlRunner = {
  query: (sql, params) => query<{ count: string }>(sql, params),
};

async function countRows(
  runner: SqlRunner,
  sql: string,
  params: unknown[],
): Promise<number> {
  const { rows } = await runner.query(sql, params);
  return Number(rows[0]?.count ?? 0);
}

/** 창의 시작점을 DB 시계로 계산한다. 인스턴스마다 다른 앱 시계를 믿지 않는다. */
function seconds(windowMs: number): number {
  return windowMs / 1000;
}

/** 작성 — `letters.author_fp_hash`로 센다. 지운 편지도 시도로 세어 그대로 둔다. */
export function countLettersByAuthor(
  fpHash: Buffer,
  windowMs: number,
  runner: SqlRunner = defaultRunner,
): Promise<number> {
  return countRows(
    runner,
    `select count(*) as count from letters
      where author_fp_hash = $1
        and created_at > now() - make_interval(secs => $2)`,
    [fpHash, seconds(windowMs)],
  );
}

/** 열람 — `(letter, fp)`. UI의 "남은 시도 3번"이 이 숫자다. */
export function countUnlockAttemptsByLetterAndFp(
  letterId: string,
  fpHash: Buffer,
  windowMs: number,
  runner: SqlRunner = defaultRunner,
): Promise<number> {
  return countRows(
    runner,
    `select count(*) as count from unlock_attempts
      where letter_id = $1 and fp_hash = $2
        and attempted_at > now() - make_interval(secs => $3)`,
    [letterId, fpHash, seconds(windowMs)],
  );
}

/** 열람 — letter 전역. fp를 갈아치우는 우회를 막는다. */
export function countUnlockAttemptsByLetter(
  letterId: string,
  windowMs: number,
  runner: SqlRunner = defaultRunner,
): Promise<number> {
  return countRows(
    runner,
    `select count(*) as count from unlock_attempts
      where letter_id = $1
        and attempted_at > now() - make_interval(secs => $2)`,
    [letterId, seconds(windowMs)],
  );
}

/** 열람 — fp 전역. 한 사람이 여러 편지를 훑는 것을 막는다. */
export function countUnlockAttemptsByFp(
  fpHash: Buffer,
  windowMs: number,
  runner: SqlRunner = defaultRunner,
): Promise<number> {
  return countRows(
    runner,
    `select count(*) as count from unlock_attempts
      where fp_hash = $1
        and attempted_at > now() - make_interval(secs => $2)`,
    [fpHash, seconds(windowMs)],
  );
}

/**
 * 이메일 등록 — `author_contacts`를 `letters.author_fp_hash`로 조인해 센다 (05-api §5).
 *
 * **이 카운터가 재는 것은 "이 fp가 쓴 편지들에 붙은 등록 수"이지 "이 사람이 지금 시도한
 * 횟수"가 아니다.** 등록 시점의 fp와 편지 작성 시점의 `author_fp_hash`는 갈릴 수 있다
 * (모바일↔PC, 시간 경과, 캐리어 NAT). 정상 경로에서는 완료 화면에서 곧바로 등록하므로
 * 같은 fp이고, 갈리는 경우 카운트가 0이 되어 제한이 느슨해지는 쪽으로 틀린다 — 05-api §5가
 * "정상 사용자가 걸리면 안 된다"고 한 방향과 같다. v0에서는 이걸로 충분하다고 본다.
 *
 * `author_contacts` 행이 삭제(해지·개인정보 삭제)되면 카운트에서도 빠진다. 작성은 지운
 * 편지도 시도로 세는 것과 다른데, 여기서는 셀 근거가 되는 행 자체가 사라지기 때문이다.
 */
export function countContactsByAuthorFp(
  fpHash: Buffer,
  windowMs: number,
  runner: SqlRunner = defaultRunner,
): Promise<number> {
  return countRows(
    runner,
    `select count(*) as count
       from author_contacts c
       join letters l on l.id = c.letter_id
      where l.author_fp_hash = $1
        and c.created_at > now() - make_interval(secs => $2)`,
    [fpHash, seconds(windowMs)],
  );
}

/** 신고 — `reports.reporter_fp_hash`로 센다. */
export function countReportsByReporter(
  fpHash: Buffer,
  windowMs: number,
  runner: SqlRunner = defaultRunner,
): Promise<number> {
  return countRows(
    runner,
    `select count(*) as count from reports
      where reporter_fp_hash = $1
        and created_at > now() - make_interval(secs => $2)`,
    [fpHash, seconds(windowMs)],
  );
}
