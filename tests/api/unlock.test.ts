// POST /api/letters/:id/unlock · POST /api/unlocks/:unlockId/response — 05-api §2
//
// 안전 회귀 테스트(#5 · #6 · #23)는 tests/safety/unlock.test.ts에 있다. 여기는 그
// 표면의 기능 테스트다.
//
// **오답 경로는 실제로 느리다.** 02 S-6의 지연이 붙어 있어 실패 한 번이 0.5~2초다.
// 그래서 한도를 채우는 테스트는 시도를 HTTP로 다 보내지 않고 `unlock_attempts`에 직접
// 넣는다 — 세는 대상이 그 테이블이라 결과는 같고, 지연만 빠진다.

import { beforeEach, describe, expect, it } from "vitest";
import { GET as readLetter } from "@/app/api/letters/[id]/route";
import { POST as unlock } from "@/app/api/letters/[id]/unlock/route";
import { POST as respond } from "@/app/api/unlocks/[unlockId]/response/route";
import { answerHmac } from "@/lib/answer";
import { query } from "@/lib/db";
import { fpHash } from "@/lib/fingerprint";
import { UNLOCK_COOKIE } from "@/lib/letters/read";
import { UNLOCK_COOKIE_MAX_AGE_SECONDS } from "@/lib/unlock/cookie";
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
    // 원문이 아니라 HMAC만 들어간다 (04 §4 · 안전 #23).
    answerHmac: answerHmac(id, ANSWER),
    ...overrides,
  });
}

interface UnlockResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  cookie: string | null;
}

/**
 * `fp_hash`는 IP·UA에서 나온다 (05-api §5). 테스트에서 fp를 갈아치우는 방법은 헤더를
 * 바꾸는 것뿐이다 — 라우트가 실제로 쓰는 경로를 그대로 지난다.
 */
async function attempt(
  id: string,
  answer: unknown,
  options: { ip?: string } = {},
): Promise<UnlockResult> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.ip) headers.set("x-forwarded-for", options.ip);

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
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    text,
    cookie: response.headers.get("set-cookie"),
  };
}

