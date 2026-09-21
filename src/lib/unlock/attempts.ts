// B 모드 열람 시도 횟수 (05-api §5 · 03 흐름 2).
//
// **B모드 워커가 이 함수를 재사용한다. 시도 횟수 계산은 여기 한 곳에만 있다.**
// 잠금 화면이 보여주는 "남은 시도 N번"과 `POST /api/letters/:id/unlock`이 실제로
// 허용하는 횟수가 갈라지면, 그건 S-6(브루트포스) 방어가 조용히 뚫리는 형태다.
// 화면은 3번 남았다고 하는데 서버는 더 받아주는 상태를 테스트로 잡을 방법이 없다.
//
// 05-api §5의 열람 제한은 3층이다 — `(letter, fp)` 3/24시간 · letter 전역 50/24시간 ·
// fp 전역 30/10분. **세 층 전부 이 파일에 있다.** 조회 표면(`GET /api/letters/:id` ·
// `/m/:id`)이 쓰는 것은 첫 번째 층뿐이지만(`attemptState`), 실제로 시도를 받는
// `POST /api/letters/:id/unlock`은 세 층을 다 지나야 한다(`recordUnlockAttempt`).

import type { PoolClient } from "pg";
import { sha256 } from "../crypto";
import { query, withTransaction } from "../db";
import {
  LIMITS,
  countUnlockAttemptsByFp,
  countUnlockAttemptsByLetter,
  countUnlockAttemptsByLetterAndFp,
  exceeded,
  type Rule,
  type SqlRunner,
} from "../ratelimit";

/** 05-api §5 · `(letter, fp)` 3 / 24시간. 가설값이고 조정은 ratelimit.ts에서 한다. */
const RULE = LIMITS.unlockPerLetterAndFpPerDay;
/** 05-api §5 · letter 전역 50 / 24시간. fp를 갈아치우는 우회를 막는 층이다. */
const LETTER_RULE = LIMITS.unlockPerLetterPerDay;
/** 05-api §5 · fp 전역 30 / 10분. 한 사람이 여러 편지를 훑는 것을 막는 층이다. */
const FP_RULE = LIMITS.unlockPerFpPer10Min;

export interface AttemptState {
  /** 03 흐름 2의 "남은 시도 N번". 0이면 지금은 더 시도할 수 없다. */
  attemptsRemaining: number;
  /**
   * 시도가 한 번 되살아나는 시각 (05-api §2 GET 응답의 `lockedUntil`). 남아 있으면 null.
   *
   * 03 흐름 2가 "시도 소진은 영구 차단이 아니라 **시간 기반 회복**"이라고 못박았다.
   * 창이 24시간 슬라이딩이므로 창 안 **가장 오래된** 시도가 창 밖으로 나가는 순간 한
   * 번이 생긴다 — 그 시각이 `가장 오래된 시도 + 24시간`이다.
   */
  lockedUntil: string | null;
}

/**
 * `(letter, fp)`의 현재 시도 상태.
 *
 * 창 안에 남은 시도가 있으면 질의는 한 번이다. 소진된 경우에만 회복 시각을 위해 한 번
 * 더 본다 — 정상 경로(대부분 시도 이력이 없다)에 왕복을 늘리지 않는다.
 */
export async function attemptState(
  letterId: string,
  fpHash: Buffer,
): Promise<AttemptState> {
  const used = await countUnlockAttemptsByLetterAndFp(
    letterId,
    fpHash,
    RULE.windowMs,
  );
  const attemptsRemaining = Math.max(0, RULE.limit - used);
  if (attemptsRemaining > 0) return { attemptsRemaining, lockedUntil: null };

  const { rows } = await query<{ locked_until: Date | null }>(
    `select min(attempted_at) + make_interval(secs => $3) as locked_until
       from unlock_attempts
      where letter_id = $1 and fp_hash = $2
        and attempted_at > now() - make_interval(secs => $3)`,
    [letterId, fpHash, RULE.windowMs / 1000],
  );

  return {
    attemptsRemaining,
    lockedUntil: rows[0]?.locked_until?.toISOString() ?? null,
  };
}

