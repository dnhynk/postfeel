"use client";

// 로컬 초안 자동 저장 (03 §1-2).
//
// "감정 상태에서 쓴 글을 네트워크 오류로 날리면 그 사용자는 돌아오지 않는다."
// 차단(`high`) 화면에서 본문이 살아 있는 곳도 여기다 — 차단된 편지의 본문은 서버로
// 가지 않으므로(03 실패 상태 표 · 04 「저장하지 않는 것」) 로컬 초안이 유일한 보존
// 장소다.
//
// **답(`answer`)은 저장하지 않는다.** 화면이 답 옆에 "(저장되지 않습니다)"라고
// 약속하는데(03 §1-4) 브라우저에 남겨두면 그 약속이 반만 참이 된다. 다시 쓰는 비용이
// 40자라 손해도 작다.
//
// ── 왜 useEffect가 아니라 useSyncExternalStore인가 ──────────
// localStorage는 React 밖의 저장소다. 마운트 후 effect에서 읽어 setState 하면
// (1) 렌더가 한 번 더 도는 것을 lint가 막고(react-hooks/set-state-in-effect),
// (2) 서버 HTML은 빈 폼인데 첫 클라이언트 렌더가 복원된 폼이면 하이드레이션이
// 어긋난다. useSyncExternalStore는 서버 스냅샷을 따로 받아 이 둘을 동시에 없앤다 —
// 서버에서는 null, 하이드레이션 직후 클라이언트 값으로 다시 렌더한다.

import { useMemo, useSyncExternalStore } from "react";
import type { LetterMode, Relationship } from "@/lib/safety/types";

const KEY = "postfeel.write.draft.v1";

export interface StoredDraft {
  relationship?: Relationship;
  body: string;
  mode?: LetterMode;
  hint: string;
  question: string;
}

export const EMPTY_DRAFT: StoredDraft = { body: "", hint: "", question: "" };

/**
 * localStorage는 브라우저 설정에 따라 읽기·쓰기 모두 던진다(사파리 비공개 모드 등).
 * 초안 저장 실패로 작성 자체가 깨지면 안 되므로 전부 삼킨다.
 */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveDraft(draft: StoredDraft): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // 저장 못 해도 작성은 계속된다.
  }
}

/** 편지가 실제로 생성된 뒤에만 지운다. 차단·오류에서는 남겨둔다. */
export function clearDraft(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // 비어 있는 것과 같은 결과다.
  }
}

function parseDraft(raw: string | null): StoredDraft | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      body: typeof parsed.body === "string" ? parsed.body : "",
      hint: typeof parsed.hint === "string" ? parsed.hint : "",
      question: typeof parsed.question === "string" ? parsed.question : "",
    };
  } catch {
    return null;
  }
}

/** 같은 탭 밖에서 초안이 바뀌는 경로가 없다. 구독할 것이 없으므로 빈 해지 함수만 준다. */
function subscribe(): () => void {
  return () => {};
}

/** 서버 렌더에서는 초안이 없다 — 빈 폼이 서버 HTML이다. */
function serverSnapshot(): string | null {
  return null;
}

/** 저장된 초안. 서버·하이드레이션 시점에는 null이다. */
export function useStoredDraft(): StoredDraft | null {
  const raw = useSyncExternalStore(subscribe, readRaw, serverSnapshot);
  return useMemo(() => parseDraft(raw), [raw]);
}
