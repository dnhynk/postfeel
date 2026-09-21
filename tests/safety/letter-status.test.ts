// 공개 표면 전반 — 상태별 응답 · OG 이미지 · 색인
//
// 안전 회귀 테스트. 구현은 각 표면을 맡은 워커가 채운다.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /m/:id는 서버 컴포넌트라 요청 스코프(next/headers)에서만 돈다. 여기에는 요청이
// 없으므로 빈 쿠키·빈 헤더로 대신한다 — 이 파일이 보는 것은 상태별 응답이지 헤더
// 처리가 아니다. 쿠키가 비어 있다는 것은 "해제하지 않은 사람"이라는 뜻이기도 하다.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

import { GET as feedRoute } from "@/app/api/feed/route";
import { GET as letterRoute } from "@/app/api/letters/[id]/route";
import LetterPage, { metadata } from "@/app/m/[id]/page";
import OgImage, { alt as ogAlt } from "@/app/m/[id]/opengraph-image";
import robots from "@/app/robots";
import { OG_SIZE, OgCard, type CardContent } from "@/components/share/card";
import { FONT_FAMILY, nanumGothic } from "@/components/share/font";
import { loadOgCard } from "@/components/share/load";
import { query } from "@/lib/db";
import {
  insertLetter,
  randomFpHash,
  type LetterStatus,
} from "../fixtures/letters";
import nextConfig from "../../next.config";

/** 05-api §2 「상태별 표면 응답」에서 전 표면 404인 세 상태. */
const HIDDEN_STATUSES: LetterStatus[] = [
  "hidden_auto",
  "hidden_admin",
  "deleted_by_author",
];

/** 라우트와 **같은 조건**으로 카드를 그린다 (opengraph-image.tsx). */
async function renderOgCard(content: CardContent): Promise<ArrayBuffer> {
  const { ImageResponse } = await import("next/og");
  return new ImageResponse(createElement(OgCard, { content }), {
    ...OG_SIZE,
    fonts: [
      {
        name: FONT_FAMILY,
        data: await nanumGothic(),
        weight: 400,
        style: "normal",
      },
    ],
  }).arrayBuffer();
}

/** OG 라우트의 상태 코드. 05-api §2 표의 「OG 이미지」 열. */
async function ogStatus(id: string): Promise<number> {
  const response = await OgImage({ params: Promise.resolve({ id }) });
  return response.status;
}

async function readLetter(id: string): Promise<number> {
  const response = await letterRoute(
    new Request(`http://localhost/api/letters/${id}`),
    { params: Promise.resolve({ id }) },
  );
  return response.status;
}

async function feedIds(): Promise<string[]> {
  const response = await feedRoute(new Request("http://localhost/api/feed"));
  const body = (await response.json()) as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id);
}

/**
 * 페이지가 404로 끝나는가.
 *
 * `notFound()`는 Next가 404 경계에서 잡는 오류를 던진다. 던졌다는 사실과 그것이 404
 * 라는 것 둘 다 본다 — 아무 오류나 던져도 통과하면 이 테스트는 의미가 없다.
 */
