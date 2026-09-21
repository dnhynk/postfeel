"use client";

// 클라이언트 이벤트 전송 (06-analytics §3). 다른 표면도 이걸 쓴다.
//
// 서버가 볼 수 없는 사건만 여기로 온다 — 인터스티셜을 보고 고치러 갔는지, 그냥
// 나갔는지 같은 것들(04 §5 발견 5). 서버가 관측할 수 있는 이벤트는 그 표면의 서버
// 코드가 `record()`를 직접 부른다 (events.ts의 `source` 참조).
//
// **실패해도 사용자 흐름을 막지 않는다.** 계측은 부가 기능이고, 이벤트 하나 때문에
// 편지를 못 쓰게 만들지 않는다. 그래서 await 하지 않고 오류도 삼킨다.
//
// `session_id`는 보내지 않는다 — 서버가 httpOnly 쿠키에서 읽는다 (session.ts).

import type { EventProps } from "@/lib/events";
import { EVENTS, type EventName } from "./events";

/** `source: 'client'`인 이름만. 서버 이벤트를 클라이언트에서 부르면 타입이 막는다. */
export type ClientEventName = {
  [K in EventName]: (typeof EVENTS)[K]["source"] extends "client" ? K : never;
}[EventName];

export function track(name: ClientEventName, props: EventProps = {}): void {
  // 이탈 직전에 보내는 이벤트(filter_abandoned)가 페이지 전환에 잘려나가지 않게
  // keepalive를 쓴다.
  try {
    void fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, props }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // 전송 자체가 불가능한 환경(구형 브라우저·차단기). 흐름을 막지 않는다.
  }
}
