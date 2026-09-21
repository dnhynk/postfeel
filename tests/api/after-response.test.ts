// 발송은 응답 뒤에 돈다 — **`after()`로 감쌌을 때만** (09 §2 · D-018).
//
// ── 이 파일이 고정하는 것 ───────────────────────────────────
// 서버리스에서 응답 뒤 실행이 보장되는 것은 `after()`/`waitUntil`로 감싼 일뿐이다
// (근거 URL은 src/lib/notify/schedule.ts). 감싸지 않은 `void notify(...)`는 인스턴스가
// 정리되면서 조용히 사라지고, **실행이 없으니 로그도 없다** — 09 §2가 정한 "실패하면
// 로그만 남기고 포기"는 발송이 실패하는 경우이지 실행이 아예 없는 경우가 아니다.
//
// ── 왜 행동만 보면 못 잡나 ──────────────────────────────────
// Next 런타임 밖에서는 `after()`가 던지고(`E468`) 헬퍼가 맨 프로미스로 폴백한다. 그래서
// 감싼 코드와 안 감싼 코드의 **관측 가능한 행동이 똑같아진다** — "결국 메일이 나갔나"만
// 보는 테스트는 `after()`를 벗겨도 통과한다.
//
// 그래서 여기서는 `next/server`의 `after`를 가로채 **예약 자체를** 본다. 가로챈 `after`는
// 콜백을 모아만 두고 돌리지 않으므로, 응답 시점에 발송이 이미 불렸다면 그건 예약을
// 거치지 않았다는 뜻이다. 라우트에서 `scheduleAfterResponse`를 벗겨 `void notify(...)`로
// 되돌리면 아래 `not.toHaveBeenCalled()`가 전부 깨진다.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** 가로챈 `after()`가 받아 둔 콜백들. 돌리는 것은 테스트가 정한다. */
  scheduled: [] as Array<() => Promise<void>>,
  /** 요청 스코프 밖(테스트·스크립트)을 흉내 낼 때 켠다. */
  afterThrows: { value: false },
  email: {
    notifyFirstUnlock: vi.fn(async () => {}),
    notifyRecipientYes: vi.fn(async () => {}),
    notifyAutoHidden: vi.fn(async () => {}),
    notifyManageLink: vi.fn(async () => {}),
  },
  telegram: {
    notifySevereReport: vi.fn(async () => {}),
  },
  /**
   * 발송은 아니지만 같은 자리에 예약되는 일이다 (07 §2 큐 초안 · F7).
   *
   * 여기서 갈아끼우는 이유는 이 파일이 재는 것이 **예약이 되는가**이지 초안이 무엇인가가
   * 아니기 때문이다. 진짜를 두면 분류기 호출이 예약 실행에 끼어든다 — 초안 자체는
   * `tests/api/report-draft.test.ts`가 본다.
   */
  reports: {
    fillReportDraft: vi.fn(async () => {}),
  },
}));

vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    if (mocks.afterThrows.value) {
      // 진짜 `after()`가 요청 스코프 밖에서 하는 일이다.
      throw new Error("E468: `after` was called outside a request scope");
    }
    mocks.scheduled.push(task);
  },
}));

// 발송 함수만 갈아끼운다. 같은 모듈의 나머지(`deliver` 등)는 원본 그대로여야 다른
// 코드가 부수적으로 깨지지 않는다.
vi.mock("@/lib/notify/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/email")>()),
  ...mocks.email,
}));

vi.mock("@/lib/notify/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/telegram")>()),
  ...mocks.telegram,
}));

vi.mock("@/lib/reports/draft", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/draft")>()),
  ...mocks.reports,
}));

import { POST as postContact } from "@/app/api/manage/[token]/contact/route";
import { POST as postReport } from "@/app/api/letters/[id]/report/route";
import { POST as postResponse } from "@/app/api/unlocks/[unlockId]/response/route";
import { POST as postUnlock } from "@/app/api/letters/[id]/unlock/route";
import { answerHmac } from "@/lib/answer";
import { query } from "@/lib/db";
import { scheduleAfterResponse } from "@/lib/notify/schedule";
import { insertLetter, randomLetterId } from "../fixtures/letters.ts";

