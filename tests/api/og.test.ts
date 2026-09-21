// GET /m/:id/opengraph-image — 05-api §6 「OG 이미지」 · 03 흐름 3.
//
// 상태별 404와 "잠긴 카드에 본문이 없다"는 안전 회귀 테스트(#2 · #10)가 고정한다. 여기는
// 그 밖의 것 — 실제로 PNG가 나오는가, 킬 스위치가 막는가, 한국어가 렌더되는가다.
//
// ── 한국어가 네모로 뜨는지를 어떻게 테스트로 잡나 ────────────
//
// PNG에서 글자를 되읽을 수는 없다. 대신 **원인**을 잡는다: 네모는 폰트에 글리프가 없을
// 때 뜨므로, 우리가 싣는 폰트의 cmap이 한글 음절을 덮는지 직접 확인한다. 폰트가 바뀌거나
// 부분 커버리지 폰트로 갈아끼워지는 날 이 테스트가 먼저 깨진다.
// 눈으로 본 근거는 아래 `OG_DUMP_DIR`로 남긴다.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 라우트는 서버 컴포넌트라 요청 스코프에서만 돈다. 여기에는 요청이 없으므로 빈 헤더로
// 대신한다 — fingerprint()는 헤더가 없으면 0.0.0.0으로 떨어진다 (05-api §5).
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import OgImage from "@/app/m/[id]/opengraph-image";
import { OgCard, cardContent, excerpt } from "@/components/share/card";
import { nanumGothic } from "@/components/share/font";
import { loadOgCard } from "@/components/share/load";
import { SHARE_LEAD, letterUrl, shareText, siteHost } from "@/components/share/text";
import { query } from "@/lib/db";
import { PREVIEW_LENGTH } from "@/lib/letters/read";
import { insertLetter, randomFpHash, sha256 } from "../fixtures/letters";

/** 잠긴 편지 픽스처의 필수 3종 (04 §2 `locked_fields`). */
const LOCKED = {
  mode: "locked" as const,
  hint: "2019년 봄, 처음 우산 같이 쓴 날",
  question: "그날 우리가 들어간 카페 이름은?",
  answerHmac: sha256("정답"),
};

async function og(id: string): Promise<Response> {
  return OgImage({ params: Promise.resolve({ id }) });
}

/** PNG 시그니처. 바이트가 실제로 이미지인지 본다. */
function isPng(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

/**
 * `OG_DUMP_DIR`가 있으면 렌더된 카드를 파일로 남긴다.
 *
 * **리포에 넣지 않는다.** 눈으로 확인하기 위한 것이고, 확인 사실은 PR 본문에 적는다
 * (한국어가 네모로 뜨면 카드가 아니라 사고다).
 */
async function dump(name: string, response: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const dir = process.env.OG_DUMP_DIR;
  if (dir) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, name), bytes);
  }
  return bytes;
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
});

