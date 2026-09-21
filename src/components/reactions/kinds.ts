// 고정형 반응의 종류와 라벨 (04 §2 `reactions` · 05-api §2 「나머지」).
//
// **kind 목록은 04 §2의 컬럼 주석이 진실이다** — `'same'|'wish_well'|'unspoken'|'letting_go'`.
// 늘리려면 문서를 먼저 고친다.
//
// ── 이 파일이 왜 components 밑에 있나 ────────────────────────
// 라우트(`POST /api/letters/:id/react`)와 화면이 **같은 목록**을 봐야 한다. 두 벌이 되면
// 화면에 있는 버튼이 서버에서 400을 받는 날이 온다. DB도 React도 참조하지 않는 순수
// 상수라 양쪽에서 안전하게 import 된다.
//
// ── 한국어 라벨은 문서에 없다. 여기서 정했다 (D-007) ─────────
// D-007은 **존재하지 않는 신호를 만들지 말라**고 못박았다. 그래서 라벨을 이렇게 골랐다:
//
//   1. **읽는 사람이 자기 얘기를 한다.** 세 개가 "나도"로 시작하거나 자기 상태를 말한다.
//      작성자에게 무엇을 하라고 시키지 않는다 — `letting_go`를 "이제 놓아주세요"로 쓰면
//      편지를 쓴 사람에게 훈수가 되고, 그건 우리가 만든 적 없는 판단을 신호로 파는 것이다
//   2. **압박 문구를 넣지 않는다.** "N명이 공감했어요" 류는 개수에 의미를 덧씌우는
//      문구라 쓰지 않는다. 화면에 나가는 것은 라벨과 **실제 개수**뿐이다
//   3. **자유 댓글이 아니다** (01 「제외」). 텍스트 입력은 없다. 네 개 중 하나를 누르는 것뿐
//
// 문구는 **가설값이다** — 03 흐름 문서에 반응 문구가 없어 실측 후 조정한다.

export const REACTION_KINDS = [
  "same",
  "wish_well",
  "unspoken",
  "letting_go",
] as const;

export type ReactionKind = (typeof REACTION_KINDS)[number];

export const REACTION_LABELS: Record<ReactionKind, string> = {
  same: "나도 그랬어요",
  wish_well: "잘 지내길 바라요",
  unspoken: "나도 못 한 말이 있어요",
  letting_go: "놓아주는 중이에요",
};

/**
 * 편지 하나의 반응 개수. 키는 `ReactionKind`이지만 **타입은 `Record<string, number>`다**
 * — 05-api §2의 `FeedItem.reactions`가 그 형태이고, DB에서 올라온 값이라 목록 밖의 kind가
 * 섞여 있을 수 있다(과거 행 · 문서 변경 중). 화면은 아는 kind만 그린다.
 */
export type ReactionCounts = Record<string, number>;

export function isReactionKind(value: unknown): value is ReactionKind {
  return (
    typeof value === "string" &&
    (REACTION_KINDS as readonly string[]).includes(value)
  );
}
