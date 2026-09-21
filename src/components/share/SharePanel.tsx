"use client";

// 공유 문구 + 복사 버튼 — 03 흐름 3 · 06-analytics §3 「유통」.
//
// > 사용자가 "뭐라고 하면서 보내지"에서 막히면 공유하지 않는다 (03 흐름 3)
//
// **D-006에 따라 공유가 유일한 배달 수단이다.** 그래서 이 패널은 부가 기능이 아니라
// 유통 경로의 마지막 한 걸음이고, 여기서 막히면 편지가 아무에게도 안 간다.
//
// ── 왜 복사가 두 개인가 ──────────────────────────────────────
//
// 06-analytics §3의 `share_copied { kind: 'link' | 'text' }`가 둘을 구분한다. 링크만
// 필요한 사람(이미 무슨 말을 할지 아는 사람)과 문구가 필요한 사람은 다른 사용자이고,
// 둘 중 어느 쪽이 실제로 공유하는지가 유통 진단의 입력이다.
//
// ── 계측에 편지 ID를 담지 않는다 ────────────────────────────
//
// 06-analytics §2의 금지 규칙이다. `letterId`는 링크를 만드는 데만 쓰고 `track()`에는
// `mode`와 `from`만 넘어간다.

import { useEffect, useState } from "react";
import { track } from "@/lib/analytics/client";
import type { LetterMode } from "@/lib/letters/read";
import { letterUrl, shareText } from "./text";

/** 06-analytics §3의 `share_opened { from }` 열거값. */
export type ShareFrom = "create_done" | "feed" | "letter";

type CopyKind = "link" | "text";

const BUTTON =
  "inline-flex items-center justify-center rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100";

export function SharePanel({
  letterId,
  mode,
  from,
  defaultOpen = false,
}: {
  letterId: string;
  mode: LetterMode;
  from: ShareFrom;
  /** 완료 화면처럼 공유가 그 화면의 목적인 자리에서는 펼친 채로 시작한다. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState<CopyKind | null>(null);

  // 펼쳐진 순간이 곧 `share_opened`다. 완료 화면처럼 처음부터 펼쳐진 자리에서는
  // 마운트가 그 순간이다.
  useEffect(() => {
    if (open) track("share_opened", { mode, from });
  }, [open, mode, from]);

  const text = shareText(letterId);

  async function copy(kind: CopyKind): Promise<void> {
    const value = kind === "link" ? letterUrl(letterId) : text;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      // 실제로 복사된 경우에만 센다. 실패까지 세면 유통 지표가 부풀려진다.
      track("share_copied", { mode, kind });
    } catch {
      // 클립보드 권한이 없으면 사용자가 직접 고른다. 문구는 화면에 그대로 있다.
      setCopied(null);
    }
  }

  if (!open) {
    return (
      <button type="button" className={BUTTON} onClick={() => setOpen(true)}>
        공유하기
      </button>
    );
  }

  return (
    // `w-full` — 피드 카드에서는 반응 버튼과 같은 flex 줄에 있다가 펼쳐지면 줄을 넘긴다.
    // 그래야 펼친 패널이 반응 버튼을 옆으로 밀어내지 않는다.
    <div className="w-full rounded-lg border border-neutral-200 p-4">
      {/* 03 흐름 3의 문구 그대로. 보이는 것과 복사되는 것이 같아야 한다 — 다르면
          사용자가 붙여넣고 나서 놀란다. */}
      <p className="whitespace-pre-wrap break-words text-sm text-neutral-700">
        {text}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          onClick={() => void copy("link")}
        >
          {copied === "link" ? "복사됨" : "링크 복사"}
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={() => void copy("text")}
        >
          {copied === "text" ? "복사됨" : "문구 복사"}
        </button>
      </div>
    </div>
  );
}