const ANSWER = "스타벅스";

function json(url: string, body: unknown, userAgent = "after-test"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(body),
  });
}

async function insertLocked() {
  const id = randomLetterId();
  return insertLetter({
    id,
    mode: "locked",
    hint: "2019년 봄",
    question: "그날 들어간 카페 이름은?",
    answerHmac: answerHmac(id, ANSWER),
  });
}

/** 모아둔 콜백을 실제로 돌린다 — 배포에서 응답이 나간 뒤에 벌어지는 일이다. */
async function runScheduled(): Promise<void> {
  const tasks = mocks.scheduled.splice(0);
  for (const task of tasks) await task();
}

beforeEach(async () => {
  await query("delete from letters");
  mocks.scheduled.length = 0;
  mocks.afterThrows.value = false;
  vi.clearAllMocks();
});

// ── 다섯 발송 자리 ──────────────────────────────────────────
//
// 각 테스트의 뼈대는 같다: 응답이 끝난 시점에 발송은 **아직 안 불렸고**, 예약만 쌓여
// 있다. 예약을 돌리면 그때 불린다. 첫 단언이 `after()`를 벗기는 순간 깨지는 자리다.

describe("발송은 after()로 예약된다 (09 §2 · D-018)", () => {
  it("첫 열람 메일 — POST /api/letters/:id/unlock", async () => {
    const { letter } = await insertLocked();

    const response = await postUnlock(
      json(`http://localhost/api/letters/${letter.id}/unlock`, {
        answer: ANSWER,
      }),
      { params: Promise.resolve({ id: letter.id }) },
    );

    expect(response.status).toBe(200);
    // 감싸지 않았다면 여기서 이미 불려 있다.
    expect(mocks.email.notifyFirstUnlock).not.toHaveBeenCalled();
    expect(mocks.scheduled).toHaveLength(1);

    await runScheduled();
    expect(mocks.email.notifyFirstUnlock).toHaveBeenCalledWith(letter.id);
  });

  it("yes 응답 메일 — POST /api/unlocks/:unlockId/response", async () => {
    const { letter } = await insertLocked();
    const unlocked = await postUnlock(
      json(`http://localhost/api/letters/${letter.id}/unlock`, {
        answer: ANSWER,
      }),
      { params: Promise.resolve({ id: letter.id }) },
    );
    const { unlockId } = (await unlocked.json()) as { unlockId: string };
    await runScheduled();
    vi.clearAllMocks();

    const response = await postResponse(
      json(`http://localhost/api/unlocks/${unlockId}/response`, {
        response: "yes",
      }),
      { params: Promise.resolve({ unlockId }) },
    );

    expect(response.status).toBe(204);
    expect(mocks.email.notifyRecipientYes).not.toHaveBeenCalled();
    expect(mocks.scheduled).toHaveLength(1);

    await runScheduled();
    expect(mocks.email.notifyRecipientYes).toHaveBeenCalledWith(unlockId);
  });

  it("심각 신고 텔레그램 · 자동 비공개 메일 · 큐 초안 — POST /api/letters/:id/report", async () => {
    const { letter } = await insertLetter();

    const response = await postReport(
      json(
        `http://localhost/api/letters/${letter.id}/report`,
        { reason: "doxx" },
        `report-${Math.random()}`,
      ),
      { params: Promise.resolve({ id: letter.id }) },
    );

    expect(response.status).toBe(204);
    // 09 §3 — 이 둘이 조용히 사라지면 운영자가 자는 동안 S-5 콘텐츠가 떠 있는다.
    expect(mocks.telegram.notifySevereReport).not.toHaveBeenCalled();
    expect(mocks.email.notifyAutoHidden).not.toHaveBeenCalled();
    // 07 §2 큐 초안도 같은 자리다 — 제출 경로가 아니라 응답을 막지 않는다.
    expect(mocks.reports.fillReportDraft).not.toHaveBeenCalled();
    expect(mocks.scheduled).toHaveLength(3);

    await runScheduled();
    // D-034 6 — 넘어가는 것은 편지 ID가 아니라 신고 행 번호다.
    expect(mocks.telegram.notifySevereReport).toHaveBeenCalledWith({
      reason: "doxx",
      reportId: expect.any(Number),
    });
    expect(mocks.email.notifyAutoHidden).toHaveBeenCalledWith(letter.id);

    const { rows } = await query<{ id: string }>(
      "select id from reports where letter_id = $1",
      [letter.id],
    );
    expect(mocks.reports.fillReportDraft).toHaveBeenCalledWith(
      Number(rows[0]?.id),
      letter.id,
      "doxx",
    );
  });

  it("관리 링크 메일 — POST /api/manage/:token/contact", async () => {
    const { manageToken } = await insertLetter();

    const response = await postContact(
      json(`http://localhost/api/manage/${manageToken}/contact`, {
        email: "author@example.com",
        ageConfirmed: true,
      }),
      { params: Promise.resolve({ token: manageToken }) },
    );

    expect(response.status).toBe(204);
    // D-014 — 관리 토큰 원문은 이 요청에만 있다. 유실되면 재발송 경로가 없다.
    expect(mocks.email.notifyManageLink).not.toHaveBeenCalled();
    expect(mocks.scheduled).toHaveLength(1);

    await runScheduled();
    expect(mocks.email.notifyManageLink).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "author@example.com",
        manageToken,
      }),
    );
  });
});

