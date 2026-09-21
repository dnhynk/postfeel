// 운영자 알림 표면 — 텔레그램 봇
//
// 안전 회귀 테스트. 기능 테스트가 아니라 **배포를 막는 테스트**다.

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/letters/[id]/report/route";
import { loadQueue } from "@/lib/admin/queue";
import { query } from "@/lib/db";
import { drainAfterResponse } from "@/lib/notify/schedule";
import {
  sendSevereReportAlert,
  severeReportText,
} from "@/lib/notify/telegram";
import { REPORT_REASON_LABELS } from "@/lib/reports/reasons";
import { insertLetter } from "../fixtures/letters.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 신고 행에 DB가 붙여둔 사건 번호 (migrations/0007). 운영자가 대조하는 값이다. */
async function incidentIdOf(letterId: string): Promise<string> {
  const { rows } = await query<{ incident_id: string }>(
    "select incident_id from reports where letter_id = $1",
    [letterId],
  );
  const incidentId = rows[0]?.incident_id;
  if (!incidentId) throw new Error("신고 행에 사건 번호가 없다.");
  return incidentId;
}

// docs/09-notifications.md §6 #21 · §3 · docs/00-decisions.md L-007 · D-034 6
describe("safety#21 · 텔레그램 메시지에 편지 본문도 편지 ID도 포함되지 않는다", () => {
  // 텔레그램은 서드파티 클라우드에 남는다. 본문은 남기면 안 되는 것일 가능성이 가장 높은
  // 콘텐츠고(L-007), 편지 ID는 공개 URL의 일부라 그것만으로 편지가 열린다(04 §1-1).
  // D-034가 국외로 내보내도 되는 값을 둘로 좁혔다 — 무작위 사건 번호와 고정형 위험 등급.
  it("심각 신고 알림에 사건 번호·등급·큐 링크만 담기고 본문도 편지 ID도 사유도 없다", async () => {
    const body = "여기에 절대 밖으로 나가면 안 되는 본문이 있다";
    const hint = "단서도 나가면 안 된다";
    const { letter } = await insertLetter({
      mode: "locked",
      body,
      hint,
      question: "우리가 마지막으로 만난 곳은?",
      answerHmac: Buffer.alloc(32, 7),
    });
    const incidentId = "0123456789abcdef";

    const sent: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, body: String(init.body) });
        return new Response("{}", { status: 200 });
      }),
    );

    await sendSevereReportAlert(incidentId, {
      botToken: "test-token",
      chatId: "test-chat",
    });

    expect(sent).toHaveLength(1);
    const payload = sent[0]!;
    const text = (JSON.parse(payload.body) as { text: string }).text;

    // 09 §3의 형식 그대로 — 사건 번호 · 고정형 등급 · 큐 링크.
    expect(text).toContain("심각 신고");
    expect(text).toContain("등급: 심각");
    expect(text).toContain(incidentId);
    expect(text).toContain("/admin/queue");

    // **편지 ID가 없다** (D-034 6). 이게 사건 번호가 존재하는 이유다.
    expect(payload.body).not.toContain(letter.id);

    // 본문도 단서도 질문도 나가지 않는다.
    expect(payload.body).not.toContain(body);
    expect(payload.body).not.toContain(hint);
    expect(payload.body).not.toContain("우리가 마지막으로 만난 곳은?");

    // 신고 사유 문구도 나가지 않는다 — 그 편지에 무엇이 적혀 있는지를 말하는 값이다.
    for (const label of Object.values(REPORT_REASON_LABELS)) {
      expect(payload.body).not.toContain(label);
    }

    // 메시지 생성 함수는 애초에 사건 번호 말고는 받을 자리가 없다 — 담고 싶어도 담을 수 없다.
    expect(severeReportText(incidentId)).toBe(text);
  });

  it("알림의 사건 번호로 운영자 큐에서 그 신고를 찾는다", async () => {
    // 편지 ID를 빼도 알림이 일을 하려면 이 대조가 성립해야 한다 (D-034 6).
    const { letter } = await insertLetter({ body: "대조되는 편지" });
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(
      new Request(`http://localhost/api/letters/${letter.id}/report`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "safety-telegram-match",
        },
        body: JSON.stringify({ reason: "selfharm" }),
      }),
      { params: Promise.resolve({ id: letter.id }) },
    );
    expect(response.status).toBe(204);
    await drainAfterResponse();

    const incidentId = await incidentIdOf(letter.id);
    // 편지 ID와 다른 값이다 — 같으면 대체한 것이 아니다.
    expect(incidentId).not.toBe(letter.id);
    expect(severeReportText(incidentId)).toContain(incidentId);
    expect(severeReportText(incidentId)).not.toContain(letter.id);

    // 운영자가 알림 → 큐로 가는 길. 사건 번호 하나로 신고와 편지에 도달한다.
    const queue = await loadQueue();
    const matched = queue.reports.filter(
      (report) => report.incidentId === incidentId,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.letter.id).toBe(letter.id);
    expect(matched[0]?.reason).toBe("selfharm");
  });

  it("토큰이 없으면 발송을 건너뛰고, 신고 접수는 그대로 성공한다", async () => {
    // .env.test는 TELEGRAM_* 를 비워 둔다 — 테스트에서 외부 API를 부르지 않는다.
    const { letter } = await insertLetter({ body: "본문은 나가지 않는다" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(
      new Request(`http://localhost/api/letters/${letter.id}/report`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "safety-telegram-skip",
        },
        body: JSON.stringify({ reason: "doxx" }),
      }),
      { params: Promise.resolve({ id: letter.id }) },
    );

    // 발송 실패·미설정이 신고 접수를 막지 않는다 (09 §3).
    expect(response.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
