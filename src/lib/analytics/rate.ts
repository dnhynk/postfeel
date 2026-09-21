// `POST /api/events`의 레이트리밋.
//
// ── 왜 fp가 아니라 session_id로 세는가 ──────────────────────
// 05-api §5의 대상 표에 이벤트 수집은 없다. 05-api §5의 원칙("없는 걸 만들기 전에
// 있는 걸 센다")을 그대로 적용하면 셀 수 있는 것은 `events.session_id`뿐이다.
//
// fp로 세려면 `events`에 `fp_hash` 컬럼을 더해야 하는데, 그건 06-analytics §2가
// 분리해 둔 두 값(`fp_hash`는 레이트리밋용, 이벤트는 분석용)을 한 행에서 묶는
// 것이다. 그러면 fp 하나로 그 사람의 이벤트 전체를 뽑을 수 있게 되고, 무계정으로
// 얻은 익명성을 레이트리밋 편의로 깨는 셈이 된다.
//
// **감수하는 것**: 쿠키를 지우면 카운터가 리셋된다. 초과의 대가가 "events 테이블에
// 쓰레기 행이 쌓인다"이지 안전 실패가 아니라서 v0에서는 이 교환이 맞다. 실제로
// 관측되면 그때 다시 본다.

import { query } from "@/lib/db";
import type { Rule } from "@/lib/ratelimit";

/**
 * **가설값 — 실측 후 조정한다.**
 *
 * 작성 흐름 한 번이 이벤트 8~10개를 낸다(06 §3 「작성」). 5분에 60개면 정상
 * 사용자가 한 세션에서 여러 번 왕복해도 닿지 않고, 자동화로 테이블을 채우려는
 * 쪽은 바로 걸린다.
 */
export const eventsPerSession: Rule = { limit: 60, windowMs: 5 * 60 * 1000 };

/** 창 안의 기존 이벤트 수. 창 시작점은 DB 시계로 계산한다 (ratelimit.ts와 같은 이유). */
export async function countEventsBySession(
  sessionId: string,
  windowMs: number,
): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `select count(*) as count from events
      where session_id = $1
        and created_at > now() - make_interval(secs => $2)`,
    [sessionId, windowMs / 1000],
  );
  return Number(rows[0]?.count ?? 0);
}