describe("OG 카드 렌더", () => {
  it("open 편지는 PNG를 돌려준다", async () => {
    const { letter } = await insertLetter({
      body: "그때 네가 먼저 미안하다고 했는데, 나는 자존심 때문에 아무 말도 못 했어.",
      relationship: "ex",
    });

    const response = await og(letter.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const bytes = await dump("og-open.png", response);
    expect(isPng(bytes)).toBe(true);
    // 빈 캔버스가 아니다. 글자가 하나도 안 그려지면 이보다 훨씬 작다.
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  it("locked 편지도 PNG를 돌려준다", async () => {
    const { letter } = await insertLetter({ ...LOCKED, relationship: "friend" });

    const response = await og(letter.id);
    expect(response.status).toBe(200);

    const bytes = await dump("og-locked.png", response);
    expect(isPng(bytes)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  it("한국어가 렌더된 카드가 라틴만 있는 카드보다 무겁다", async () => {
    // 글리프가 없으면 satori는 그 문자를 아예 그리지 않는다 — 그러면 한국어 카드가
    // 빈 카드와 같아진다. 두 카드의 크기 차이가 "한글이 실제로 그려졌다"의 대리 증거다.
    const korean = await insertLetter({ body: "한국어가 보여야 한다" });
    const blank = await insertLetter({ body: " " });

    const [withKorean, withoutText] = await Promise.all([
      og(korean.letter.id).then((r) => r.arrayBuffer()),
      og(blank.letter.id).then((r) => r.arrayBuffer()),
    ]);

    expect(withKorean.byteLength).toBeGreaterThan(withoutText.byteLength);
  });
});

describe("싣는 폰트가 한글을 덮는다", () => {
  it("Nanum Gothic의 cmap이 한글 음절 11,172자를 전부 담는다", async () => {
    const font = await nanumGothic();
    const covered = cmapCoverage(font);

    // 표본이 아니라 전 범위를 센다. 부분 커버리지 폰트(완성형 2,350자)로 갈아끼우면
    // 「뷁」 같은 음절이 사용자 글에서 네모가 되는데, 표본 검사로는 안 잡힌다.
    let missing = 0;
    for (let code = 0xac00; code <= 0xd7a3; code += 1) {
      if (!covered.has(code)) missing += 1;
    }
    expect(missing).toBe(0);

    // 카드에 함께 뜨는 나머지 — ASCII와 말줄임표.
    for (const code of [0x20, 0x2e, 0x41, 0x7a, 0x30, 0x39, 0x2026]) {
      expect(covered.has(code)).toBe(true);
    }
  });

  it("리포의 폰트 파일이 원본 그대로다", async () => {
    // Reserved Font Name("Nanum") — 고친 파일을 같은 이름으로 배포할 수 없다(OFL 1.1).
    // 출처: github.com/google/fonts/ofl/nanumgothic/NanumGothic-Regular.ttf
    const file = await readFile(
      path.join(process.cwd(), "src/components/share/NanumGothic-Regular.ttf"),
    );
    expect(file.byteLength).toBe(2_054_744);

    // OFL은 배포 시 라이선스 동봉을 요구한다.
    const license = await readFile(
      path.join(process.cwd(), "src/components/share/OFL.txt"),
      "utf8",
    );
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});

describe("킬 스위치 · 본문 조각", () => {
  it("public_read_enabled = false면 503이고 그림을 만들지 않는다", async () => {
    const { letter } = await insertLetter();
    await setPublicRead(false);

    const response = await og(letter.id);
    expect(response.status).toBe(503);
    expect(await loadOgCard(letter.id, { fpHash: randomFpHash() })).toEqual({
      state: "disabled",
    });
  });

  it("본문이 길면 앞부분만 자르고 말줄임표를 붙인다", () => {
    const long = "가".repeat(PREVIEW_LENGTH + 50);
    const cut = excerpt(long);

    expect(Array.from(cut)).toHaveLength(PREVIEW_LENGTH + 1);
    expect(cut.endsWith("…")).toBe(true);
    // 05-api §2의 한계 — 카드에 본문 전체가 들어가면 안 된다.
    expect(cut).not.toBe(long);
  });

  it("open 카드 마크업에 본문 조각과 관계가 있다", () => {
    const content = cardContent({
      id: "x",
      mode: "open",
      relationship: "ex",
      createdAt: "2026-08-15T00:00:00.000000Z",
      body: "그때 네가 먼저 미안하다고 했는데",
      reactions: {},
    });
    const markup = renderToStaticMarkup(createElement(OgCard, { content }));

    expect(markup).toContain("그때 네가 먼저 미안하다고 했는데");
    expect(markup).toContain("옛 연인에게");
  });
});

describe("도메인은 NEXT_PUBLIC_SITE_URL에서 온다 (D-022)", () => {
  it("링크와 문구가 환경변수의 오리진을 쓴다", () => {
    // 도메인을 바꾸면 이미 공유된 링크가 전부 죽는다 — 출처가 하나여야 한다.
    const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "";
    expect(origin).not.toBe("");

    expect(letterUrl("abc")).toBe(`${origin}/m/abc`);
    expect(shareText("abc")).toBe(`${SHARE_LEAD}\n${origin}/m/abc`);
    expect(siteHost()).toBe(new URL(origin).host);
  });

  it("공유·OG 소스에 도메인이 하드코딩돼 있지 않다", async () => {
    const dir = path.join(process.cwd(), "src/components/share");
    const files = [
      path.join(process.cwd(), "src/app/m/[id]/opengraph-image.tsx"),
      ...["card.tsx", "font.ts", "load.ts", "text.ts", "SharePanel.tsx"].map(
        (name) => path.join(dir, name),
      ),
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      // 주석의 언급까지 막을 필요는 없다. 코드에 리터럴로 박히는 것만 본다.
      const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(code).not.toContain("postfeel.kr");
    }
  });
});

describe("공유 문구 (03 흐름 3)", () => {
  it("문서의 두 줄 그대로다", () => {
    expect(SHARE_LEAD).toBe("혹시 너한테 온 거 아니야?");
    expect(shareText("xxxx").split("\n")).toHaveLength(2);
  });

  it("08 M4가 기각한 문구를 쓰지 않는다", () => {
    // 상대를 "위로가 필요한 사람"으로 분류하는 말이라 받는 쪽이 불쾌해진다.
    expect(shareText("xxxx")).not.toContain("헤어진");
    expect(shareText("xxxx")).not.toContain("위로");
  });
});

// ── TTF cmap ────────────────────────────────────────────────
//
// 폰트 파서를 의존성으로 들이지 않는다. 필요한 것은 "이 코드포인트에 글리프가 있는가"
// 하나뿐이고, cmap의 format 4·12 두 형식만 읽으면 답이 나온다.

function cmapCoverage(font: Buffer): Set<number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tableCount = view.getUint16(4);

  let cmapOffset = -1;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    const tag = font.toString("latin1", record, record + 4);
    if (tag === "cmap") cmapOffset = view.getUint32(record + 8);
  }
  if (cmapOffset < 0) throw new Error("cmap 테이블이 없다.");

  const codes = new Set<number>();
  const subtableCount = view.getUint16(cmapOffset + 2);
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmapOffset + 4 + index * 8;
    const subtable = cmapOffset + view.getUint32(record + 4);
    const format = view.getUint16(subtable);
    if (format === 4) readFormat4(view, subtable, codes);
    else if (format === 12) readFormat12(view, subtable, codes);
  }
  return codes;
}

function readFormat4(view: DataView, at: number, into: Set<number>): void {
  const segments = view.getUint16(at + 6) / 2;
  const endAt = at + 14;
  const startAt = endAt + segments * 2 + 2;
  const deltaAt = startAt + segments * 2;
  const rangeAt = deltaAt + segments * 2;

  for (let segment = 0; segment < segments; segment += 1) {
    const end = view.getUint16(endAt + segment * 2);
    const start = view.getUint16(startAt + segment * 2);
    if (start > end || start === 0xffff) continue;
    const delta = view.getUint16(deltaAt + segment * 2);
    const rangeOffset = view.getUint16(rangeAt + segment * 2);

    for (let code = start; code <= end; code += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const glyphAt =
          rangeAt + segment * 2 + rangeOffset + (code - start) * 2;
        glyph = view.getUint16(glyphAt);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) into.add(code);
    }
  }
}

function readFormat12(view: DataView, at: number, into: Set<number>): void {
  const groups = view.getUint32(at + 12);
  for (let index = 0; index < groups; index += 1) {
    const group = at + 16 + index * 12;
    const start = view.getUint32(group);
    const end = view.getUint32(group + 4);
    const glyph = view.getUint32(group + 8);
    if (glyph === 0) continue;
    for (let code = start; code <= end; code += 1) into.add(code);
  }
}
