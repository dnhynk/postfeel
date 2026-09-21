// `GET /api/feed` — 05-api §2.
//
//   ?relationship=friend&cursor=<created_at>_<id>&limit=20
//   { items: FeedItem[], nextCursor: string | null }
//
// 조건·정렬·커서는 전부 src/lib/letters/read.ts에 있다. 화면(`/`)이 같은 함수를 부른다.

import { invalidRequest } from "@/lib/errors";
import {
  loadFeed,
  parseCursor,
  parseLimit,
  parseRelationship,
} from "@/lib/letters/read";

/**
 * 킬 스위치를 **매 요청** DB에서 읽는다 (05-api §6 · settings.ts).
 *
 * 응답이 캐시되면 `public_read_enabled`를 꺼도 이전 응답이 계속 나간다. 그러면 스위치가
 * 아니라 장식이다.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const relationshipRaw = params.get("relationship");
  const relationship = parseRelationship(relationshipRaw);
  if (relationshipRaw !== null && relationship === null) {
    return invalidRequest("관계 유형이 올바르지 않습니다.");
  }

  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw === null ? null : parseCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) {
    return invalidRequest("커서가 올바르지 않습니다.");
  }

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return invalidRequest("limit 값이 올바르지 않습니다.");
  }

  return Response.json(await loadFeed({ relationship, cursor, limit }));
}
