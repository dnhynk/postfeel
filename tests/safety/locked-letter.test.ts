// 잠긴 편지 조회 표면 — GET /api/letters/:id
//
// 안전 회귀 테스트. 구현은 이 표면을 맡은 워커가 채운다.

import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/letters/[id]/route";
import { query } from "@/lib/db";
import { UNLOCK_COOKIE } from "@/lib/letters/read";
import {
  insertLetter,
  randomFpHash,
  randomLetterId,
  type LetterOverrides,
} from "../fixtures/letters";

/** 이 편지들의 본문. 응답 어디에도 이 문자열이 나오면 안 된다. */
const SECRET_BODY = "잠금_뒤에_있어야_하는_본문";

function insertLocked(overrides: LetterOverrides = {}) {
  return insertLetter({
    mode: "locked",
    body: SECRET_BODY,
    hint: "2019년 봄, 처음 우산 같이 쓴 날",
    question: "그날 우리가 들어간 카페 이름은?",
    answerHmac: randomFpHash(),
    ...overrides,
  });
}

async function read(
  id: string,
  cookie?: string,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", cookie);

  const response = await GET(
    new Request(`http://localhost/api/letters/${id}`, { headers }),
    { params: Promise.resolve({ id }) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as Record<string, unknown>,
    text,
  };
}

/** 해제 기록 한 행. 실제 해제는 다른 표면(POST .../unlock)이 만든다. */
async function insertUnlock(letterId: string): Promise<string> {
  const unlockId = randomLetterId();
  await query(
    "insert into unlocks (unlock_id, letter_id, fp_hash) values ($1, $2, $3)",
    [unlockId, letterId, randomFpHash()],
  );
  return unlockId;
}

beforeEach(async () => {
  await query("delete from letters");
});

// docs/05-api.md §7 #1 · §2 「GET /api/letters/:id」
describe("safety#1 · 해제 쿠키가 없는 잠긴 편지 GET 응답에 body가 없다", () => {
  // 직렬화 실수로 새기 가장 쉬운 지점이라 테스트로 고정한다.
  it("mode='locked' 미해제 응답은 hint·question·attemptsRemaining만 담고 body 키가 아예 없다", async () => {
    const { letter } = await insertLocked();

    const { status, body, text } = await read(letter.id);

    expect(status).toBe(200);
    // 키가 `undefined`로 있는 것도 아니고 아예 없어야 한다.
    expect(Object.keys(body).sort()).toEqual([
      "attemptsRemaining",
      "createdAt",
      "hint",
      "id",
      "lockedUntil",
      "mode",
      "question",
      "relationship",
    ]);
    // 직렬화된 문자열 자체에도 본문이 없다 — 키 이름이 바뀌어도 이 단언은 남는다.
    expect(text).not.toContain(SECRET_BODY);
  });

  it("쿠키 헤더가 아예 없어도, 값이 빈 쿠키여도 마찬가지다", async () => {
    const { letter } = await insertLocked();

    for (const cookie of [undefined, "", `${UNLOCK_COOKIE}=`, "other=1"]) {
      const { body, text } = await read(letter.id, cookie);
      expect(body).not.toHaveProperty("body");
      expect(text).not.toContain(SECRET_BODY);
    }
  });
});

// docs/05-api.md §7 #16 · §2 「예외 하나 — 이미 연 사람」 · docs/04-data-model.md §4
describe("safety#16 · 위조하거나 다른 편지의 unlock_id를 담은 쿠키로는 body가 열리지 않는다", () => {
  // 쿠키 값은 DB 대조로만 검증한다. 쿠키에 든 letter_id를 믿으면 값을 바꿔 아무
  // 편지나 열 수 있다.
  it("존재하지 않는 unlock_id 쿠키는 무시된다", async () => {
    const { letter } = await insertLocked();

    const { body, text } = await read(
      letter.id,
      `${UNLOCK_COOKIE}=${randomLetterId()}`,
    );

    expect(body).not.toHaveProperty("body");
    expect(text).not.toContain(SECRET_BODY);
    expect(body.mode).toBe("locked");
  });

  it("다른 편지의 unlock_id 쿠키로는 이 편지의 body가 나오지 않는다", async () => {
    const target = await insertLocked();
    const other = await insertLocked();

    // 쿠키 자체는 진짜다 — other 편지의 해제 기록이다. 그래도 target은 열리지 않는다.
    const unlockId = await insertUnlock(other.letter.id);
    const cookie = `${UNLOCK_COOKIE}=${unlockId}`;

    const blocked = await read(target.letter.id, cookie);
    expect(blocked.body).not.toHaveProperty("body");
    expect(blocked.text).not.toContain(SECRET_BODY);

    // 같은 쿠키가 자기 편지에서는 동작한다. 이게 없으면 위 단언은 "쿠키 처리가 통째로
    // 죽어 있어도" 통과한다.
    const allowed = await read(other.letter.id, cookie);
    expect(allowed.body.body).toBe(SECRET_BODY);
  });

  it("쿠키 값을 이 편지의 ID로 바꿔치기해도 열리지 않는다", async () => {
    const { letter } = await insertLocked();

    // unlock_id 자리에 편지 ID를 넣어 본다. unlocks에 그런 행이 없으므로 걸린다.
    const { body, text } = await read(
      letter.id,
      `${UNLOCK_COOKIE}=${letter.id}`,
    );

    expect(body).not.toHaveProperty("body");
    expect(text).not.toContain(SECRET_BODY);
  });
});