async function expectPageNotFound(id: string): Promise<void> {
  let thrown: unknown;
  try {
    await LetterPage({ params: Promise.resolve({ id }) });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  const digest = (thrown as { digest?: string }).digest ?? String(thrown);
  expect(digest).toContain("404");
}

beforeEach(async () => {
  await query("delete from letters");
});

// docs/05-api.md §7 #2 · §6 「OG 이미지」
describe("safety#2 · 잠긴 편지 OG 이미지에 본문이 없다", () => {
  // locked 카드에는 단서 + 🔒 + 관계만 들어간다. 카카오톡·트위터가 미리보기를
  // 캐시하므로 한 번 새면 우리가 지울 수 없다.
  //
  // ── PNG에서 글자를 되읽을 수 없는데 어떻게 재나 ──────────────
  //
  // 세 걸음으로 잰다. satori는 넘겨받은 요소 트리에 없는 글자를 그릴 수 없으므로,
  // "그 트리에 본문이 없다" + "라우트가 그 트리로 그렸다"가 곧 "그림에 본문이 없다"다.
  //
  //   1. 카드가 받는 값에 본문이 없다 (`loadOgCard`)
  //   2. 그 값으로 그린 마크업에 본문이 없다 (`OgCard`)
  //   3. 라우트가 낸 PNG가 그 마크업으로 그린 PNG와 **바이트까지 같다**
  //
  // 3이 1·2와 라우트를 잇는다. 라우트가 다른 값을 그렸다면 바이트가 달라진다.

  const BODY = "이 문장은 잠긴 편지의 본문이고 카드에 나오면 안 된다";
  const HINT = "2019년 봄, 처음 우산 같이 쓴 날";

  /** 04 §2 `locked_fields` — 단서·질문·답 셋이 모두 있어야 삽입된다. */
  async function lockedLetter(): Promise<string> {
    const { letter } = await insertLetter({
      mode: "locked",
      relationship: "friend",
      body: BODY,
      hint: HINT,
      question: "그날 우리가 들어간 카페 이름은?",
      answerHmac: randomFpHash(),
    });
    return letter.id;
  }

  const EXPECTED = {
    mode: "locked",
    relationship: "friend",
    hint: HINT,
  } as const;

  it("카드가 받는 값에 본문이 없다 — 애초에 DB에서 나오지 않는다", async () => {
    const load = await loadOgCard(await lockedLetter(), {
      fpHash: randomFpHash(),
    });

    expect(load).toEqual({ state: "card", content: EXPECTED });
    // 통째로 직렬화해서 본다. 필드 하나가 늘어나 본문이 실려도 걸린다.
    expect(JSON.stringify(load)).not.toContain(BODY);
  });

  it("그 값으로 그린 카드 마크업에 본문이 없다", async () => {
    const load = await loadOgCard(await lockedLetter(), {
      fpHash: randomFpHash(),
    });
    if (load.state !== "card") throw new Error("카드가 아니다.");

    const markup = renderToStaticMarkup(
      createElement(OgCard, { content: load.content }),
    );

    expect(markup).not.toContain(BODY);
    // 단서는 들어간다 — 이미 피드에 공개되는 정보다 (03 흐름 3).
    expect(markup).toContain(HINT);
  });

  it("라우트가 낸 PNG가 그 마크업으로 그린 PNG와 바이트까지 같다", async () => {
    const id = await lockedLetter();

    const [fromRoute, fromCard] = await Promise.all([
      OgImage({ params: Promise.resolve({ id }) }).then((response) =>
        response.arrayBuffer(),
      ),
      renderOgCard(EXPECTED),
    ]);

    expect(Buffer.from(fromRoute).equals(Buffer.from(fromCard))).toBe(true);
  });

  it("해제 쿠키가 있어도 카드는 잠긴 카드다", async () => {
    // OG는 스크레이퍼가 가져가는 공개 이미지라 요청자에 따라 달라지면 안 된다.
    // 쿠키를 실어 나르면 이미 연 사람의 요청에서 본문 카드가 만들어진다.
    const id = await lockedLetter();
    const load = await loadOgCard(id, { fpHash: randomFpHash() });

    expect(load).toEqual({ state: "card", content: EXPECTED });
  });

  it("og:image:alt에도 편지 내용이 없다", () => {
    // alt는 HTML 메타 태그로 그대로 나간다 — 여기에 본문을 넣으면 카드에서 뺀 것이
    // 소스로 샌다. 편지와 무관한 고정 문자열이어야 한다.
    expect(ogAlt).toBe("보내지 못한 말");
  });
});

// docs/05-api.md §7 #9 · §6 「색인」 · docs/02-threat-model.md S-10
describe("safety#9 · /m/:id가 noindex 헤더를 반환한다", () => {
  // HTTP 헤더와 메타 태그 둘 다. robots.txt로 /m/을 Disallow하지는 않는다 —
  // 크롤러가 페이지를 못 읽으면 noindex도 못 읽는다.
  it("X-Robots-Tag: noindex 헤더가 있다", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const forLetterPages = rules.filter((rule) => rule.source.startsWith("/m"));

    expect(forLetterPages).toHaveLength(1);
    expect(forLetterPages[0]?.headers).toContainEqual({
      key: "X-Robots-Tag",
      value: "noindex",
    });
    // 하위 경로까지 덮는다. `/m/:id` 하나만 적으면 나중에 붙을
    // `/m/:id/opengraph-image`가 noindex 밖으로 새고, 그러면 S-10이 뚫린다.
    expect(forLetterPages[0]?.source).toBe("/m/:path*");
  });

  it("페이지에 noindex 메타 태그가 있다", () => {
    // 05-api §6은 "HTTP 헤더 + 메타 태그 둘 다"다. 설정만으로는 절반이다.
    expect(metadata.robots).toEqual({ index: false });
  });

  it("robots.txt가 /m/을 Disallow하지 않는다", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];

    for (const rule of rules) {
      const disallow =
        rule.disallow === undefined
          ? []
          : Array.isArray(rule.disallow)
            ? rule.disallow
            : [rule.disallow];

      // robots.txt는 접두사 매칭이다. 편지 URL에 걸리는 접두사가 하나라도 있으면
      // 크롤러가 페이지를 못 읽고, 그러면 그 안의 noindex도 못 읽는다.
      const blocksLetterPages = disallow.some(
        (path) => path !== "" && "/m/abcdefghij".startsWith(path),
      );
      expect(blocksLetterPages).toBe(false);
    }
  });
});

