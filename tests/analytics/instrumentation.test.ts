// 서버 표면이 실제로 이벤트를 남기는가 — 06-analytics §1 · §3.
//
// **주간 리뷰 7개 지표(06 §6)의 소스가 이 이벤트들이다.** 하나가 빠지면 그 지표는
// 숫자가 이상해지는 게 아니라 **아예 없다** — 그리고 그건 M5 완료 판정이 안 선다는 뜻이다.
//
// 클라이언트 이벤트(`feed_view` · `letter_view` · `unlock_view` · `post_unlock_*`)는 여기
// 없다. 그건 `/api/events`를 지나고 그 표면은 tests/api/events.test.ts가 잰다.
//
// 06 §1의 규칙도 함께 고정한다: **서버가 관측할 수 있는 이벤트는 서버가 기록한다.**
// 위조되면 지표가 거짓이 되는 이름을 `/api/events`로 받지 않는다는 것이 그 규칙이다.

import { beforeEach, describe, expect, it } from "vitest";
import { POST as postEvent } from "@/app/api/events/route";
import { POST as unlock } from "@/app/api/letters/[id]/unlock/route";
import { POST as report } from "@/app/api/letters/[id]/report/route";
import { POST as appeal } from "@/app/api/manage/[token]/appeal/route";
import {
  DELETE as deleteLetter,
  GET as manageView,
} from "@/app/api/manage/[token]/route";
import { POST as respond } from "@/app/api/unlocks/[unlockId]/response/route";
import { answerHmac } from "@/lib/answer";
import { query } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/events";
import { insertLetter, randomLetterId } from "../fixtures/letters.ts";

const SESSION = "instrumentation-session";
const ANSWER = "스타벅스";

interface StoredEvent {
  name: string;
  props: Record<string, unknown>;
}

async function events(name?: string): Promise<StoredEvent[]> {
  const { rows } = await query<StoredEvent>(
    name === undefined
      ? "select name, props from events order by id"
      : "select name, props from events where name = $1 order by id",
    name === undefined ? [] : [name],
  );
  return rows;
}

