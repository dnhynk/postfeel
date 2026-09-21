// POST /api/events — 클라이언트 이벤트 수집 (06-analytics §2 · §3)
//
// 이 엔드포인트는 05-api에 없던 표면이다(계측 문서가 클라이언트 이벤트를 요구하는데
// 전송 경로가 비어 있었다). 공개 표면이므로 느슨하면 안 되는 지점을 여기서 고정한다:
// 이름 allowlist · props 화이트리스트 · 세션은 서버가 쿠키에서 읽기 · 레이트리밋.

import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/events/route";
import { eventsPerSession } from "@/lib/analytics/rate";
import { query } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/events";

function post(payload: unknown, cookie?: string): Request {
  return new Request("http://localhost/api/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const SESSION = `${SESSION_COOKIE}=session-events`;

async function storedEvents(): Promise<
  Array<{ name: string; session_id: string; props: Record<string, unknown> }>
> {
  const { rows } = await query<{
    name: string;
    session_id: string;
    props: Record<string, unknown>;
  }>("select name, session_id, props from events order by id");
  return rows;
}

beforeEach(async () => {
  await query("delete from events");
});

describe("이름 allowlist", () => {
  it("모르는 이름은 400이고 저장되지 않는다", async () => {
    const response = await POST(post({ name: "쓰레기", props: {} }, SESSION));
    expect(response.status).toBe(400);
    expect(await storedEvents()).toEqual([]);
  });

  it("서버가 기록하는 이벤트는 클라이언트가 보낼 수 없다", async () => {
    // letter_created를 클라이언트가 심을 수 있으면 작성 지표가 통째로 거짓이 된다.
    for (const name of ["letter_created", "email_sent", "unlock_success"]) {
      const response = await POST(post({ name, props: {} }, SESSION));
      expect(response.status).toBe(400);
    }
    expect(await storedEvents()).toEqual([]);
  });

  it("문서에 있는 클라이언트 이벤트는 204로 기록된다", async () => {
    const response = await POST(
      post({ name: "write_start", props: { entry: "feed" } }, SESSION),
    );
    expect(response.status).toBe(204);
    expect(await storedEvents()).toEqual([
      {
        name: "write_start",
        session_id: "session-events",
        props: { entry: "feed" },
      },
    ]);
  });
});

describe("props 화이트리스트 (06 §2)", () => {
  it("선언되지 않은 키는 버린다 — 편지 ID·이메일이 첫 관문에서 막힌다", async () => {
    const response = await POST(
      post(
        {
          name: "write_mode_selected",
          props: {
            mode: "locked",
            letterId: "abcdefghijklmnopqrstuv",
            email: "a@b.kr",
            body: "본문 전체",
          },
        },
        SESSION,
      ),
    );

    expect(response.status).toBe(204);
    const events = await storedEvents();
    expect(events[0]?.props).toEqual({ mode: "locked" });
  });

  it("filter_warned의 flags는 kind·field만 남는다", async () => {
    await POST(
      post(
        {
          name: "filter_warned",
          props: {
            risk: "medium",
            flags: [
              { kind: "school", field: "body", quote: "본문 조각" },
              { kind: "made_up", field: "body" },
              { kind: "self_harm", field: "hint" },
              "문자열",
            ],
          },
        },
        SESSION,
      ),
    );

    const events = await storedEvents();
    expect(events[0]?.props).toEqual({
      risk: "medium",
      flags: [
        { kind: "school", field: "body" },
        { kind: "self_harm", field: "hint" },
      ],
    });
  });

  it("긴 문자열은 담지 않는다", async () => {
    await POST(
      post({ name: "feed_view", props: { filter: "가".repeat(65) } }, SESSION),
    );
    expect((await storedEvents())[0]?.props).toEqual({});
  });
});

describe("세션 (06 §1)", () => {
  it("쿠키가 없으면 서버가 발급한다", async () => {
    const response = await POST(post({ name: "feed_view", props: {} }));

    expect(response.status).toBe(204);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");

    const events = await storedEvents();
    expect(events[0]?.session_id).not.toBe("");
  });

  it("클라이언트가 보낸 sessionId를 쓰지 않는다 — 남의 세션에 심을 수 있다", async () => {
    await POST(
      post(
        { name: "feed_view", props: {}, sessionId: "남의-세션" },
        SESSION,
      ),
    );

    const events = await storedEvents();
    expect(events[0]?.session_id).toBe("session-events");
  });
});

describe("레이트리밋", () => {
  it("한 세션의 창 안 한도를 넘기면 429", async () => {
    await query(
      `insert into events (name, session_id, props)
       select 'feed_view', 'session-events', '{}'::jsonb
         from generate_series(1, $1)`,
      [eventsPerSession.limit],
    );

    const response = await POST(post({ name: "feed_view", props: {} }, SESSION));

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
    expect(await storedEvents()).toHaveLength(eventsPerSession.limit);
  });
});

describe("형식", () => {
  it("JSON이 아니면 400", async () => {
    expect((await POST(post("not json", SESSION))).status).toBe(400);
  });
});
