// 공유 문구와 편지 URL — 03 흐름 3 · D-022.
//
// **사용자가 "뭐라고 하면서 보내지"에서 막히면 공유하지 않는다** (03 흐름 3). 그래서
// 문구를 우리가 준다. 문구는 문서에 있는 것 그대로이고 여기서 새로 짓지 않는다.
//
// ── 문구가 상대의 상태를 규정하지 않는다 ────────────────────
//
// 08 M4가 기각한 `최근에 헤어진 친구 있으면 이거 보내`는 받는 쪽을 "위로가 필요한
// 사람"으로 분류한다. 아래 문구는 **제품이 무엇인지도 말하지 않고** 질문 하나만 던진다 —
// 상대가 스스로 확인하러 오는 것이 D-006이 남긴 유일한 발견 경로다.

/** 03 흐름 3의 첫 줄. 글자 그대로다. */
export const SHARE_LEAD = "혹시 너한테 온 거 아니야?";

/**
 * 링크의 도메인은 `NEXT_PUBLIC_SITE_URL`에서 온다 (D-022). **하드코딩하지 않는다** —
 * 도메인을 바꾸면 이미 공유된 링크가 전부 죽는 값이라 출처가 하나여야 한다.
 *
 * 값이 없으면 현재 오리진으로 떨어진다. `done-screen.tsx`의 관리 링크가 이미 같은
 * 폴백을 쓴다 — 링크가 비어 보이는 것보다 낫다.
 */
export function siteOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (typeof window === "undefined" ? "" : window.location.origin)
  );
}

export function letterUrl(letterId: string): string {
  return `${siteOrigin()}/m/${letterId}`;
}

/**
 * 카드 발밑에 적는 도메인. `https://` 없이 호스트만 보여준다.
 *
 * 파싱에 실패하면 빈 문자열이다 — 카드에 `undefined`가 찍히는 것보다 한 줄이 비는 편이
 * 낫다.
 */
export function siteHost(): string {
  try {
    return new URL(siteOrigin()).host;
  } catch {
    return "";
  }
}

/**
 * 03 흐름 3의 두 줄.
 *
 * ```
 * 혹시 너한테 온 거 아니야?
 * postfeel.kr/m/xxxx
 * ```
 *
 * 문서의 둘째 줄은 `postfeel.kr/m/xxxx`지만 여기서는 스킴을 붙인 전체 URL을 넣는다.
 * 같은 문서의 관리 링크도 `postfeel.kr/manage/xxxxxxxx`로 적혀 있고 `done-screen.tsx`가
 * 이미 전체 URL로 렌더한다 — 문서의 표기는 화면 목업의 축약이다. 스킴을 떼면 자동
 * 링크가 안 걸리는 클라이언트에서 링크가 죽고, 그건 유일한 배달 수단을 잃는 것이다.
 */
export function shareText(letterId: string): string {
  return `${SHARE_LEAD}\n${letterUrl(letterId)}`;
}
