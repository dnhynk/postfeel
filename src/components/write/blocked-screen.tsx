"use client";

// 차단 화면 — 등급 `high` (03 실패 상태 표 · 03 §1-6-1 · 02 §3).
//
//   · 걸린 항목을 명시한다. 모호한 문구 금지 (02 §3)
//   · **본문은 서버로 가지 않는다.** 로컬 초안으로만 보존된다 — 이 화면은 초안을
//     지우지 않고, `편지 고치기`를 누르면 쓰던 글이 그대로 돌아온다
//     (03 실패 상태 표 · 04 「저장하지 않는 것」)
//   · 재작성을 강요하지 않는다
//   · `flags`에 `self_harm`이 있으면 **같은 화면 안에** 위기 상담 안내를 띄운다
//     (D-026 · 03 §1-6-1). 별도 라우트를 만들지 않는다
//   · `이대로 올리기`가 없다 (02 §3). 서버가 confirmation을 발급하지 않으므로
//     강행할 수단 자체가 없다 (05-api §1 · 안전 테스트 3)

import type { Flag } from "@/lib/safety/types";
import { CrisisNotice } from "./crisis-notice";
import { UNKNOWN_REASON, flagSentences, hasSelfHarm } from "./flag-copy";
import { PRIMARY } from "./ui";

export function BlockedScreen({
  flags,
  onRevise,
}: {
  flags: Flag[];
  onRevise: () => void;
}) {
  const sentences = flagSentences(flags);

  return (
    <section>
      {/* 03 §1-6-1 그대로 */}
      <h2 className="text-lg font-semibold">이 편지는 올릴 수 없습니다.</h2>

      <div className="mt-3 grid gap-2 text-neutral-800">
        {sentences.length === 0 ? (
          <p>{UNKNOWN_REASON}</p>
        ) : (
          sentences.map((sentence) => <p key={sentence}>{sentence}</p>)
        )}
      </div>

      <p className="mt-3 text-sm text-neutral-600">
        쓰던 글은 이 브라우저에 그대로 있습니다. 고쳐서 다시 낼 수 있습니다.
      </p>

      {hasSelfHarm(flags) ? <CrisisNotice /> : null}

      <div className="mt-6">
        <button type="button" className={PRIMARY} onClick={onRevise} autoFocus>
          편지 고치기
        </button>
      </div>
    </section>
  );
}
