// 관계 유형 필터 — 03 흐름 0.
//
// **필터 축은 관계 유형뿐이다.** 감정 태그는 v0에서 뺐다 — 작성 시 질문이 하나 늘고,
// 필터로서의 가치는 아직 미검증이다 (03 흐름 0).
//
// 링크로 만든다. 필터 상태가 URL에 있으면 공유·뒤로가기가 그대로 동작하고, 이 화면에
// 클라이언트 상태를 만들 이유가 없다.

import Link from "next/link";
import {
  RELATIONSHIPS,
  RELATIONSHIP_LABELS,
  type Relationship,
} from "@/lib/letters/read";

export function RelationshipFilter({
  selected,
}: {
  selected: Relationship | null;
}) {
  return (
    <nav className="flex flex-wrap gap-2">
      <Chip href="/" label="전체" active={selected === null} />
      {RELATIONSHIPS.map((relationship) => (
        <Chip
          key={relationship}
          href={`/?relationship=${relationship}`}
          label={RELATIONSHIP_LABELS[relationship]}
          active={selected === relationship}
        />
      ))}
    </nav>
  );
}

function Chip({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full border border-gray-900 bg-gray-900 px-3 py-1 text-sm text-white"
          : "rounded-full border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:border-gray-500"
      }
    >
      {label}
    </Link>
  );
}