// ── 시도 기록 (`POST /api/letters/:id/unlock`) ──────────────
//
// 05-api §5: **열람 시도만 삽입과 카운트를 한 트랜잭션에 묶는다** — 여기만 초과의 대가가
// "잠긴 편지가 열린다"이기 때문이다. 다른 레이트리밋은 동시 요청 초과를 감수한다.
//
// **트랜잭션만으로는 부족하다.** READ COMMITTED에서 동시 요청 둘은 서로의 커밋 전 삽입을
// 보지 못한다 — 둘 다 "2번 썼다"를 읽고 둘 다 넣어 한도 3에 4번째 시도가 들어간다.
// 그래서 편지 단위 advisory lock을 트랜잭션 맨 앞에 세워 **같은 편지의 시도를
// 직렬화**한다. 락은 편지별이라 다른 편지의 시도는 그대로 병렬이다.
//
// 감수하는 잔여: fp 전역(층 3)은 **서로 다른 편지**에 동시에 들어온 시도끼리는 여전히
// 겹쳐 셀 수 있다. fp로도 락을 잡으면 없앨 수 있지만, 05-api §5의 한국 모바일 캐리어
// NAT 때문에 다수 사용자가 한 fp를 공유하므로 그 락은 무관한 사람들의 열람을 서로
// 줄 세운다. 층 3의 초과분은 층 1·2가 편지마다 다시 막으므로 "잠긴 편지가 열린다"로
// 이어지지 않는다.

/**
 * 실패 지연 (02 S-6 「실패 시 지연 증가 (exponential backoff)」).
 *
 * **전부 가설값이다 — 문서에 값이 없다.** 브루트포스 비용의 주된 방어는 지연이 아니라
 * 횟수 제한(층 1의 3회)이고, 지연은 자동화 도구의 왕복을 느리게 만드는 보조다. 그래서
 * 사람이 견디는 범위 안에서만 올린다 — 진짜 수신자가 오타 한 번 낸 대가로 몇 초를
 * 기다리면 그건 03 흐름 2가 "제품 실패"라고 부른 쪽에 가까워진다.
 *
 * 지연은 **시도 번호에만** 의존한다. 입력한 답의 길이·내용에 의존하는 순간 응답 시간이
 * 정답 근접도를 흘리는 통로가 된다 (S-6 · 안전 #5).
 */
export const FAILURE_DELAY_BASE_MS = 500;
/** 위와 같은 가설값. 층 1이 3회라 실제로 닿는 최대값이다. */
export const FAILURE_DELAY_MAX_MS = 2000;

/** `attemptNo`번째 실패에 붙일 지연. 500 · 1000 · 2000ms. */
export function failureDelayMs(attemptNo: number): number {
  return Math.min(
    FAILURE_DELAY_BASE_MS * 2 ** (attemptNo - 1),
    FAILURE_DELAY_MAX_MS,
  );
}

export type UnlockAttempt<T> =
  /** 세 층 중 하나가 이미 찼다. 시도를 **기록하지 않고** 답도 대조하지 않는다. */
  | { status: "rate_limited"; retryAfter: number }
  | {
      status: "recorded";
      succeeded: boolean;
      /**
       * 이번 시도가 `(letter, fp)` 창에서 몇 번째인가 (1부터).
       *
       * 지연 계산과 계측(`unlock_attempt { attemptNo }`)이 쓴다. fp를 갈아치우면 이
       * 번호가 1로 돌아가지만, 그 우회는 층 2(letter 전역 50회)가 막는다.
       */
      attemptNo: number;
      /** 이번 시도를 센 뒤 남은 횟수. 화면의 "남은 시도 N번"과 같은 숫자다. */
      attemptsRemaining: number;
      value: T;
    };

/**
 * 층 세 개를 확인하고 시도 한 건을 기록한다. 전부 한 트랜잭션이다.
 *
 * `judge`는 **락 안에서** 돈다 — 답 대조와 `unlocks` 삽입이 시도 기록과 함께 커밋되거나
 * 함께 없던 일이 된다. `judge`가 던지면 시도도 남지 않는다: 서버 오류가 진짜 수신자의
 * 시도 횟수를 깎으면 안 된다.
 */