async function attemptCount(letterId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "select count(*) as count from unlock_attempts where letter_id = $1",
    [letterId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** 창 안의 지난 시도. HTTP로 보내는 것과 세는 대상이 같다. */
async function seedAttempts(
  letterId: string,
  count: number,
  options: { sameFp?: boolean } = {},
): Promise<void> {
  const shared = randomFpHash();
  for (let index = 0; index < count; index += 1) {
    await query(
      "insert into unlock_attempts (letter_id, fp_hash, succeeded) values ($1, $2, false)",
      [letterId, options.sameFp ? shared : randomFpHash()],
    );
  }
}

async function setPublicRead(enabled: boolean): Promise<void> {
  await query("update app_settings set value = $2::jsonb where key = $1", [
    "public_read_enabled",
    JSON.stringify(enabled),
  ]);
}

beforeEach(async () => {
  // unlocks · unlock_attempts는 letters를 참조하며 on delete cascade다.
  await query("delete from letters");
  await setPublicRead(true);
});

describe("정답 (05-api §2)", () => {
  it("본문과 unlockId를 돌려주고 해제 쿠키를 굽는다", async () => {
    const { letter } = await insertLocked();

    const result = await attempt(letter.id, ANSWER);

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("unlocked");
    expect(result.body.body).toBe(SECRET_BODY);
    expect(typeof result.body.unlockId).toBe("string");
    expect((result.body.unlockId as string).length).toBe(22);

    // 05-api §2 「HttpOnly 쿠키로도 내린다(30일, 가설값)」.
    expect(result.cookie).toContain(`${UNLOCK_COOKIE}=${result.body.unlockId}`);
    expect(result.cookie).toContain("HttpOnly");
    expect(result.cookie).toContain("SameSite=Lax");
    expect(result.cookie).toContain(`Max-Age=${UNLOCK_COOKIE_MAX_AGE_SECONDS}`);
    expect(UNLOCK_COOKIE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);

    const { rows } = await query<{ unlock_id: string; letter_id: string }>(
      "select unlock_id, letter_id from unlocks",
    );
    expect(rows).toEqual([
      { unlock_id: result.body.unlockId, letter_id: letter.id },
    ]);
  });

  it("자모 분리 입력(NFD)으로도 열린다 — 맥과 윈도우의 한글 입력 차이 (04 §4)", async () => {
    const { letter } = await insertLocked();

    // 편지는 NFC로 잠갔고 입력은 NFD다. 정규화가 흡수하지 못하면 여기서 막힌다.
    const result = await attempt(letter.id, ANSWER.normalize("NFD"));

    expect(result.body.status).toBe("unlocked");
    expect(result.body.body).toBe(SECRET_BODY);
  });

  it("띄어쓰기·문장부호가 달라도 열린다 (04 §4)", async () => {
    const { letter } = await insertLocked();

    const result = await attempt(letter.id, "  스타 벅스!  ");

    expect(result.body.status).toBe("unlocked");
  });

  it("표기 변형으로도 열린다 — `스타벅스`로 잠근 편지가 `스벅`으로 (D-021)", async () => {
    // **변형을 여기서 직접 주입한다.** 작성 시점의 분류기 변형 생성(05-api §1)은 아직
    // 없다. 이 테스트가 고정하는 것은 열람 쪽 경로다 — 저장된 변형 해시가 실제로
    // 대조에 쓰이는가.
    const id = randomLetterId();
    const { letter } = await insertLocked({
      id,
      answerVariantHmacs: [
        answerHmac(id, "스벅"),
        answerHmac(id, "스타벅스 홍대점"),
      ],
    });

    expect((await attempt(letter.id, "스벅")).body.status).toBe("unlocked");

    // 변형이 원본을 밀어내지 않는다. 같은 편지가 원본 답으로도 열린다 (fp를 바꿔 새
    // 해제로 만든다 — 같은 fp면 위에서 만든 행이 그대로 돌아온다).
    const again = await attempt(letter.id, ANSWER, { ip: "203.0.113.30" });
    expect(again.body.status).toBe("unlocked");
    expect((await attempt(letter.id, "폴바셋")).body.status).toBe("wrong");
  });

  it("이미 해제한 (letter, fp)가 다시 맞혀도 행이 늘지 않고 같은 unlockId가 나온다 (04 §4)", async () => {
    const { letter } = await insertLocked();

    const first = await attempt(letter.id, ANSWER);
    const second = await attempt(letter.id, ANSWER);

    expect(second.body.unlockId).toBe(first.body.unlockId);
    expect(await attemptCount(letter.id)).toBe(2); // 시도는 두 번 다 기록된다
    const { rows } = await query("select 1 from unlocks");
    expect(rows).toHaveLength(1); // 북극성 분자는 한 번만 오른다
  });

  it("fp가 다르면 별개의 해제 행이 생긴다 — unique는 (letter, fp)다", async () => {
    const { letter } = await insertLocked();

    const a = await attempt(letter.id, ANSWER, { ip: "203.0.113.10" });
    const b = await attempt(letter.id, ANSWER, { ip: "203.0.113.11" });

    expect(a.body.unlockId).not.toBe(b.body.unlockId);
    const { rows } = await query("select 1 from unlocks");
    expect(rows).toHaveLength(2);
  });
});

describe("오답 (05-api §2 · S-6)", () => {
  it("wrong과 남은 시도만 돌려준다 — 본문도 정답에 관한 것도 없다", async () => {
    const { letter } = await insertLocked();

    const result = await attempt(letter.id, "투썸플레이스");

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual([
      "attemptsRemaining",
      "status",
    ]);
    expect(result.body).toEqual({ status: "wrong", attemptsRemaining: 2 });
    expect(result.text).not.toContain(SECRET_BODY);
    // 재는 것은 **해제 쿠키의 부재**다 (S-6 · 안전 #16). 헤더 전체가 비었는지로 재지
    // 않는다 — 이 경로는 `unlock_attempt`(06 §3, 서버 이벤트)를 남기므로 익명 세션
    // 쿠키가 정상적으로 붙는다. 그 값은 랜덤이라 정답에 관한 정보를 흘리지 않는다.
    expect(result.cookie ?? "").not.toContain(UNLOCK_COOKIE);
    expect(await attemptCount(letter.id)).toBe(1);
  });

  it("남은 시도가 잠금 화면이 보여주는 숫자와 같다 (05-api §5)", async () => {
    const { letter } = await insertLocked();

    const wrong = await attempt(letter.id, "투썸플레이스");

    const response = await readLetter(
      new Request(`http://localhost/api/letters/${letter.id}`),
      { params: Promise.resolve({ id: letter.id }) },
    );
    const body = (await response.json()) as { attemptsRemaining: number };
    // 화면이 3번 남았다고 하는데 서버가 더 받아주면 그게 S-6이 뚫리는 형태다.
    expect(body.attemptsRemaining).toBe(wrong.body.attemptsRemaining);
  });
});

describe("시도 제한 (05-api §5)", () => {
  it("(letter, fp) 3회를 쓰면 4번째는 429이고 시도로 세지 않는다", async () => {
    const { letter } = await insertLocked();
    await seedAttempts(letter.id, 3, { sameFp: true });
    // 위 3건은 다른 fp다. 이 요청의 fp로는 아직 한 번도 쓰지 않았다.
    expect((await attempt(letter.id, "틀린답")).body).toEqual({
      status: "wrong",
      attemptsRemaining: 2,
    });

    const second = await attempt(letter.id, "틀린답");
    expect(second.body.attemptsRemaining).toBe(1);
    const third = await attempt(letter.id, "틀린답");
    expect(third.body.attemptsRemaining).toBe(0);

    const fourth = await attempt(letter.id, "틀린답");
    expect(fourth.status).toBe(429);
    expect(fourth.body.status).toBe("rate_limited");
    expect(fourth.body.retryAfter).toBeGreaterThan(0);
    // 24시간 창이라 회복까지 그 이상 걸리지 않는다.
    expect(fourth.body.retryAfter).toBeLessThanOrEqual(24 * 60 * 60);

    // 막힌 요청은 시도가 아니다 — 세면 창이 영영 돌아오지 않는다.
    expect(await attemptCount(letter.id)).toBe(6);
  });

  it("소진된 뒤에는 정답도 열지 못한다 (S-6)", async () => {
    const { letter } = await insertLocked();
    for (let i = 0; i < 3; i += 1) await attempt(letter.id, "틀린답");

    const result = await attempt(letter.id, ANSWER);

    expect(result.status).toBe(429);
    expect(result.text).not.toContain(SECRET_BODY);
    // 위와 같다 — 해제 쿠키가 없다는 것만 잰다. 세션 쿠키는 붙어도 되고, 붙지 않으면
    // 첫 요청마다 session_id가 달라져 06 §4의 열람 퍼널이 요청마다 끊긴다.
    expect(result.cookie ?? "").not.toContain(UNLOCK_COOKIE);
    const { rows } = await query("select 1 from unlocks");
    expect(rows).toHaveLength(0);
  });

  it("시간 기반 회복이다 — 창 밖으로 나간 시도는 세지 않는다 (03 흐름 2)", async () => {
    const { letter } = await insertLocked();
    const fp = randomFpHash();
    await query(
      `insert into unlock_attempts (letter_id, fp_hash, succeeded, attempted_at)
       values ($1, $2, false, now() - interval '25 hours'),
              ($1, $2, false, now() - interval '25 hours'),
              ($1, $2, false, now() - interval '25 hours')`,
      [letter.id, fp],
    );

    // 같은 fp가 아니어도 결과는 같다 — 창 밖 시도는 어느 층에서도 세지 않는다.
    const result = await attempt(letter.id, ANSWER);
    expect(result.body.status).toBe("unlocked");
  });

  it("fp가 다르면 (letter, fp) 카운트는 독립이다", async () => {
    const { letter } = await insertLocked();
    for (let i = 0; i < 3; i += 1) {
      await attempt(letter.id, "틀린답", { ip: "203.0.113.20" });
    }
    expect(
      (await attempt(letter.id, "틀린답", { ip: "203.0.113.20" })).status,
    ).toBe(429);

    const other = await attempt(letter.id, "틀린답", { ip: "203.0.113.21" });
    expect(other.status).toBe(200);
    expect(other.body.attemptsRemaining).toBe(2);
  });

  it("fp 전역 30 / 10분에 걸린다 — 한 사람이 여러 편지를 훑는 경우 (05-api §5)", async () => {
    const target = await insertLocked();
    // 요청 헤더가 만들어낼 fp와 같은 값을 미리 계산한다 (05-api §5의 산출식).
    const ip = "203.0.113.40";
    const fp = fpHash(ip, "");

    // **다른 편지 30통**에 남긴 시도다. 이 편지에는 한 번도 시도하지 않았고, 층 1과
    // 층 2는 둘 다 여유가 있다. 그런데도 막혀야 층 3이 독립적으로 작동하는 것이다.
    for (let index = 0; index < 30; index += 1) {
      const { letter } = await insertLocked();
      await query(
        "insert into unlock_attempts (letter_id, fp_hash, succeeded) values ($1, $2, false)",
        [letter.id, fp],
      );
    }

    const blocked = await attempt(target.letter.id, "틀린답", { ip });
    expect(blocked.status).toBe(429);
    // 10분 창이라 회복까지 그 이상 걸리지 않는다.
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(blocked.body.retryAfter).toBeLessThanOrEqual(10 * 60);

    // 다른 fp는 멀쩡하다 — 층 3은 fp별이다.
    const other = await attempt(target.letter.id, "틀린답", {
      ip: "203.0.113.41",
    });
    expect(other.status).toBe(200);
  });
});

describe("동시 요청 (05-api §5 — 삽입과 카운트가 한 트랜잭션)", () => {
  it("같은 편지에 동시에 5번 시도해도 3번만 기록된다", async () => {
    const { letter } = await insertLocked();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => attempt(letter.id, "틀린답")),
    );

    const recorded = results.filter((r) => r.body.status === "wrong");
    const limited = results.filter((r) => r.status === 429);
    expect(recorded).toHaveLength(3);
    expect(limited).toHaveLength(2);
    expect(await attemptCount(letter.id)).toBe(3);
  });

  it("동시에 맞혀도 해제 행은 하나이고 unlockId가 같다", async () => {
    const { letter } = await insertLocked();

    const results = await Promise.all(
      Array.from({ length: 3 }, () => attempt(letter.id, ANSWER)),
    );

    const ids = new Set(results.map((r) => r.body.unlockId));
    expect(results.every((r) => r.body.status === "unlocked")).toBe(true);
    expect(ids.size).toBe(1);
    const { rows } = await query("select 1 from unlocks");
    expect(rows).toHaveLength(1);
  });
});

