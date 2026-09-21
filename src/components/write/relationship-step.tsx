"use client";

// 03 §1-1. 첫 화면을 선택 하나로 둔다 — 빈 텍스트 상자를 첫 화면으로 던지면 이탈한다.

import type { Relationship } from "@/lib/safety/types";
import { CHOICE } from "./ui";

/** 라벨과 순서 전부 03 §1-1 그대로다. */
const OPTIONS: ReadonlyArray<{ value: Relationship; label: string }> = [
  { value: "ex", label: "옛 연인" },
  { value: "friend", label: "친구" },
  { value: "family", label: "가족" },
  { value: "coworker", label: "동료" },
  { value: "other", label: "그 외" },
];

export function RelationshipStep({
  onSelect,
}: {
  onSelect: (relationship: Relationship) => void;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">누구에게 보내지 못한 말인가요?</h2>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`${CHOICE} text-center`}
            onClick={() => onSelect(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
