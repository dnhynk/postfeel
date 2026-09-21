// `/` — 피드 (03 흐름 0). **랜딩이 곧 피드다.** 설명 페이지를 따로 두지 않는다.
//
// 색인 허용이다 (05-api §6 「색인」). `noindex`는 개별 편지 페이지(`/m/:id`)에만 있다.
//
// API를 거치지 않고 `loadFeed`를 직접 부른다. 서버 컴포넌트가 자기 API에 HTTP로 다시
// 들어갈 이유가 없고, 같은 함수를 부르므로 `GET /api/feed`와 조건·정렬·킬 스위치가
// 갈라질 수 없다.

import { FeedScreen } from "@/components/feed/FeedScreen";
import { loadFeed, parseCursor, parseRelationship } from "@/lib/letters/read";

/** 05-api §6 — 킬 스위치를 매 요청 확인한다. 정적 렌더되면 스위치도 새 편지도 반영되지 않는다. */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  // 화면은 잘못된 쿼리스트링에 오류를 띄우지 않고 기본값으로 떨어진다. 400은
  // API(`GET /api/feed`)의 몫이다 — 사람이 주소를 잘못 만졌다고 빈 화면을 주지 않는다.
  const relationship = parseRelationship(first(params.relationship));
  const cursorRaw = first(params.cursor);
  const cursor = cursorRaw === null ? null : parseCursor(cursorRaw);

  const result = await loadFeed({ relationship, cursor });

  return <FeedScreen result={result} relationship={relationship} />;
}