// ── 헬퍼 자체 ───────────────────────────────────────────────

describe("scheduleAfterResponse (notify/schedule.ts)", () => {
  it("after()가 있으면 그쪽에 넘기고 즉시 돌리지 않는다", async () => {
    const task = vi.fn(async () => {});

    scheduleAfterResponse("test", task);

    expect(task).not.toHaveBeenCalled();
    expect(mocks.scheduled).toHaveLength(1);
    await runScheduled();
    expect(task).toHaveBeenCalledOnce();
  });

  it("after()가 던지면(요청 스코프 밖) 폴백으로 그래도 돈다", async () => {
    mocks.afterThrows.value = true;
    const task = vi.fn(async () => {});

    expect(() => scheduleAfterResponse("test", task)).not.toThrow();

    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    expect(mocks.scheduled).toHaveLength(0);
  });

  it("task가 던져도 삼키고 로그만 남긴다 (09 §2 — 실패 정책은 그대로)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("발송 실패");

    scheduleAfterResponse("manage_link", async () => {
      throw boom;
    });
    // 예약을 돌리는 쪽으로 거부가 새어 나가면 안 된다 — 받아줄 호출자가 없다.
    await expect(runScheduled()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith("[after] manage_link 실패", boom);
    logged.mockRestore();
  });
});

// ── 재발 방지 ───────────────────────────────────────────────
//
// 감싸는 것은 한 번 하면 끝이지만, **다음에 발송 자리를 하나 더 만들 때** 맨 프로미스로
// 돌아가기 쉽다. 그게 이 버그의 성질이다 — 조용해서 리뷰에서도 안 보인다. lint 규칙은
// eslint.config.mjs가 공유 파일이라 손대지 않고, 같은 일을 여기서 한다.

describe("맨 프로미스 재발 방지", () => {
  it("서버 코드에 `void notify...(` 가 없다", () => {
    const srcDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src",
    );

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        // 이 규칙을 설명하는 파일 자신은 예외다 (주석에 예시가 들어 있다).
        if (full.endsWith(path.join("notify", "schedule.ts"))) continue;

        readFileSync(full, "utf8")
          .split(/\r?\n/)
          .forEach((line, index) => {
            if (/\bvoid\s+notify[A-Z]/.test(line)) {
              offenders.push(`${path.relative(srcDir, full)}:${index + 1}`);
            }
          });
      }
    };
    walk(srcDir);

    expect(offenders).toEqual([]);
  });
});
