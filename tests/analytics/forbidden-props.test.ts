// **`events` 테이블에 편지 ID와 이메일이 들어갈 수 없다** — 06-analytics §2.
//
// 이게 계측에서 가장 중요한 한 가지다. 편지 ID를 담는 순간 `session_id ↔ letter_id`
// 연결이 생기고, 그러면 **"누가 어떤 편지를 썼는지" 조회 가능한 테이블을 우리가 직접
// 만드는 것**이 된다. 무계정으로 설계해서 얻은 익명성을 분석 편의로 깨는 셈이다.
// 한 번 쌓인 행은 되돌릴 수 없다.
//
// 방어가 세 겹이라 세 겹을 다 잰다:
//   1. **애초에 안 담는다** — 12개 표면이 부르는 자리마다 속성만 담는다 (아래 §3)
//   2. `/api/events`의 이벤트별 화이트리스트 — 선언되지 않은 키는 버린다
//   3. `src/lib/events.ts`의 금지 키 가드 — 마지막 방어선
//
// §3이 이 파일의 핵심이다. 1·2가 뚫려도 DB에 실제로 무엇이 들어갔는지를 직접 본다.

import { beforeEach, describe, expect, it } from "vitest";
import { POST as postEvent } from "@/app/api/events/route";
import { POST as react } from "@/app/api/letters/[id]/react/route";
import { POST as report } from "@/app/api/letters/[id]/report/route";
import { POST as appeal } from "@/app/api/manage/[token]/appeal/route";
import {
  DELETE as deleteLetter,
  GET as manageView,
} from "@/app/api/manage/[token]/route";
import { query } from "@/lib/db";
import { SESSION_COOKIE, record, sanitizeProps } from "@/lib/events";
import { insertLetter } from "../fixtures/letters.ts";

const SESSION = "forbidden-props-session";
const EMAIL = "someone@example.com";

interface StoredEvent {
  name: string;
  session_id: string;
  props: Record<string, unknown>;
}

async function storedEvents(): Promise<StoredEvent[]> {
  const { rows } = await query<StoredEvent>(
    "select name, session_id, props from events order by id",
  );
  return rows;
}

beforeEach(async () => {
  await query("delete from events");
});

describe("1. 마지막 방어선 — record()의 금지 키 가드 (06 §2)", () => {
  it("개발·테스트에서는 던진다. 잘못된 호출은 머지되기 전에 죽어야 한다", () => {
    for (const key of ["letterId", "letter_id", "email", "ip", "userAgent"]) {
      expect(() => sanitizeProps("letter_view", { [key]: "x" })).toThrow(
        /담을 수 없는 키/,
      );
    }
  });

  it("던지는 자리가 record()보다 앞이라 행이 만들어지지 않는다", async () => {
    await expect(
      record("letter_view", SESSION, { letterId: "abc123" }),
    ).rejects.toThrow(/담을 수 없는 키/);

    expect(await storedEvents()).toEqual([]);
  });
});

describe("2. /api/events — 선언되지 않은 키는 버린다 (06 §1)", () => {
  async function send(name: string, props: unknown): Promise<Response> {
    return postEvent(
      new Request("http://localhost/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${SESSION}`,
        },
        body: JSON.stringify({ name, props }),
      }),
    );
  }

  it("클라이언트가 편지 ID·이메일을 실어 보내도 저장되지 않는다", async () => {
    const response = await send("letter_view", {
      mode: "open",
      relationship: "friend",
      source: "link",
      // 아래 넷은 어느 이벤트에도 선언돼 있지 않다.
      letterId: "AAAAAAAAAAAAAAAAAAAAAA",
      letter_id: "AAAAAAAAAAAAAAAAAAAAAA",
      email: EMAIL,
      ip: "203.0.113.9",
    });

    // 400이 아니라 204다 — 어떤 키가 통과하는지 알아내는 도구가 되지 않게 (06 §1).
    expect(response.status).toBe(204);
    expect(await storedEvents()).toEqual([
      {
        name: "letter_view",
        session_id: SESSION,
        props: { mode: "open", relationship: "friend", source: "link" },
      },
    ]);
  });

  it("props가 통째로 금지 키뿐이면 빈 props가 남는다", async () => {
    await send("feed_view", { letterId: "AAAAAAAAAAAAAAAAAAAAAA" });

    const events = await storedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.props).toEqual({});
  });
});

describe("3. 첫 방어선 — 서버 표면이 실제로 무엇을 담는가 (06 §2)", () => {
  /** 06 §2의 표 그대로. 어느 이벤트에도 이 키가 있으면 안 된다. */
  const FORBIDDEN_KEYS = ["letterId", "letter_id", "email", "ip", "userAgent"];

  function request(url: string, body?: unknown): Request {
    return new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "forbidden-props-test",
        cookie: `${SESSION_COOKIE}=${SESSION}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("계측이 붙은 서버 표면을 전부 지나도 편지 ID·이메일이 한 행도 없다", async () => {
    // 편지 두 통 — 하나는 신고·반응·삭제, 하나는 이의 제기.
    const { letter, manageToken } = await insertLetter();
    const { letter: hidden, manageToken: hiddenToken } = await insertLetter({
      status: "hidden_auto",
    });

    // report_submitted
    await report(request(`http://localhost/x`, { reason: "spam" }), {
      params: Promise.resolve({ id: letter.id }),
    });
    // 반응은 이벤트를 남기지 않는다 — 06 §3에 이름이 없다. 그 사실도 함께 잰다.
    await react(request(`http://localhost/x`, { kind: "same" }), {
      params: Promise.resolve({ id: letter.id }),
    });
    // manage_view
    await manageView(request(`http://localhost/x`), {
      params: Promise.resolve({ token: manageToken }),
    });
    // appeal_submitted
    await appeal(request(`http://localhost/x`, { message: EMAIL }), {
      params: Promise.resolve({ token: hiddenToken }),
    });
    // letter_deleted
    await deleteLetter(request(`http://localhost/x`), {
      params: Promise.resolve({ token: manageToken }),
    });

    const events = await storedEvents();
    expect(events.length).toBeGreaterThan(0);

    const letterIds = [letter.id, hidden.id];
    for (const stored of events) {
      const keys = Object.keys(stored.props);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(forbidden);
      }

      // 키 이름만 보는 것으로는 부족하다 — 다른 이름으로 담을 수도 있다.
      // **값**에 편지 ID나 이메일이 들어 있는지 직접 본다.
      const serialized = JSON.stringify(stored.props);
      for (const id of letterIds) {
        expect(serialized).not.toContain(id);
      }
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain("@");
      // 관리 토큰도 마찬가지다 — 편지를 지울 수 있는 값이다 (D-014).
      expect(serialized).not.toContain(manageToken);
      expect(serialized).not.toContain(hiddenToken);
    }
  });

  it("세션 id는 편지 ID가 아니다 — 쿠키에서 온 익명 랜덤이다", async () => {
    const { letter } = await insertLetter();

    await report(request("http://localhost/x", { reason: "spam" }), {
      params: Promise.resolve({ id: letter.id }),
    });

    const events = await storedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.session_id).toBe(SESSION);
    expect(events[0]?.session_id).not.toBe(letter.id);
  });
});