export async function recordUnlockAttempt<T>(
  letterId: string,
  fpHash: Buffer,
  judge: (client: PoolClient) => Promise<{ succeeded: boolean; value: T }>,
): Promise<UnlockAttempt<T>> {
  return withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock($1, $2)", [
      LOCK_CLASS,
      lockKey(letterId),
    ]);
    const runner = runnerFor(client);

    // 층 1 — `(letter, fp)`. 화면이 보여주는 숫자다.
    const used = await countUnlockAttemptsByLetterAndFp(
      letterId,
      fpHash,
      RULE.windowMs,
      runner,
    );
    if (exceeded(used, RULE)) {
      return limited(client, RULE, "letter_id = $2 and fp_hash = $3", [
        letterId,
        fpHash,
      ]);
    }

    // 층 2 — letter 전역. fp를 갈아치우는 우회를 막는다.
    const byLetter = await countUnlockAttemptsByLetter(
      letterId,
      LETTER_RULE.windowMs,
      runner,
    );
    if (exceeded(byLetter, LETTER_RULE)) {
      return limited(client, LETTER_RULE, "letter_id = $2", [letterId]);
    }

    // 층 3 — fp 전역. 한 사람이 여러 편지를 훑는 것을 막는다.
    const byFp = await countUnlockAttemptsByFp(fpHash, FP_RULE.windowMs, runner);
    if (exceeded(byFp, FP_RULE)) {
      return limited(client, FP_RULE, "fp_hash = $2", [fpHash]);
    }

    const { succeeded, value } = await judge(client);
    await client.query(
      "insert into unlock_attempts (letter_id, fp_hash, succeeded) values ($1, $2, $3)",
      [letterId, fpHash, succeeded],
    );

    const attemptNo = used + 1;
    return {
      status: "recorded",
      succeeded,
      attemptNo,
      attemptsRemaining: Math.max(0, RULE.limit - attemptNo),
      value,
    };
  });
}

/**
 * 다시 시도할 수 있을 때까지 남은 초.
 *
 * 창이 슬라이딩이므로 창 안 **가장 오래된** 시도가 창 밖으로 나가는 순간 한 칸이 빈다 —
 * `attemptState`의 `lockedUntil`과 같은 계산이다. 두 값이 갈라지면 화면이 말하는 회복
 * 시각과 서버가 실제로 받아주는 시각이 어긋난다.
 *
 * `where`는 이 파일 안의 고정 문자열 셋 중 하나다. 값은 전부 `$` 파라미터로 간다.
 */
async function limited(
  client: PoolClient,
  rule: Rule,
  where: string,
  keys: unknown[],
): Promise<{ status: "rate_limited"; retryAfter: number }> {
  const { rows } = await client.query<{ seconds: string | null }>(
    `select extract(epoch from (min(attempted_at) + make_interval(secs => $1) - now())) as seconds
       from unlock_attempts
      where ${where}
        and attempted_at > now() - make_interval(secs => $1)`,
    [rule.windowMs / 1000, ...keys],
  );

  // 0이나 음수를 내려보내면 "지금 다시 해봐라"가 되어 클라이언트가 그대로 되돌아온다.
  const seconds = Number(rows[0]?.seconds ?? 0);
  return {
    status: "rate_limited",
    retryAfter: Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 0)),
  };
}

/** ratelimit.ts의 카운터에 트랜잭션 클라이언트를 물린다 (05-api §5). */
function runnerFor(client: PoolClient): SqlRunner {
  return {
    query: (sql, params) => client.query<{ count: string }>(sql, params),
  };
}

/** advisory lock 키 한 쌍의 앞자리. 다른 용도의 락과 섞이지 않게 상수로 고정한다. */
const LOCK_CLASS = 1;

/** 편지 ID → int4. advisory lock 키가 int4 쌍이라 32비트로 눌러야 한다. */
function lockKey(letterId: string): number {
  return sha256(letterId).readInt32BE(0);
}
