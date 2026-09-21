// `letter_view { source: 'feed' | 'link' }`의 출처 판정 — 06-analytics §3.
//
// **이 값이 주간 지표 #3(링크 유입 비중)의 전부다.** D-006에 따라 공유 링크가 유일한
// 배달 수단이라, `link` 비중이 곧 "유통이 실제로 도는가"의 답이다 (06 §3 · §6).
//
// ── 왜 신호가 둘인가 ─────────────────────────────────────────
// 1. **피드 카드 클릭 표시** (`markFeedNavigation`). 피드에서 편지로 가는 길은
//    `FeedCard`의 링크 하나뿐이라, 그 클릭을 표시해 두면 소프트 내비게이션(`next/link`)
//    으로 넘어가도 출처가 남는다. `document.referrer`는 소프트 내비게이션에서 **갱신되지
//    않으므로** 이것이 없으면 피드 클릭이 전부 `link`로 잡힌다
// 2. **`document.referrer` 폴백.** 카드를 새 탭으로 열면(가운데 클릭) sessionStorage가
//    탭마다 따로라 표시가 따라가지 않는다. 그때는 실제 문서 로드라 referrer가 있다
//
// 둘 다 아니면 `link`다. **기본값을 `link`로 두는 것이 위험한 쪽**이라는 것을 안다 —
// 판정에 실패하면 유통이 실제보다 잘 도는 것처럼 보인다. 그래서 피드에서 오는 경로를
// 두 신호로 덮었다. 스크립트가 아예 죽은 브라우저에서는 이벤트 자체가 나가지 않는다.

const FEED_NAV_KEY = "pf_feed_nav";

export type ViewSource = "feed" | "link";

/** 피드 카드를 눌렀다는 표시. 다음 `letter_view` 한 건만 소비한다. */
export function markFeedNavigation(): void {
  try {
    sessionStorage.setItem(FEED_NAV_KEY, "1");
  } catch {
    // 프라이빗 모드·저장소 차단. 판정이 referrer 쪽으로 떨어질 뿐이다.
  }
}

/**
 * 표시를 **읽고 지운다.** 남겨두면 그 뒤에 링크로 들어온 편지까지 `feed`가 된다 —
 * 한 번의 클릭이 여러 건의 출처를 거짓으로 만든다.
 */
export function takeViewSource(): ViewSource {
  try {
    if (sessionStorage.getItem(FEED_NAV_KEY) !== null) {
      sessionStorage.removeItem(FEED_NAV_KEY);
      return "feed";
    }
  } catch {
    // 위와 같다.
  }
  return referrerIsFeed() ? "feed" : "link";
}

/** 같은 오리진의 `/`(= 피드. 랜딩이 곧 피드다 — 03 흐름 0)에서 왔는가. */
function referrerIsFeed(): boolean {
  const referrer = document.referrer;
  if (!referrer) return false;
  try {
    const url = new URL(referrer);
    return url.origin === location.origin && url.pathname === "/";
  } catch {
    return false;
  }
}
