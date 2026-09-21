"use client";

// `letter_view { mode, relationship, source }` — 06-analytics §3.
//
// 아무것도 그리지 않는다. `/m/:id`는 서버 컴포넌트라 이벤트를 보낼 수 없고, 이 이벤트는
// **클라이언트 이벤트다**(analytics/events.ts의 `source: 'client'`). 서버가 이 사건을
// 관측할 수 있는 자리(`GET /api/letters/:id`)가 따로 있지만 **거기서 기록하지 않는다** —
// 페이지 렌더와 API 조회가 둘 다 기록하면 같은 열람이 두 번 세어져 주간 지표 #3의 분모가
// 부풀고, 그러면 링크 유입 비중이 실제보다 낮게 나온다.
//
// **편지 ID를 담지 않는다** (06 §2). 속성만 담는다 — 담는 순간 `session_id ↔ letter_id`
// 연결이 생긴다.

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics/client";
import { takeViewSource } from "./view-source";

export function LetterViewTracker({
  mode,
  relationship,
}: {
  mode: string;
  relationship: string;
}) {
  // 한 번 본 것은 한 건이다. React StrictMode는 개발에서 이펙트를 두 번 돌리는데,
  // 그대로 두면 개발 중에 쌓인 행이 지표를 흐린다. ref는 리마운트에도 살아남는다.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    track("letter_view", { mode, relationship, source: takeViewSource() });
  }, [mode, relationship]);

  return null;
}