// docs/05-api.md §7 #10 · §2 「상태별 표면 응답」
describe("safety#10 · hidden_auto·hidden_admin·deleted_by_author 편지가 피드·GET·/m/:id·OG 전부에서 404다", () => {
  // 403이 아니라 404다. 403은 편지의 존재를 확인해준다.
  it("세 상태 각각에서 GET /api/letters/:id가 404다", async () => {
    for (const status of HIDDEN_STATUSES) {
      const { letter } = await insertLetter({ status });
      expect(await readLetter(letter.id)).toBe(404);
    }
  });

  it("세 상태 각각에서 /m/:id와 OG 이미지가 404다", async () => {
    for (const status of HIDDEN_STATUSES) {
      const { letter } = await insertLetter({ status });
      await expectPageNotFound(letter.id);
      // 05-api §2 표의 「OG 이미지」 열. 페이지가 404인데 카드가 계속 생성되면
      // 내려간 편지의 미리보기가 카카오톡에 새로 박히고, 그건 우리가 지울 수 없다.
      expect(await ogStatus(letter.id)).toBe(404);
    }
  });

  it("없는 편지의 OG도 404다 — 내려간 편지와 구분되지 않는다", async () => {
    // 403이면 "그 편지는 있는데 못 본다"가 되어 존재를 확인해준다.
    expect(await ogStatus("존재하지않는아이디")).toBe(404);
  });

  it("세 상태 편지가 피드에 뜨지 않는다", async () => {
    const visible = await insertLetter();
    for (const status of HIDDEN_STATUSES) {
      await insertLetter({ status });
    }

    expect(await feedIds()).toEqual([visible.letter.id]);
  });

  it("published 편지는 같은 경로에서 200이다 — 위 단언이 통째로 죽어 있지 않다는 확인", async () => {
    const { letter } = await insertLetter();

    expect(await readLetter(letter.id)).toBe(200);
    await expect(
      LetterPage({ params: Promise.resolve({ id: letter.id }) }),
    ).resolves.toBeDefined();
    expect(await ogStatus(letter.id)).toBe(200);
  });
});
