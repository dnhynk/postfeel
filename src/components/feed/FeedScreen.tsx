// 피드 화면 — 03 흐름 0. **랜딩이 곧 피드다.**
//
// 설명 페이지를 따로 두지 않는다 — 설명보다 실제 편지가 빠르게 이해시킨다 (03 흐름 0).
//
// 여기서 데이터를 읽지 않는다. 조회는 read.ts의 `loadFeed`가 하고 이 컴포넌트는 받은
// 것만 그린다 — 그래야 화면을 렌더하지 않고도 "무엇을 가져왔는가"를 테스트할 수 있다.

import Link from "next/link";
import { ReadDisabled } from "@/components/letter/ReadDisabled";
import type { FeedResult, Relationship } from "@/lib/letters/read";
import { FeedCard } from "./FeedCard";
import { FeedEmpty } from "./FeedEmpty";
import { FeedViewTracker } from "./FeedViewTracker";
import { RelationshipFilter } from "./RelationshipFilter";

export function FeedScreen({
  result,
  relationship,
}: {
  result: FeedResult;
  relationship: Relationship | null;
}) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">보내지 못한 말</h1>
        <Link
          href="/write"
          className="rounded-md border border-gray-900 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-900 hover:text-white"
        >
          쓰기
        </Link>
      </header>

      {/* 02 S-3 · 사칭은 무계정이라 구조적으로 막을 수 없다. 막을 수 없다는 걸 인정하고
          기대치를 낮추는 게 유일한 대응이라, 피드 전역에 항상 떠 있는다. */}
      <p className="mt-2 text-sm text-gray-500">작성자는 검증되지 않습니다.</p>

      <div className="mt-6">
        <RelationshipFilter selected={relationship} />
      </div>

      {/* `feed_view { filter }` (06 §3). 이 화면은 서버 컴포넌트라 이벤트를 직접 보낼 수
          없다 — 아무것도 그리지 않는 클라이언트 컴포넌트가 보낸다. */}
      <FeedViewTracker filter={relationship} />

      <FeedBody result={result} relationship={relationship} />
    </main>
  );
}

function FeedBody({
  result,
  relationship,
}: {
  result: FeedResult;
  relationship: Relationship | null;
}) {
  if (result.disabled) return <ReadDisabled />;
  if (result.items.length === 0) {
    return <FeedEmpty filtered={relationship !== null} />;
  }

  return (
    <>
      {/* 잠긴 편지와 열린 편지를 섞어서 보여준다. 정렬은 최신순 — 인기순은 자극적인
          편지를 상단에 올려 D-001과 충돌한다. 위험 등급 medium은 여기 뜨지 않는다.
          셋 다 read.ts의 쿼리가 정하고, 화면은 순서를 다시 만지지 않는다. */}
      <ul className="mt-6 space-y-3">
        {result.items.map((item) => (
          <li key={item.id}>
            <FeedCard item={item} />
          </li>
        ))}
      </ul>

      {result.nextCursor !== null && (
        <div className="mt-6 text-center">
          <Link
            href={moreHref(relationship, result.nextCursor)}
            className="text-sm text-gray-600 underline"
          >
            더 보기
          </Link>
        </div>
      )}
    </>
  );
}

/** 다음 페이지도 서버 렌더다. 필터를 유지해야 커서와 조건이 어긋나지 않는다. */
function moreHref(relationship: Relationship | null, cursor: string): string {
  const params = new URLSearchParams();
  if (relationship) params.set("relationship", relationship);
  params.set("cursor", cursor);
  return `/?${params.toString()}`;
}
