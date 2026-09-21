"use client";

// 03 §1-5. 제출 전 확인.
//
// **상시 노출 한 줄** — 등급과 무관하게 항상 보인다. 02 §3이 "추가 마찰 하나"로 못박은
// 문장이고, 과장 없이 사실이라 S-1과 S-9를 동시에 줄인다. 조건부로 감추지 않는다.

import { PRIMARY, SECONDARY } from "./ui";

/** 03 §1-5 · 02 §3. 글자 그대로다. */
export const ALWAYS_VISIBLE_LINE =
  "이 편지는 지울 수 있지만, 이미 본 사람의 기억은 지울 수 없습니다.";

export function ReviewStep({
  submitting,
  error,
  onSubmit,
  onBack,
}: {
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <section>
      <p className="rounded-md bg-neutral-100 px-4 py-3 text-sm text-neutral-800">
        {ALWAYS_VISIBLE_LINE}
      </p>

      {error === null ? null : (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className={SECONDARY}
          onClick={onBack}
          disabled={submitting}
        >
          뒤로
        </button>
        <button
          type="button"
          className={PRIMARY}
          onClick={onSubmit}
          disabled={submitting}
        >
          {/* 오류 뒤에는 같은 버튼이 재시도다 — 로컬 초안은 그대로 있다 (03 실패 상태 표) */}
          {submitting ? "보내는 중…" : error === null ? "편지 남기기" : "다시 시도"}
        </button>
      </div>
    </section>
  );
}
