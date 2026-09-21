"use client";

// 03 §1-2. 본문.
//
// **타이핑 중 필터를 돌리지 않는다.** 실시간 경고는 감시받는 느낌을 주고 우회 표현을
// 학습시킨다. 검사는 제출 시 1회다 — 그래서 이 컴포넌트는 `/api/letters`를 부르지
// 않고, 글자 수 말고는 어떤 판단도 하지 않는다.
//
// 자동 로컬 저장은 부모(write-flow.tsx)가 한다. 저장 주체가 두 곳이면 어느 쪽이
// 마지막인지 알 수 없다.

import { MAX_BODY } from "./limits";
import { INPUT, PRIMARY, SECONDARY } from "./ui";

export function BodyStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const tooLong = value.length > MAX_BODY;
  return (
    <section>
      <h2 className="text-lg font-semibold">하지 못한 말을 적어주세요.</h2>
      <textarea
        className={`${INPUT} mt-4 min-h-56 resize-y`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
      />
      <p
        className={`mt-2 text-sm ${tooLong ? "text-red-600" : "text-neutral-500"}`}
      >
        {value.length} / {MAX_BODY}자
      </p>
      <div className="mt-4 flex gap-2">
        <button type="button" className={SECONDARY} onClick={onBack}>
          뒤로
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={value.trim() === "" || tooLong}
          onClick={onNext}
        >
          다음
        </button>
      </div>
    </section>
  );
}
