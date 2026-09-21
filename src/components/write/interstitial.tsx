"use client";

// 인터스티셜 — 등급 중간에서 제출 전에 뜬다 (02 §3 · 05-api §1).
//
// 원칙(02 §3):
//   · **무엇이 걸렸는지 정확히 알려준다.** "부적절한 표현" 같은 모호한 문구 금지 —
//     우회 학습만 시킨다
//   · 규칙 위반이 아니라 **결과**를 말한다
//   · 기본 버튼은 `고칠게요`
//   · 높음 등급에는 `이대로 올리기`가 없다 → 그 등급은 이 화면이 아니라
//     blocked-screen.tsx로 간다. 여기서 분기하지 않는다 (서버가 confirmation을
//     발급하지 않으므로 강행할 수단 자체가 없다)
//
// 문구는 분류기가 준 `notice`를 쓴다(05-api §1). 없으면 flags 기반 폴백이다.

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics/client";
import type { Flag } from "@/lib/safety/types";
import { CONSEQUENCE, UNKNOWN_REASON, flagSentences } from "./flag-copy";
import { PRIMARY, SECONDARY } from "./ui";

export function Interstitial({
  flags,
  notice,
  submitting,
  onRevise,
  onForce,
}: {
  flags: Flag[];
  notice?: string;
  submitting: boolean;
  onRevise: () => void;
  onForce: () => void;
}) {
  // 선택을 했는가. 이탈 이벤트가 선택과 겹쳐 두 번 세어지지 않게 한다.
  const decided = useRef(false);

  // `filter_abandoned` — 경고를 보고 아무것도 고르지 않은 채 나간 경우 (06 §3).
  //
  // 언마운트가 아니라 `pagehide`에 건다. React StrictMode는 개발에서 effect를 한 번
  // 더 마운트/언마운트하는데, 언마운트에 걸면 아무도 나가지 않았는데 이탈이 기록되고
  // 인터스티셜 회귀율(06 §6 #6)의 분자·분모가 오염된다. 실제 이탈(탭 닫기·뒤로가기)은
  // pagehide로 잡힌다.
  useEffect(() => {
    const onPageHide = () => {
      if (decided.current) return;
      decided.current = true;
      track("filter_abandoned", { risk: "medium" });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const sentences = flagSentences(flags);

  return (
    <section role="alertdialog" aria-labelledby="interstitial-title">
      <h2 id="interstitial-title" className="text-lg font-semibold">
        잠깐만요.
      </h2>

      <div className="mt-3 grid gap-2 text-neutral-800">
        {notice === undefined ? (
          <>
            {/* 폴백. 무엇이 걸렸는지 말하고, 그 결과를 말한다 (02 §3) */}
            {sentences.length === 0 ? (
              <p>{UNKNOWN_REASON}</p>
            ) : (
              sentences.map((sentence) => <p key={sentence}>{sentence}</p>)
            )}
            <p>{CONSEQUENCE}</p>
          </>
        ) : (
          <p>{notice}</p>
        )}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {/* 기본 버튼은 `고칠게요`다 (02 §3) */}
        <button
          type="button"
          className={PRIMARY}
          disabled={submitting}
          onClick={() => {
            decided.current = true;
            track("filter_revised", { risk: "medium" });
            onRevise();
          }}
          autoFocus
        >
          고칠게요
        </button>
        <button
          type="button"
          className={SECONDARY}
          disabled={submitting}
          onClick={() => {
            decided.current = true;
            track("filter_forced", { risk: "medium" });
            onForce();
          }}
        >
          {submitting ? "올리는 중…" : "이대로 올리기"}
        </button>
      </div>
    </section>
  );
}
