// OG 카드가 그리는 것 — 03 흐름 3 · 05-api §6 「OG 이미지」.
//
// | 모드 | 카드에 담기는 것 |
// |---|---|
// | `open`   | 본문 일부 + 관계 유형 |
// | `locked` | **단서만** + 🔒 + 관계 유형 |
//
// ── 잠긴 카드에 본문이 들어갈 수 없는 이유는 여기가 아니라 read.ts에 있다 ──
//
// `cardContent`가 받는 `LetterResponse`는 잠긴 편지일 때 **`body` 키 자체가 없다** —
// read.ts가 애초에 select 하지 않는다(05-api §7 #1). 그래서 이 파일은 "본문을 빼는"
// 코드가 아니라 애초에 뺄 값이 없는 코드다. 안전 테스트 #2가 이걸 고정한다.
// B 모드 카드에 단서를 넣는 것은 안전하다 — 단서는 이미 피드에 공개되는 정보다.
//
// ── 왜 본문 전체를 넣지 않는가 ──────────────────────────────
//
// 05-api §2의 한계 문단: 카카오톡·트위터는 OG 미리보기를 **캐시**한다. 편지를 내려도
// 이미 공유된 곳의 미리보기는 남고 **우리가 지울 수 없다.** 본문 전체를 넣지 않는 것이
// 유일한 방어다.
//
// ── satori 제약 ────────────────────────────────────────────
//
// `next/og`는 Tailwind 클래스가 아니라 인라인 스타일로 그린다. 자식이 둘 이상인 요소에는
// `display: flex`가 반드시 있어야 한다(satori가 요구한다). globals.css는 여기까지 오지
// 않으므로 색·간격을 직접 적는다 — README 「스타일」이 금지한 것은 그 파일을 고치는
// 것이지 이 표면이 자기 값을 갖는 것이 아니다.

import { PREVIEW_LENGTH, RELATIONSHIP_LABELS } from "@/lib/letters/read";
import type { LetterResponse, Relationship } from "@/lib/letters/read";
import { isUnlocked } from "@/lib/letters/read";
import { FONT_FAMILY } from "./font";
import { siteHost } from "./text";

/** 05-api §6 · OG 표준 크기. */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/**
 * 카드에 실제로 들어가는 값. **`open`에만 본문 조각이 있다.**
 *
 * 두 갈래를 한 타입으로 합치지 않는다 — `text` 하나로 두면 어느 갈래가 본문인지
 * 타입에서 사라지고, 그때부터 잠긴 카드에 본문을 넣는 실수가 타입 검사를 통과한다.
 */
export type CardContent =
  | { mode: "open"; relationship: string; excerpt: string }
  | { mode: "locked"; relationship: string; hint: string };

/**
 * 본문 앞부분을 자른다. 길이는 피드 카드와 같은 `PREVIEW_LENGTH`다 (read.ts).
 *
 * **여기에 새 가설값을 만들지 않는다.** 05-api §6이 정한 것은 "본문 일부"까지이고,
 * 숫자는 이미 read.ts에 하나 있다. 두 개를 두면 피드와 카드가 다른 양을 보여주는데
 * 그 차이를 정당화할 근거가 지금 없다.
 *
 * 코드 포인트로 자른다 — read.ts의 `preview()`와 같은 이유로, 이모지가 섞여도 문자가
 * 반토막 나지 않는다.
 *
 * **남는 위험**: 본문이 `PREVIEW_LENGTH`보다 짧으면 카드에 편지 전체가 들어간다.
 * 피드 카드도 같은 양을 보여주지만 피드는 편지를 내리면 함께 사라지고 **카드는 남는다.**
 * 05-api §2가 "본문 전체를 넣지 않는 것이 유일한 방어"라고 쓴 대상은 500자 본문이라
 * 이 경우까지 정하고 있지 않다 — 실측 전에 새 숫자를 지어내지 않고 한계로 남긴다.
 */
export function excerpt(body: string): string {
  const characters = Array.from(body);
  return characters.length > PREVIEW_LENGTH
    ? `${characters.slice(0, PREVIEW_LENGTH).join("")}…`
    : body;
}

/**
 * 편지 한 통을 카드 내용으로 바꾼다.
 *
 * 갈림은 `isUnlocked`(= `body` 키의 존재)로 한다 — `mode` 문자열로 가르면 read.ts가
 * 본문을 안 준 편지에 `mode === 'open'`이 찍히는 날 본문 자리가 `undefined`가 된다.
 */
export function cardContent(letter: LetterResponse): CardContent {
  if (isUnlocked(letter)) {
    return {
      mode: "open",
      relationship: letter.relationship,
      excerpt: excerpt(letter.body),
    };
  }
  return {
    mode: "locked",
    relationship: letter.relationship,
    hint: letter.hint,
  };
}

/** LetterMeta와 같은 규칙 — 목록 밖 값은 그대로 쓴다. */
function label(relationship: string): string {
  return RELATIONSHIP_LABELS[relationship as Relationship] ?? relationship;
}

/**
 * 🔒 를 문자가 아니라 도형으로 그린다.
 *
 * 이모지 글리프는 `next/og`가 CDN에서 따로 받아오는 값이라(`emoji` 옵션), 문자를 그대로
 * 쓰면 카드가 외부 CDN에 매 요청 의존한다. 자물쇠 하나 때문에 그 의존을 만들지 않는다.
 * 03 흐름 3이 요구하는 것은 "잠겨 있다"는 표시이지 특정 이모지가 아니다.
 */
function LockMark() {
  // 고리는 원 위에 몸통을 덮어 만든다. satori의 SVG는 호(`a`) 명령을 온전히 그리지
  // 못해서 path로 그리면 고리 한쪽만 나온다 — 실제 렌더로 확인했다.
  return (
    <svg width="52" height="52" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="9"
        r="4.75"
        fill="none"
        stroke="#525252"
        strokeWidth="2.5"
      />
      <rect x="3.5" y="11" width="17" height="11.5" rx="2" fill="#525252" />
    </svg>
  );
}

export function OgCard({ content }: { content: CardContent }) {
  const host = siteHost();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: 72,
        backgroundColor: "#fafafa",
        fontFamily: FONT_FAMILY,
        color: "#171717",
      }}
    >
      {/* 피드 화면의 제목과 같은 이름을 쓴다. 카드를 처음 보는 사람에게 이 서비스가
          무엇인지 말하는 유일한 자리다 — 받는 사람이 어떤 상태인지는 말하지 않는다
          (08 M4가 기각한 문구의 함정). */}
      <div style={{ display: "flex", fontSize: 30, color: "#737373" }}>
        보내지 못한 말
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {content.mode === "locked" && (
          <div style={{ display: "flex", marginBottom: 20 }}>
            <LockMark />
          </div>
        )}
        <div
          style={{
            display: "flex",
            fontSize: 48,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
          }}
        >
          {content.mode === "open" ? content.excerpt : content.hint}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 28,
          color: "#737373",
        }}
      >
        <div style={{ display: "flex" }}>{host}</div>
        <div style={{ display: "flex" }}>{label(content.relationship)}에게</div>
      </div>
    </div>
  );
}
