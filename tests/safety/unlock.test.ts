// 열람 표면 — POST /api/letters/:id/unlock
//
// 안전 회귀 테스트. 기능 테스트는 tests/api/unlock.test.ts에 있다.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as unlock } from "@/app/api/letters/[id]/unlock/route";
import { answerHmac } from "@/lib/answer";
import { query } from "@/lib/db";
import { FAILURE_DELAY_BASE_MS } from "@/lib/unlock/attempts";
import {
  insertLetter,
  randomFpHash,
  randomLetterId,
  type LetterOverrides,
} from "../fixtures/letters";

const ANSWER = "스타벅스";
/** 이 편지의 본문. 맞히기 전에는 응답 어디에도 나오면 안 된다. */
const SECRET_BODY = "잠금_뒤에_있어야_하는_본문";

async function insertLocked(overrides: LetterOverrides = {}) {
  const id = overrides.id ?? randomLetterId();
  return insertLetter({
    id,
    mode: "locked",
    body: SECRET_BODY,
    hint: "2019년 봄, 처음 우산 같이 쓴 날",
    question: "그날 우리가 들어간 카페 이름은?",
    answerHmac: answerHmac(id, ANSWER),
    ...overrides,
  });
}

interface UnlockResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  /** 응답을 받기까지 걸린 시간(ms). 오답 응답에서는 이것도 새면 안 되는 값이다. */
  elapsed: number;
}

