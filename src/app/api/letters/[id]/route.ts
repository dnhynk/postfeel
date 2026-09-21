// `GET /api/letters/:id` — 05-api §2.
//
// **이 파일에는 GET만 있다.** `POST .../unlock` · `.../react` · `.../report`는 각각
// 하위 경로의 파일이고 다른 워커가 맡는다.
//
// 상태별 응답은 05-api §2 「상태별 표면 응답」이고, 판정은 read.ts가 한다 —
// `hidden_auto`·`hidden_admin`·`deleted_by_author`는 **404**다. 403이 아닌 이유는 403이
// 편지의 존재를 확인해주기 때문이다.

import { jsonError, notFound } from "@/lib/errors";
import { fingerprint } from "@/lib/fingerprint";
import { loadLetter, unlockIdFromCookieHeader } from "@/lib/letters/read";

/** 05-api §6 — 킬 스위치를 매 요청 확인한다. 캐시되면 스위치가 즉시 반영되지 않는다. */
export const dynamic = "force-dynamic";

/**
 * `public_read_enabled = false` (05-api §6).
 *
 * 404가 아니라 503이다. 「상태별 표면 응답」이 404를 쓰는 이유는 403이 특정 편지의
 * 존재를 확인해주기 때문인데, 킬 스위치는 전역이라 모든 편지가 똑같이 503을 낸다 —
 * 어떤 편지에 대해서도 아무것도 알려주지 않는다. `writing_enabled`가 꺼졌을 때의
 * 503(05-api §2)과 코드를 맞춘다. 두 스위치가 다른 코드를 쓰면 나중에 한쪽만 고쳐진다.
 */
function publicReadDisabled(): Response {
  return jsonError(
    "public_read_disabled",
    "지금은 편지를 볼 수 없습니다. 잠시 후 다시 시도해 주세요.",
    503,
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  const load = await loadLetter(id, {
    // 쿠키 값은 DB 대조로만 검증된다 (04 §4 · 안전 #16). 여기서는 실어 나르기만 한다.
    unlockId: unlockIdFromCookieHeader(request.headers.get("cookie")),
    fpHash: fingerprint(request.headers),
  });

  if (load.state === "disabled") return publicReadDisabled();
  if (load.state === "not_found") return notFound();

  // `letter_view`는 **여기서 기록하지 않는다.** 클라이언트 이벤트다
  // (analytics/events.ts의 `source: 'client'`), 그리고 기록하는 자리는
  // `components/letter/LetterViewTracker` 하나다.
  //
  // 서버가 이 사건을 관측할 수는 있지만, 그렇게 하면 같은 열람이 두 번 세어진다 —
  // 화면(`/m/:id`)이 `loadLetter`를 직접 부르고 이 엔드포인트도 같은 편지를 내주기
  // 때문이다. 분모가 부풀면 주간 지표 #3(링크 유입 비중)이 실제보다 낮게 나오고,
  // 그 지표가 D-006 아래에서 유통이 도는지를 보는 유일한 수단이다.
  //
  // `source`(`feed`|`link`)를 서버가 정직하게 판정할 수 없다는 이유도 있다. 소프트
  // 내비게이션에는 referer가 갱신되지 않는다 (view-source.ts).
  return Response.json(load.letter);
}
