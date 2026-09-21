// `친구에게 · 3일 전` — 03 흐름 0의 카드와 흐름 2의 편지 머리말이 같은 형태를 쓴다.

import {
  RELATIONSHIP_LABELS,
  type Relationship,
} from "@/lib/letters/read";
import { relativeTime } from "./relative-time";

/**
 * 관계 값이 목록 밖이면 값을 그대로 쓴다.
 *
 * 제약(04 §2에는 없고 05-api §2가 목록을 정한다)이 어긋난 행이 화면을 깨뜨리지 않게
 * 두는 것뿐이고, 정상 경로에서는 항상 목록 안이다.
 */
function label(relationship: string): string {
  return (
    RELATIONSHIP_LABELS[relationship as Relationship] ?? relationship
  );
}

export function LetterMeta({
  relationship,
  createdAt,
}: {
  relationship: string;
  createdAt: string;
}) {
  return (
    <p className="text-sm text-gray-500">
      {label(relationship)}에게 · {relativeTime(createdAt)}
    </p>
  );
}
