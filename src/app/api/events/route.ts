// POST /api/events — 클라이언트 이벤트 수집 (06-analytics §3).
//
// ── 왜 이 엔드포인트가 있나 ─────────────────────────────────
// 06-analytics는 클라이언트에서만 관측되는 이벤트를 요구하는데(04 §5 발견 5 —
// 인터스티셜 회귀율의 소스), 05-api §2에 전송 경로가 없었다. 명세 누락이라
// 코디네이터 승인을 받아 여기서 만든다. 문서 쪽 보강은 05-api §2 「나머지」 표와
// 06-analytics §1 「전송 경로」다.
//
// 표면을 12개가 공유하므로 규칙을 한 곳에서만 강제한다:
//   · 이름은 allowlist. `source: 'client'`가 아닌 이름은 400 (analytics/events.ts)
//   · props는 이벤트별 화이트리스트로 거른다. events.ts의 금지 키 가드는 마지막
//     방어선이지 첫 방어선이 아니다 (06 §2)
//   · `session_id`는 **서버가 httpOnly 쿠키에서 읽는다.** 클라이언트가 보낸 값을
//     쓰면 남의 세션으로 이벤트를 심을 수 있다
//   · 레이트리밋은 세션 기준 (analytics/rate.ts에 근거)
//   · **실패해도 사용자 흐름을 막지 않는다.** 계측은 부가 기능이다

import {
  isClientEvent,
  isEventName,
  pickProps,
} from "@/lib/analytics/events";
import { countEventsBySession, eventsPerSession } from "@/lib/analytics/rate";
import { ensureSession, withSession } from "@/lib/analytics/session";
import { invalidRequest, rateLimited } from "@/lib/errors";
import { record } from "@/lib/events";
import { exceeded } from "@/lib/ratelimit";

export async function POST(request: Request): Promise<Response> {
  const session = ensureSession(request.headers);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return invalidRequest("요청 본문이 JSON이 아닙니다.");
  }

  const { name, props } =
    typeof payload === "object" && payload !== null
      ? (payload as { name?: unknown; props?: unknown })
      : {};

  // 모르는 이름을 받으면 누구나 우리 테이블을 채울 수 있다.
  if (!isEventName(name) || !isClientEvent(name)) {
    return withSession(
      invalidRequest("알 수 없는 이벤트입니다."),
      session,
    );
  }

  const count = await countEventsBySession(
    session.sessionId,
    eventsPerSession.windowMs,
  );
  if (exceeded(count, eventsPerSession)) {
    return withSession(
      rateLimited(Math.ceil(eventsPerSession.windowMs / 1000)),
      session,
    );
  }

  try {
    await record(name, session.sessionId, pickProps(name, props));
  } catch {
    // 기록 실패로 사용자 흐름을 깨지 않는다. 클라이언트는 응답을 보지 않는다.
  }

  return withSession(new Response(null, { status: 204 }), session);
}
