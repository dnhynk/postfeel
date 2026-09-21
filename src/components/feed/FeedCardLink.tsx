"use client";

// 피드 카드의 링크 — `feed_card_click`(06 §3)과 `letter_view.source` 표시를 붙이는 자리.
//
// ── 왜 카드 전체가 아니라 링크만 클라이언트인가 ──────────────
// `FeedCard`를 통째로 `"use client"`로 만들면 그 안의 `LetterMeta`가 따라 들어오고,
// `LetterMeta`는 `@/lib/letters/read`의 `RELATIONSHIP_LABELS`를 쓴다. 그 파일은
// `@/lib/db`를 거쳐 `pg`에 닿기 때문에 **`pg`를 브라우저 번들로 끌고 가 빌드가 깨진다.**
// (실제로 깨졌다: `Module not found: 'util/types'` — pg/lib/utils.js.)
//
// 서버 컴포넌트가 만든 `children`을 클라이언트 컴포넌트에 넘기면 그 children은 **서버에서
// 렌더된 채로** 전달된다. 그래서 카드 내용은 서버에 남고, 클릭 핸들러만 클라이언트로 간다.
//
// 06 §2 — props에 편지 ID를 담지 않는다. `href`에는 필요하지만 이벤트에는 담지 않는다.

import Link from "next/link";
import type { ReactNode } from "react";
import { markFeedNavigation } from "@/components/letter/view-source";
import { track } from "@/lib/analytics/client";

export function FeedCardLink({
  letterId,
  mode,
  relationship,
  children,
}: {
  letterId: string;
  mode: string;
  relationship: string;
  children: ReactNode;
}) {
  function open(): void {
    track("feed_card_click", { mode, relationship });
    // 다음 `letter_view`의 `source`를 `feed`로 만든다 (view-source.ts).
    markFeedNavigation();
  }

  return (
    <Link href={`/m/${letterId}`} className="block" onClick={open}>
      {children}
    </Link>
  );
}