function request(body?: unknown, userAgent = "instrumentation-test"): Request {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": userAgent,
      cookie: `${SESSION_COOKIE}=${SESSION}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function insertLocked() {
  const id = randomLetterId();
  return insertLetter({
    id,
    mode: "locked",
    relationship: "ex",
    hint: "단서",
    question: "질문?",
    answerHmac: answerHmac(id, ANSWER),
  });
}

beforeEach(async () => {
  await query("delete from events");
});

describe("report_submitted (주간 지표 #5 · 02 §7 전환 트리거)", () => {
  it("사유와 관계를 담는다", async () => {
    const { letter } = await insertLetter({ relationship: "coworker" });

    await report(request({ reason: "targeting" }), {
      params: Promise.resolve({ id: letter.id }),
    });

    expect(await events("report_submitted")).toEqual([
      {
        name: "report_submitted",
        props: { reason: "targeting", relationship: "coworker" },
      },
    ]);
  });

  it("접수되지 않은 신고는 남기지 않는다 — 분자가 부풀면 트리거가 잘못 발동한다", async () => {
    const { letter } = await insertLetter({ status: "deleted_by_author" });

    // 404 (05-api §2) · 400 (사유 없음)
    await report(request({ reason: "spam" }), {
      params: Promise.resolve({ id: letter.id }),
    });
    await report(request({ reason: "없는사유" }), {
      params: Promise.resolve({ id: randomLetterId() }),
    });

    expect(await events("report_submitted")).toEqual([]);
  });
});

describe("manage_view · letter_deleted (주간 지표 #7 · S-9)", () => {
  it("관리 화면 조회는 상태를 담는다", async () => {
    const { manageToken } = await insertLetter({ status: "hidden_auto" });

    await manageView(request(), {
      params: Promise.resolve({ token: manageToken }),
    });

    expect(await events("manage_view")).toEqual([
      { name: "manage_view", props: { status: "hidden_auto" } },
    ]);
  });

  it("틀린 토큰은 남기지 않는다 — 스캔 시도가 방문 수에 섞이면 안 된다", async () => {
    await manageView(request(), {
      params: Promise.resolve({ token: "없는토큰" }),
    });

    expect(await events("manage_view")).toEqual([]);
  });

  it("삭제는 편지 나이를 시간 단위로 담는다", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
    const { manageToken } = await insertLetter({ createdAt: threeHoursAgo });

    await deleteLetter(request(), {
      params: Promise.resolve({ token: manageToken }),
    });

    const [deleted] = await events("letter_deleted");
    expect(deleted).toBeDefined();
    // 24시간 미만이라 주간 지표 #7의 분자에 들어간다.
    expect(deleted?.props.ageHours).toBeGreaterThan(2.9);
    expect(deleted?.props.ageHours).toBeLessThan(3.1);
    // 편지 ID는 담기지 않는다 (06 §2).
    expect(Object.keys(deleted?.props ?? {})).toEqual(["ageHours"]);
  });

  it("이미 지워진 편지를 다시 지워도 한 번만 남는다", async () => {
    const { manageToken } = await insertLetter();

    await deleteLetter(request(), {
      params: Promise.resolve({ token: manageToken }),
    });
    await deleteLetter(request(), {
      params: Promise.resolve({ token: manageToken }),
    });

    expect(await events("letter_deleted")).toHaveLength(1);
  });
});

describe("appeal_submitted", () => {
  it("props 없이 남긴다 — 담을 수 있는 값이 전부 06 §2의 금지 항목이다", async () => {
    const { manageToken } = await insertLetter({ status: "hidden_admin" });

    await appeal(request({ message: "제 편지는 그런 뜻이 아니었습니다" }), {
      params: Promise.resolve({ token: manageToken }),
    });

    expect(await events("appeal_submitted")).toEqual([
      { name: "appeal_submitted", props: {} },
    ]);
  });

  it("거절된 이의 제기는 남기지 않는다", async () => {
    const { manageToken } = await insertLetter({ status: "published" });

    // published 편지에는 이의를 제기할 수 없다 (05-api §3).
    await appeal(request({}), {
      params: Promise.resolve({ token: manageToken }),
    });

    expect(await events("appeal_submitted")).toEqual([]);
  });
});

describe("unlock_attempt · unlock_success (06 §4 열람 퍼널)", () => {
  it("오답은 attempt만, 정답은 attempt와 success 둘 다 남는다", async () => {
    const { letter } = await insertLocked();
    const params = { params: Promise.resolve({ id: letter.id }) };

    await unlock(request({ answer: "투썸플레이스" }), params);
    await unlock(request({ answer: ANSWER }), params);

    expect(await events("unlock_attempt")).toEqual([
      { name: "unlock_attempt", props: { success: false, attemptNo: 1 } },
      { name: "unlock_attempt", props: { success: true, attemptNo: 2 } },
    ]);
    // relationship만 담는다 — 편지 ID는 담지 않는다 (06 §2).
    expect(await events("unlock_success")).toEqual([
      {
        name: "unlock_success",
        props: { relationship: "ex", attemptNo: 2 },
      },
    ]);
  });

  it("한도에 막힌 요청은 시도가 아니다 — unlock_attempts 행과 이벤트 수가 갈라지면 안 된다", async () => {
    const { letter } = await insertLocked();
    const params = { params: Promise.resolve({ id: letter.id }) };

    // (letter, fp) 3회가 05-api §5의 한도다. 네 번째는 429.
    for (let i = 0; i < 3; i += 1) {
      await unlock(request({ answer: "틀린답" }), params);
    }
    const blocked = await unlock(request({ answer: ANSWER }), params);
    expect(blocked.status).toBe(429);

    const attempts = await events("unlock_attempt");
    const { rows } = await query<{ count: string }>(
      "select count(*) as count from unlock_attempts where letter_id = $1",
      [letter.id],
    );
    expect(attempts).toHaveLength(3);
    expect(Number(rows[0]?.count)).toBe(3);
  });
});

describe("recipient_response (주간 지표 #4의 분모)", () => {
  async function unlockOnce(): Promise<string> {
    const { letter } = await insertLocked();
    const response = await unlock(request({ answer: ANSWER }), {
      params: Promise.resolve({ id: letter.id }),
    });
    const body = (await response.json()) as { unlockId: string };
    return body.unlockId;
  }

  it("응답과 관계를 담는다", async () => {
    const unlockId = await unlockOnce();

    await respond(request({ response: "no" }), {
      params: Promise.resolve({ unlockId }),
    });

    expect(await events("recipient_response")).toEqual([
      {
        name: "recipient_response",
        props: { response: "no", relationship: "ex" },
      },
    ]);
  });

  it("두 번째 응답은 남기지 않는다 — DB가 덮어쓰지 않는데 이벤트만 쌓이면 #4의 분모가 부푼다", async () => {
    const unlockId = await unlockOnce();
    const params = { params: Promise.resolve({ unlockId }) };

    const first = await respond(request({ response: "yes" }), params);
    const second = await respond(request({ response: "no" }), params);

    // 둘 다 204다 — 두 번 누른 사람이 잘못한 것은 없다 (05-api §2).
    expect([first.status, second.status]).toEqual([204, 204]);
    // 그래도 사건은 한 번이다. `unlocks.recipient_response`도 'yes'로 남는다.
    expect(await events("recipient_response")).toEqual([
      {
        name: "recipient_response",
        props: { response: "yes", relationship: "ex" },
      },
    ]);
  });

  it("없는 unlockId는 남기지 않는다", async () => {
    await respond(request({ response: "yes" }), {
      params: Promise.resolve({ unlockId: "없는아이디" }),
    });

    expect(await events("recipient_response")).toEqual([]);
  });
});

describe("06 §1 — 서버 이벤트는 클라이언트가 보낼 수 없다", () => {
  it("여기서 기록하는 이름을 /api/events로 밀어 넣으면 400이다", async () => {
    for (const name of [
      "report_submitted",
      "manage_view",
      "letter_deleted",
      "appeal_submitted",
      "unlock_attempt",
      "unlock_success",
      "recipient_response",
    ]) {
      const response = await postEvent(
        new Request("http://localhost/api/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${SESSION_COOKIE}=${SESSION}`,
          },
          body: JSON.stringify({ name, props: {} }),
        }),
      );
      expect(response.status).toBe(400);
    }

    expect(await events()).toEqual([]);
  });
});
