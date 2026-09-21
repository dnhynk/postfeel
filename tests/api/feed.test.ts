// GET /api/feed — 05-api §2
//
// 라우트 핸들러를 직접 부른다. Route Handler는 표준 `Request`를 받고 `Response`를
// 돌려주므로 서버를 띄우지 않아도 응답 전체를 그대로 볼 수 있다.

import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/feed/route";
import { query } from "@/lib/db";
import {
  insertLetter,
  randomFpHash,
  type LetterOverrides,
} from "../fixtures/letters";

interface FeedBody {
  items: Array<{
    id: string;
    mode: string;
    relationship: string;
    createdAt: string;
    preview: string;
    reactions: Record<string, number>;
  }>;
  nextCursor: string | null;
  disabled?: true;
}

async function feed(
  search = "",
): Promise<{ status: number; body: FeedBody; text: string }> {
  const response = await GET(new Request(`http://localhost/api/feed${search}`));
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as FeedBody, text };
}

function insertLocked(overrides: LetterOverrides = {}) {
  return insertLetter({
    mode: "locked",
    hint: "2019년 봄, 처음 우산 같이 쓴 날",
    question: "그날 우리가 들어간 카페 이름은?",
    // 이 표면은 답을 보지 않는다. locked_fields 제약을 만족시키는 값이면 된다.
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
  // 파일 하나가 DB 하나를 쓰지만(tests/setup/db.ts) 테스트끼리는 개수를 세므로 비운다.
  await query("delete from letters");
  await setPublicRead(true);
});

describe("무엇이 뜨는가 — status='published' and risk_level='low' (04 §3)", () => {
  it("published·low만 뜬다", async () => {
    const visible = await insertLetter({ body: "보이는 편지" });
    await insertLetter({ riskLevel: "medium", body: "등급 중간" });
    await insertLetter({ status: "hidden_auto", body: "자동 비공개" });
    await insertLetter({ status: "hidden_admin", body: "운영자 비공개" });
    await insertLetter({ status: "deleted_by_author", body: "작성자 삭제" });

    const { body } = await feed();

    expect(body.items.map((item) => item.id)).toEqual([visible.letter.id]);
  });

  it("등급 medium은 피드에만 없다 — 링크 접근은 별개다 (02 §2)", async () => {
    await insertLetter({ riskLevel: "medium" });
    const { body } = await feed();
    expect(body.items).toHaveLength(0);
  });
});

describe("정렬과 혼합 (03 흐름 0)", () => {
  it("잠긴 편지와 열린 편지가 한 목록에 최신순으로 섞인다", async () => {
    const oldest = await insertLetter({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const middle = await insertLocked({
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const newest = await insertLetter({
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    const { body } = await feed();

    expect(body.items.map((item) => item.id)).toEqual([
      newest.letter.id,
      middle.letter.id,
      oldest.letter.id,
    ]);
    expect(body.items.map((item) => item.mode)).toEqual([
      "open",
      "locked",
      "open",
    ]);
  });
});

describe("필터 — 관계 유형만 (03 흐름 0)", () => {
  it("relationship이 주어지면 그 관계만 나온다", async () => {
    const friend = await insertLetter({ relationship: "friend" });
    await insertLetter({ relationship: "ex" });

    const { body } = await feed("?relationship=friend");

    expect(body.items.map((item) => item.id)).toEqual([friend.letter.id]);
  });

  it("목록 밖의 관계 유형은 400이다", async () => {
    const { status } = await feed("?relationship=stranger");
    expect(status).toBe(400);
  });
});

describe("preview (05-api §2)", () => {
  it("open은 본문 앞부분이고, 길면 말줄임표가 붙는다", async () => {
    const body = "가".repeat(150);
    await insertLetter({ body });

    const { body: feedBody } = await feed();

    expect(feedBody.items[0]?.preview).toBe(`${"가".repeat(100)}…`);
  });

  it("짧은 본문은 그대로 나온다", async () => {
    await insertLetter({ body: "짧은 편지." });
    const { body } = await feed();
    expect(body.items[0]?.preview).toBe("짧은 편지.");
  });

  it("locked는 단서다 — 본문은 응답 어디에도 없다", async () => {
    await insertLocked({ body: "절대로_피드에_나오면_안_되는_본문" });

    const { body, text } = await feed();

    expect(body.items[0]?.preview).toBe("2019년 봄, 처음 우산 같이 쓴 날");
    expect(text).not.toContain("절대로_피드에_나오면_안_되는_본문");
    expect(body.items[0]).not.toHaveProperty("body");
  });
});

describe("반응 (04 §2 reactions)", () => {
  it("종류별로 센다. 없으면 빈 객체다", async () => {
    const withReactions = await insertLetter({
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await insertLetter({ createdAt: new Date("2026-01-01T00:00:00.000Z") });

    for (const kind of ["same", "same", "wish_well"]) {
      await query(
        "insert into reactions (letter_id, kind, fp_hash) values ($1, $2, $3)",
        [withReactions.letter.id, kind, randomFpHash()],
      );
    }

    const { body } = await feed();

    expect(body.items[0]?.reactions).toEqual({ same: 2, wish_well: 1 });
    expect(body.items[1]?.reactions).toEqual({});
  });
});

describe("커서 페이지네이션 (05-api §2)", () => {
  it("마지막 페이지의 nextCursor는 null이다", async () => {
    await insertLetter();
    const { body } = await feed();
    expect(body.nextCursor).toBeNull();
  });

  it("같은 created_at을 가진 편지들에서도 누락·중복이 없다", async () => {
    // 커서가 `(created_at, id)`인 이유가 이것이다. `created_at` 단독 커서였다면
    // 여기서 한 통이 누락되거나 중복된다 (05-api §2).
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const inserted: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      inserted.push((await insertLetter({ createdAt })).letter.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const search = `?limit=2${
        cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const { body } = await feed(search);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...inserted].sort());

    // 순서까지 같아야 한다. 기대값을 JS로 정렬해 만들지 않는 이유: `id desc`는 DB
    // 콜레이션을 따르고(로케일 콜레이션은 대소문자를 뒤 순위로 본다) JS의 기본 정렬은
    // UTF-16 코드 단위다. 둘은 다르고, 여기서 확인할 것은 "어떤 순서인가"가 아니라
    // **끊어 읽은 순서가 한 번에 읽은 순서와 같은가**다. 정렬과 커서가 같은 규칙을
    // 쓰지 않으면 바로 여기서 갈라진다.
    const single = await feed("?limit=50");
    expect(seen).toEqual(single.body.items.map((item) => item.id));
  });

  it("밀리초 미만으로 갈라지는 편지도 정확히 이어진다", async () => {
    // JS Date는 밀리초까지다. 커서가 Date를 거치면 아래 두 통이 같은 값으로 접혀
    // 누락·중복이 돌아온다. 그래서 커서는 DB가 만든 마이크로초 문자열을 그대로 나른다.
    const { rows } = await query<{ id: string }>(
      `insert into letters (id, mode, relationship, body, risk_level, status,
                            manage_token_hash, author_fp_hash, created_at)
       values ('aaaaaaaaaaaaaaaaaaaaaa', 'open', 'friend', '먼저', 'low', 'published',
               $1, $2, '2026-01-01T00:00:00.000100Z'),
              ('bbbbbbbbbbbbbbbbbbbbbb', 'open', 'friend', '나중', 'low', 'published',
               $3, $4, '2026-01-01T00:00:00.000200Z')
       returning id`,
      [randomFpHash(), randomFpHash(), randomFpHash(), randomFpHash()],
    );
    expect(rows).toHaveLength(2);

    const firstPage = await feed("?limit=1");
    expect(firstPage.body.items.map((item) => item.id)).toEqual([
      "bbbbbbbbbbbbbbbbbbbbbb",
    ]);

    const secondPage = await feed(
      `?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor ?? "")}`,
    );
    expect(secondPage.body.items.map((item) => item.id)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaa",
    ]);
  });

  it("필터가 걸린 채로도 이어진다", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const friends: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      friends.push(
        (await insertLetter({ relationship: "friend", createdAt })).letter.id,
      );
    }
    await insertLetter({ relationship: "ex", createdAt });

    const firstPage = await feed("?relationship=friend&limit=2");
    expect(firstPage.body.items).toHaveLength(2);

    const secondPage = await feed(
      `?relationship=friend&limit=2&cursor=${encodeURIComponent(
        firstPage.body.nextCursor ?? "",
      )}`,
    );

    const seen = [
      ...firstPage.body.items.map((item) => item.id),
      ...secondPage.body.items.map((item) => item.id),
    ];
    expect([...seen].sort()).toEqual([...friends].sort());
  });

  it("형식이 어긋난 커서는 400이다 — 500이 아니다", async () => {
    for (const cursor of ["없는커서", "2026-01-01T00:00:00.000000Z", "_abc"]) {
      const { status } = await feed(`?cursor=${encodeURIComponent(cursor)}`);
      expect(status).toBe(400);
    }
  });
});

describe("limit", () => {
  it("범위 밖이면 400이다", async () => {
    expect((await feed("?limit=0")).status).toBe(400);
    expect((await feed("?limit=51")).status).toBe(400);
    expect((await feed("?limit=abc")).status).toBe(400);
  });

  it("주지 않으면 20건까지 준다", async () => {
    for (let index = 0; index < 21; index += 1) await insertLetter();
    const { body } = await feed();
    expect(body.items).toHaveLength(20);
    expect(body.nextCursor).not.toBeNull();
  });
});

describe("킬 스위치 (05-api §6)", () => {
  it("public_read_enabled=false면 빈 배열 + disabled:true다", async () => {
    await insertLetter({ body: "꺼진_동안_보이면_안_되는_본문" });
    await setPublicRead(false);

    const { status, body, text } = await feed();

    expect(status).toBe(200);
    expect(body).toEqual({ items: [], nextCursor: null, disabled: true });
    expect(text).not.toContain("꺼진_동안_보이면_안_되는_본문");
  });

  it("켜져 있으면 disabled 키가 아예 없다", async () => {
    await insertLetter();
    const { body } = await feed();
    expect(body).not.toHaveProperty("disabled");
  });
});
