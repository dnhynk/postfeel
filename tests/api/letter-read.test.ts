// GET /api/letters/:id — 05-api §2
//
// 안전 회귀 테스트(#1 · #16)는 tests/safety/locked-letter.test.ts에 있다. 여기는 그
// 표면의 기능 테스트다.

import { beforeEach, describe, expect, it, vi } from "vitest";

// /m/:id 페이지(서버 컴포넌트)를 렌더하려면 요청 스코프가 필요하다. 여기에는 요청이
// 없으므로 쿠키·헤더를 모의로 대신한다. 라우트 핸들러는 next/headers를 쓰지 않으므로
// 이 모의는 아래 API 테스트에 영향을 주지 않는다.
//
// vi.hoisted를 쓰는 이유: vi.mock 팩토리는 import보다 먼저 끌어올려진다. 일반 변수를
// 참조하면 초기화 전에 닿는다.
const requestScope = vi.hoisted(() => ({
  unlockCookie: undefined as string | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      requestScope.unlockCookie === undefined
        ? undefined
        : { name, value: requestScope.unlockCookie },
  }),
  headers: async () => new Headers(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { GET } from "@/app/api/letters/[id]/route";
import LetterPage from "@/app/m/[id]/page";
import { query } from "@/lib/db";
import { UNKNOWN_IP, fpHash } from "@/lib/fingerprint";
import { UNLOCK_COOKIE } from "@/lib/letters/read";
import {
  insertLetter,
  randomFpHash,
  randomLetterId,
  type LetterOverrides,
} from "../fixtures/letters";

/** 헤더가 없는 요청에서 fingerprint()가 만드는 값 (05-api §5). */
const REQUEST_FP = fpHash(UNKNOWN_IP, "");

async function read(
  id: string,
  options: { cookie?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const headers = new Headers();
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);

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

function insertLocked(overrides: LetterOverrides = {}) {
  return insertLetter({
    mode: "locked",
    hint: "2019년 봄, 처음 우산 같이 쓴 날",
    question: "그날 우리가 들어간 카페 이름은?",
    answerHmac: randomFpHash(),
    ...overrides,
  });
}

async function setPublicRead(enabled: boolean): Promise<void> {
  await query("update app_settings set value = $2::jsonb where key = $1", [
    "public_read_enabled",
    JSON.stringify(enabled),
  ]);
}

beforeEach(async () => {
  await query("delete from letters");
  await setPublicRead(true);
  requestScope.unlockCookie = undefined;
});

describe("mode='open' (05-api §2)", () => {
  it("본문과 반응을 준다", async () => {
    const { letter } = await insertLetter({
      body: "그때 네가 먼저 미안하다고 했는데",
      relationship: "ex",
    });
    await query(
      "insert into reactions (letter_id, kind, fp_hash) values ($1, 'same', $2)",
      [letter.id, randomFpHash()],
    );

    const { status, body } = await read(letter.id);

    expect(status).toBe(200);
    expect(body).toEqual({
      id: letter.id,
      mode: "open",
      relationship: "ex",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      body: "그때 네가 먼저 미안하다고 했는데",
      reactions: { same: 1 },
    });
  });

  it("등급 medium도 여기서는 정상 조회된다 — 링크 접근은 허용이다", async () => {
    const { letter } = await insertLetter({ riskLevel: "medium" });
    const { status, body } = await read(letter.id);
    expect(status).toBe(200);
    expect(body.body).toBe("테스트 편지 본문.");
  });
});

describe("mode='locked' 미해제 (05-api §2)", () => {
  it("단서·질문·남은 시도만 준다", async () => {
    const { letter } = await insertLocked();

    const { status, body } = await read(letter.id);

    expect(status).toBe(200);
    expect(body).toEqual({
      id: letter.id,
      mode: "locked",
      relationship: "friend",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      hint: "2019년 봄, 처음 우산 같이 쓴 날",
      question: "그날 우리가 들어간 카페 이름은?",
      attemptsRemaining: 3,
      lockedUntil: null,
    });
  });

  it("시도한 만큼 남은 횟수가 준다 (05-api §5 · (letter, fp) 3/24시간)", async () => {
    const { letter } = await insertLocked();
    await query(
      "insert into unlock_attempts (letter_id, fp_hash, succeeded) values ($1, $2, false)",
      [letter.id, REQUEST_FP],
    );

    const { body } = await read(letter.id);

    expect(body.attemptsRemaining).toBe(2);
    expect(body.lockedUntil).toBeNull();
  });

  it("다른 fp의 시도는 내 남은 횟수를 깎지 않는다", async () => {
    const { letter } = await insertLocked();
    await query(
      "insert into unlock_attempts (letter_id, fp_hash, succeeded) values ($1, $2, false)",
      [letter.id, randomFpHash()],
    );

    const { body } = await read(letter.id);

    expect(body.attemptsRemaining).toBe(3);
  });

  it("소진되면 회복 시각이 붙는다 — 영구 차단이 아니다 (03 흐름 2)", async () => {
    const { letter } = await insertLocked();
    const oldest = new Date(Date.now() - 60 * 60 * 1000); // 1시간 전
    await query(
      `insert into unlock_attempts (letter_id, fp_hash, succeeded, attempted_at)
       values ($1, $2, false, $3), ($1, $2, false, now()), ($1, $2, false, now())`,
      [letter.id, REQUEST_FP, oldest],
    );

    const { body } = await read(letter.id);

    expect(body.attemptsRemaining).toBe(0);
    // 가장 오래된 시도 + 24시간에 한 번이 되살아난다.
    const lockedUntil = new Date(body.lockedUntil as string).getTime();
    expect(lockedUntil).toBeGreaterThan(Date.now());
    expect(Math.abs(lockedUntil - (oldest.getTime() + 24 * 60 * 60 * 1000))).
      toBeLessThan(5_000);
  });
});

describe("이미 연 사람 (05-api §2 · 04 §4)", () => {
  it("해제 쿠키가 이 편지의 것이면 본문을 준다", async () => {
    const { letter } = await insertLocked({ body: "잠금 뒤에 있던 본문." });
    const unlockId = randomLetterId();
    await query(
      "insert into unlocks (unlock_id, letter_id, fp_hash) values ($1, $2, $3)",
      [unlockId, letter.id, randomFpHash()],
    );

    const { status, body } = await read(letter.id, {
      cookie: `${UNLOCK_COOKIE}=${unlockId}`,
    });

    expect(status).toBe(200);
    expect(body.body).toBe("잠금 뒤에 있던 본문.");
    // 형태는 open과 같지만 mode는 실제 값을 유지한다. 'open'으로 내리면
    // 06-analytics §3의 letter_view { mode }가 거짓이 된다.
    expect(body.mode).toBe("locked");
    expect(body).not.toHaveProperty("hint");
    expect(body).not.toHaveProperty("attemptsRemaining");
  });

  it("쿠키가 여러 개여도 이름이 맞는 것만 본다", async () => {
    const { letter } = await insertLocked();
    const unlockId = randomLetterId();
    await query(
      "insert into unlocks (unlock_id, letter_id, fp_hash) values ($1, $2, $3)",
      [unlockId, letter.id, randomFpHash()],
    );

    const { body } = await read(letter.id, {
      cookie: `pf_session=abc; ${UNLOCK_COOKIE}=${unlockId}; other=1`,
    });

    expect(body.body).toBe("테스트 편지 본문.");
  });
});

describe("없는 편지 · 내려간 편지 (05-api §2 「상태별 표면 응답」)", () => {
  it("존재하지 않는 ID는 404다", async () => {
    const { status } = await read(randomLetterId());
    expect(status).toBe(404);
  });

  it("비공개·삭제 상태는 404다", async () => {
    for (const status of [
      "hidden_auto",
      "hidden_admin",
      "deleted_by_author",
    ] as const) {
      const { letter } = await insertLetter({ status });
      const response = await read(letter.id);
      expect(response.status).toBe(404);
    }
  });
});

describe("킬 스위치 (05-api §6)", () => {
  it("public_read_enabled=false면 503이고 본문이 없다", async () => {
    const { letter } = await insertLetter({ body: "꺼진_동안_보이면_안_되는_본문" });
    await setPublicRead(false);

    const { status, body, text } = await read(letter.id);

    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe("public_read_disabled");
    expect(text).not.toContain("꺼진_동안_보이면_안_되는_본문");
  });

  it("writing_enabled와 독립이다 — 읽기만 막는다", async () => {
    const { letter } = await insertLetter();
    await query(
      "update app_settings set value = 'false'::jsonb where key = 'writing_enabled'",
    );

    const { status } = await read(letter.id);

    expect(status).toBe(200);
  });
});

describe("/m/:id 페이지 (03 흐름 2)", () => {
  async function renderPage(id: string): Promise<string> {
    const element = await LetterPage({ params: Promise.resolve({ id }) });
    return renderToStaticMarkup(element);
  }

  it("킬 스위치가 꺼져 있으면 HTML에 본문이 없다", async () => {
    // 화면에 안 그리는 것과 HTML에 안 담는 것은 다르다. 받아놓고 숨기면 소스 보기로
    // 새어나가므로, 스위치가 꺼져 있으면 read.ts가 애초에 조회하지 않는다.
    const { letter } = await insertLetter({ body: "꺼진_동안_보이면_안_되는_본문" });
    await setPublicRead(false);

    const html = await renderPage(letter.id);

    expect(html).not.toContain("꺼진_동안_보이면_안_되는_본문");
    expect(html).toContain("지금은 편지를 볼 수 없습니다");
  });

  it("켜져 있으면 본문이 HTML에 있다 — 위 단언이 언제나 통과하는 게 아니다", async () => {
    const { letter } = await insertLetter({ body: "꺼진_동안_보이면_안_되는_본문" });

    const html = await renderPage(letter.id);

    expect(html).toContain("꺼진_동안_보이면_안_되는_본문");
  });

  it("잠긴 편지는 잠금 화면만 그린다 — 본문은 HTML에 없다", async () => {
    const { letter } = await insertLocked({ body: "잠금_뒤에_있어야_하는_본문" });

    const html = await renderPage(letter.id);

    expect(html).not.toContain("잠금_뒤에_있어야_하는_본문");
    expect(html).toContain("2019년 봄, 처음 우산 같이 쓴 날");
    expect(html).toContain("그날 우리가 들어간 카페 이름은?");
    expect(html).toContain("남은 시도 3번");
  });

  it("해제 쿠키가 이 편지의 것이면 본문을 그린다", async () => {
    const { letter } = await insertLocked({ body: "잠금_뒤에_있어야_하는_본문" });
    const unlockId = randomLetterId();
    await query(
      "insert into unlocks (unlock_id, letter_id, fp_hash) values ($1, $2, $3)",
      [unlockId, letter.id, randomFpHash()],
    );

    requestScope.unlockCookie = unlockId;
    const html = await renderPage(letter.id);

    expect(html).toContain("잠금_뒤에_있어야_하는_본문");
  });

  it("다른 편지의 해제 쿠키로는 본문을 그리지 않는다", async () => {
    const target = await insertLocked({ body: "잠금_뒤에_있어야_하는_본문" });
    const other = await insertLocked();
    const unlockId = randomLetterId();
    await query(
      "insert into unlocks (unlock_id, letter_id, fp_hash) values ($1, $2, $3)",
      [unlockId, other.letter.id, randomFpHash()],
    );

    requestScope.unlockCookie = unlockId;
    const html = await renderPage(target.letter.id);

    expect(html).not.toContain("잠금_뒤에_있어야_하는_본문");
    expect(html).toContain("남은 시도 3번");
  });
});