describe("열 것이 없는 요청", () => {
  it("없는 편지는 404다", async () => {
    expect((await attempt(randomLetterId(), ANSWER)).status).toBe(404);
  });

  it("내려간 편지는 404다 (05-api §2 「상태별 표면 응답」)", async () => {
    for (const status of ["hidden_auto", "hidden_admin", "deleted_by_author"] as const) {
      const { letter } = await insertLocked({ status });
      const result = await attempt(letter.id, ANSWER);
      expect(result.status).toBe(404);
      expect(result.text).not.toContain(SECRET_BODY);
    }
  });

  it("open 모드 편지도 404다 — 해제할 것이 없다", async () => {
    const { letter } = await insertLetter({ body: SECRET_BODY });
    const result = await attempt(letter.id, ANSWER);
    expect(result.status).toBe(404);
    expect(result.text).not.toContain(SECRET_BODY);
  });

  it("빈 답·형식이 틀린 요청은 400이고 시도로 세지 않는다", async () => {
    const { letter } = await insertLocked();

    for (const answer of ["", "   ", 42, null, undefined]) {
      expect((await attempt(letter.id, answer)).status).toBe(400);
    }
    expect((await attempt(letter.id, "가".repeat(501))).status).toBe(400);
    expect(await attemptCount(letter.id)).toBe(0);
  });

  it("공개 읽기가 꺼져 있으면 503이다 (05-api §6)", async () => {
    const { letter } = await insertLocked();
    await setPublicRead(false);

    const result = await attempt(letter.id, ANSWER);

    // 404가 아니라 503이다 — 스위치는 전역이라 특정 편지에 대해 아무것도 알려주지 않는다.
    expect(result.status).toBe(503);
    expect(result.text).not.toContain(SECRET_BODY);
    expect(await attemptCount(letter.id)).toBe(0);
  });
});