async function attempt(
  id: string,
  answer: string,
  options: { ip?: string } = {},
): Promise<UnlockResult> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.ip) headers.set("x-forwarded-for", options.ip);

  const started = performance.now();
  const response = await unlock(
    new Request(`http://localhost/api/letters/${id}/unlock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ answer }),
    }),
    { params: Promise.resolve({ id }) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as Record<string, unknown>,
    text,
    elapsed: performance.now() - started,
  };
}

beforeEach(async () => {
  await query("delete from letters");
});

// docs/05-api.md §7 #5 · §2 · docs/02-threat-model.md S-6
describe("safety#5 · 오답 응답이 정답 길이·내용에 따라 달라지지 않는다", () => {
  // 실패 응답에 정답에 관한 어떤 정보도 넣지 않는다 — 글자 수, 부분 일치,
  // 메시지 차이 전부. 어느 해시(원본·변형)에 맞았는지도 남기지 않는다.

  /** 오답 세 종류. 정답과의 거리도, 길이도 다르다. */
  const WRONG = {
    "한 글자 차이": "스타벅수",
    "완전히 다른 답": "ㅁ",
    "아주 긴 입력": "가".repeat(400),
  };

  it("한 글자 차이 오답과 완전히 다른 오답의 응답 본문이 동일하다", async () => {
    const results: Record<string, UnlockResult> = {};
    for (const [label, answer] of Object.entries(WRONG)) {
      // 편지마다 새로 만든다. 같은 편지에 몰면 시도 번호가 달라져 지연이 달라진다.
      const { letter } = await insertLocked();
      results[label] = await attempt(letter.id, answer);
    }

    const samples = Object.values(results);
    const first = samples[0]!;
    for (const sample of samples) {
      // 상태 코드 · 응답 본문 · 헤더까지 글자 그대로 같다. 응답에 message가 없으므로
      // 문구 차이가 생길 자리 자체가 없다 (05-api §2).
      expect(sample.status).toBe(first.status);
      expect(sample.text).toBe(first.text);
      expect(sample.body).toEqual({ status: "wrong", attemptsRemaining: 2 });
      expect(sample.text).not.toContain(SECRET_BODY);
      expect(sample.text).not.toContain("스타벅스");
    }
  });

  it("응답 시간이 정답과의 거리·입력 길이에 따라 달라지지 않는다", async () => {
    // 근접도는 본문뿐 아니라 **시간으로도** 샌다. 지연은 시도 번호에만 의존해야 한다
    // (attempts.ts의 failureDelayMs).
    const SAMPLES = 3;
    /** 표본의 **최솟값**을 쓴다 — 스케줄링 잡음은 시간을 늘리기만 한다. */
    const floors: Record<string, number> = {};

    for (const [label, answer] of Object.entries(WRONG)) {
      const elapsed: number[] = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        const { letter } = await insertLocked();
        elapsed.push((await attempt(letter.id, answer)).elapsed);
      }
      floors[label] = Math.min(...elapsed);
    }

    const values = Object.values(floors);
    // 지연이 실제로 걸려 있다 — 이게 없으면 아래 비교가 "둘 다 0ms"로 통과한다.
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(FAILURE_DELAY_BASE_MS);
    }

    // 남는 편차는 DB 왕복과 스케줄링이다. 근접도가 시간으로 새면 이 폭을 넘는다.
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread, `응답 시간 편차: ${JSON.stringify(floors)}`).toBeLessThan(200);
  });

  it("실패 로그에 입력한 답도 근접도도 남지 않는다", async () => {
    const { letter } = await insertLocked();
    const typed = "내가_입력한_답_후보";

    const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    try {
      await attempt(letter.id, typed);
      await attempt(letter.id, ANSWER); // 성공 경로도 같다

      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((argument) => String(argument))
        .join("\n");

      expect(logged).not.toContain(typed);
      expect(logged).not.toContain(ANSWER);
      // "어느 해시에 맞았는지"가 새는 흔한 형태들.
      expect(logged.toLowerCase()).not.toContain("variant");
      expect(logged.toLowerCase()).not.toContain("hmac");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    // DB에도 남지 않는다 — `unlock_attempts`가 아는 것은 성공 여부뿐이다 (04 §2).
    const { rows } = await query<Record<string, unknown>>(
      "select * from unlock_attempts where letter_id = $1",
      [letter.id],
    );
    expect(JSON.stringify(rows)).not.toContain(typed);
  });

  it("원본에 맞은 해제와 변형에 맞은 해제가 구분되지 않는다 (D-021)", async () => {
    // 어느 쪽에 맞았는지가 새면 "답이 스벅에 가깝다"를 알려주는 것과 같다.
    const original = await insertLocked();
    const variantId = randomLetterId();
    const variant = await insertLocked({
      id: variantId,
      answerVariantHmacs: [answerHmac(variantId, "스벅")],
    });

    const byOriginal = await attempt(original.letter.id, ANSWER);
    const byVariant = await attempt(variant.letter.id, "스벅");

    // 응답에서 다른 것은 편지마다 다른 unlockId뿐이다.
    expect(Object.keys(byOriginal.body).sort()).toEqual(
      Object.keys(byVariant.body).sort(),
    );
    expect(byOriginal.body.status).toBe(byVariant.body.status);
    expect(byOriginal.status).toBe(byVariant.status);

    // 기록도 같다 — succeeded 하나뿐이고 어느 해시였는지가 들어갈 컬럼이 없다.
    const { rows } = await query<{ letter_id: string; succeeded: boolean }>(
      "select letter_id, succeeded from unlock_attempts order by letter_id",
    );
    expect(rows.map((row) => row.succeeded)).toEqual([true, true]);
  });
});

// docs/05-api.md §7 #6 · §5 「(letter, fp) 제한만으로는 부족하다」
describe("safety#6 · (letter, fp) 소진 후에도 letter 전역 한도가 독립적으로 걸린다", () => {
  // fp를 갈아치우면 무한 시도가 되므로 letter 전역 제한을 함께 둔다.

  /** 창 안 시도 수를 `target`으로 맞춘다. 전부 다른 fp라 층 1에는 걸리지 않는다. */
  async function fillLetterAttempts(
    letterId: string,
    target: number,
  ): Promise<void> {
    const { rows } = await query<{ count: string }>(
      `select count(*) as count from unlock_attempts
        where letter_id = $1 and attempted_at > now() - interval '24 hours'`,
      [letterId],
    );
    for (let index = Number(rows[0]?.count ?? 0); index < target; index += 1) {
      await query(
        "insert into unlock_attempts (letter_id, fp_hash, succeeded) values ($1, $2, false)",
        [letterId, randomFpHash()],
      );
    }
  }

  it("fp를 바꿔 계속 시도해도 letter 전역 50회에서 429가 된다", async () => {
    const { letter } = await insertLocked();

    // 층 1을 실제로 소진시킨다 — fp 하나로 3번.
    for (let index = 0; index < 3; index += 1) {
      const result = await attempt(letter.id, "틀린답", { ip: "203.0.113.60" });
      expect(result.body.status).toBe("wrong");
    }
    expect((await attempt(letter.id, "틀린답", { ip: "203.0.113.60" })).status).toBe(
      429,
    );

    // fp를 갈아치우면 층 1은 리셋된다. 이게 "(letter, fp) 제한만으로는 부족하다"이다.
    expect((await attempt(letter.id, "틀린답", { ip: "203.0.113.61" })).status).toBe(
      200,
    );

    // 창 안 시도를 49건으로 맞춘다(전부 다른 fp). HTTP로 다 보내면 S-6 지연 때문에
    // 분 단위가 되고, 세는 대상은 어차피 이 테이블이다.
    await fillLetterAttempts(letter.id, 49);

    // 50번째는 통과한다 — 아직 한도가 아니다.
    const fiftieth = await attempt(letter.id, "틀린답", { ip: "203.0.113.62" });
    expect(fiftieth.status).toBe(200);
    expect(fiftieth.body.attemptsRemaining).toBe(2); // 이 fp의 층 1은 멀쩡하다

    // 51번째는 **처음 보는 fp인데도** 막힌다. 층 1이 아니라 층 2가 잡은 것이다.
    const blocked = await attempt(letter.id, "틀린답", { ip: "203.0.113.63" });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      status: "rate_limited",
      retryAfter: expect.any(Number),
    });
    expect(blocked.body.retryAfter).toBeGreaterThan(0);

    // 막힌 요청은 기록되지 않는다.
    const { rows } = await query<{ count: string }>(
      "select count(*) as count from unlock_attempts where letter_id = $1",
      [letter.id],
    );
    expect(Number(rows[0]?.count)).toBe(50);
  });

  it("정답이어도 letter 전역 한도에서 막힌다 — 편지가 열리지 않는다", async () => {
    const { letter } = await insertLocked();
    await fillLetterAttempts(letter.id, 50);

    const result = await attempt(letter.id, ANSWER, { ip: "203.0.113.64" });

    expect(result.status).toBe(429);
    expect(result.text).not.toContain(SECRET_BODY);
    const { rows } = await query("select 1 from unlocks");
    expect(rows).toHaveLength(0);
  });
});

// docs/05-api.md §7 #23 · docs/04-data-model.md §4 · docs/00-decisions.md D-021
describe("safety#23 · 답 원문이 answer_hmac·answer_variant_hmacs 어디에도 평문으로 존재하지 않는다", () => {
  // 변형도 해시만 저장된다. DB가 유출돼도 답이 그대로 나오지 않아야 한다.

  const VARIANTS = ["스벅", "스타벅스 홍대점", "starbucks"];

  it("locked 편지를 만든 뒤 letters 행 어디에도 답 문자열이 없다", async () => {
    const id = randomLetterId();
    const { letter } = await insertLocked({
      id,
      answerVariantHmacs: VARIANTS.map((variant) => answerHmac(id, variant)),
    });

    const { rows } = await query<Record<string, unknown>>(
      "select * from letters where id = $1",
      [id],
    );
    // bytea 컬럼을 두 표현으로 함께 훑는다. 컬럼이 늘어나도 이 단언은 남는다.
    const dump = JSON.stringify(rows[0], (_key, value: unknown) =>
      Buffer.isBuffer(value)
        ? `${value.toString("utf8")}|${value.toString("hex")}`
        : value,
    );

    for (const secret of [ANSWER, ...VARIANTS]) {
      expect(dump).not.toContain(secret);
      // 유니코드가 그대로 들어간 경우뿐 아니라 바이트로 들어간 경우도 본다.
      expect(dump).not.toContain(Buffer.from(secret, "utf8").toString("hex"));
    }

    // 저장된 것이 진짜 그 답의 해시라는 것도 함께 고정한다. 이게 없으면 "아무것도
    // 저장하지 않았다"로도 위 단언이 통과한다.
    expect(letter.answer_hmac).toEqual(answerHmac(id, ANSWER));
    expect(letter.answer_hmac?.length).toBe(32);
    expect(letter.answer_variant_hmacs).toHaveLength(VARIANTS.length);
    expect((await attempt(id, "스벅")).body.status).toBe("unlocked");
  });

  it("열람 시도를 해도 답이 어디에도 기록되지 않는다", async () => {
    const id = randomLetterId();
    await insertLocked({
      id,
      answerVariantHmacs: VARIANTS.map((variant) => answerHmac(id, variant)),
    });

    await attempt(id, "틀린답_후보");
    await attempt(id, ANSWER);

    for (const table of ["unlock_attempts", "unlocks", "letters"]) {
      const { rows } = await query<Record<string, unknown>>(
        `select * from ${table}`,
      );
      const dump = JSON.stringify(rows, (_key, value: unknown) =>
        Buffer.isBuffer(value)
          ? `${value.toString("utf8")}|${value.toString("hex")}`
          : value,
      );
      for (const secret of [ANSWER, "틀린답_후보", ...VARIANTS]) {
        expect(dump, `${table}에 답이 남았다`).not.toContain(secret);
      }
    }
  });
});
