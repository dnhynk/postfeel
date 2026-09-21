"use client";

// 03 §1-3. 문구와 순서 전부 문서 그대로다.

import type { LetterMode } from "@/lib/safety/types";
import { CHOICE, SECONDARY } from "./ui";

const OPTIONS: ReadonlyArray<{
  value: LetterMode;
  title: string;
  description: string;
}> = [
  {
    value: "open",
    title: "누구나 읽을 수 있게",
    description: "바로 공개됩니다.",
  },
  {
    value: "locked",
    title: "🔒 아는 사람만 열 수 있게",
    description: "단서를 남기고, 답을 아는 사람만 열 수 있습니다.",
  },
];

export function ModeStep({
  onSelect,
  onBack,
}: {
  onSelect: (mode: LetterMode) => void;
  onBack: () => void;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">이 편지를 어떻게 남길까요?</h2>
      <div className="mt-4 grid gap-3">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={CHOICE}
            onClick={() => onSelect(option.value)}
          >
            <span className="block font-medium">{option.title}</span>
            <span className="mt-1 block text-sm text-neutral-600">
              {option.description}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-4">
        <button type="button" className={SECONDARY} onClick={onBack}>
          뒤로
        </button>
      </div>
    </section>
  );
}