describe("POST /api/unlocks/:unlockId/response (05-api §2 · 북극성 지표)", () => {
  async function unlockedId(): Promise<string> {
    const { letter } = await insertLocked();
    const result = await attempt(letter.id, ANSWER);
    return result.body.unlockId as string;
  }

  async function send(unlockId: string, response: unknown): Promise<number> {
    const result = await respond(
      new Request(`http://localhost/api/unlocks/${unlockId}/response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      }),
      { params: Promise.resolve({ unlockId }) },
    );
    return result.status;
  }

  async function storedResponse(unlockId: string): Promise<string | null> {
    const { rows } = await query<{ recipient_response: string | null }>(
      "select recipient_response from unlocks where unlock_id = $1",
      [unlockId],
    );
    return rows[0]?.recipient_response ?? null;
  }

  it("세 응답을 기록하고 204를 낸다", async () => {
    for (const response of ["yes", "no", "unknown"] as const) {
      const unlockId = await unlockedId();
      expect(await send(unlockId, response)).toBe(204);
      expect(await storedResponse(unlockId)).toBe(response);
    }
  });

  it("두 번째 응답은 덮어쓰지 않는다 — 첫 응답이 가장 정직하다 (04 §4)", async () => {
    const unlockId = await unlockedId();

    expect(await send(unlockId, "yes")).toBe(204);
    expect(await send(unlockId, "no")).toBe(204);

    expect(await storedResponse(unlockId)).toBe("yes");
  });

  it("재해제해도 응답이 지워지지 않는다", async () => {
    const { letter } = await insertLocked();
    const first = await attempt(letter.id, ANSWER);
    const unlockId = first.body.unlockId as string;
    await send(unlockId, "yes");

    const second = await attempt(letter.id, ANSWER);

    expect(second.body.unlockId).toBe(unlockId);
    expect(await storedResponse(unlockId)).toBe("yes");
  });

  it("없는 unlockId는 404, 목록 밖의 값은 400이다", async () => {
    expect(await send(randomLetterId(), "yes")).toBe(404);
    expect(await send(await unlockedId(), "maybe")).toBe(400);
  });
});
