"use client";

// `feed_view { filter }` — 06-analytics §3.
//
// 아무것도 그리지 않는다. `FeedScreen`은 서버 컴포넌트라 이벤트를 보낼 수 없고, 이
// 이벤트는 클라이언트 이벤트다(analytics/events.ts).
//
// **주간 지표 #2(작성 전환율 = `letter_created / feed_view`)의 분모다.** 여기가 비면
// 전환율이 통째로 없다.

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics/client";

/**
 * 필터가 없을 때 보내는 값. **가설값 — 문서에 없다.**
 *
 * 키를 아예 빼면 "필터를 안 썼다"와 "이벤트가 깨졌다"를 나중에 구분할 수 없다. 관계
 * 목록(`ex`·`friend`·…)에 없는 값이라 집계에서 섞이지도 않는다.
 */
const NO_FILTER = "all";

export function FeedViewTracker({ filter }: { filter: string | null }) {
  // LetterViewTracker와 같은 이유의 가드. 필터를 바꾸면 피드를 다시 본 것이므로
  // 그때는 새 건이다 — deps에 filter가 들어가고 ref는 그 시점에 풀린다.
  const sentFor = useRef<string | null>(null);

  useEffect(() => {
    const value = filter ?? NO_FILTER;
    if (sentFor.current === value) return;
    sentFor.current = value;
    track("feed_view", { filter: value });
  }, [filter]);

  return null;
}
