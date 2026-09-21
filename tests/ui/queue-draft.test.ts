// 큐 화면의 초안 자리 — `/admin/queue` (07 §2).
//
// 07 §2가 못박은 것을 렌더 결과로 고정한다:
//
//   > **판정은 사람이 한다.** 분류기에 조치까지 맡기면 D-012가 "사후에는 사람이
//   > 판단한다"를 전제로 사전 검토를 기각한 근거가 조용히 무너지고, 운영자는 승인
//   > 버튼만 누르는 사람이 된다.
//   >
//   > 그래서 큐는 **후보 행과 근거만** 보여주고 조치 버튼은 비워둔다.
//
// 주석으로는 지킬 수 없다. 초안 옆에 버튼을 하나 붙이는 것은 diff 한 줄이고 리뷰에서
// 눈에 안 띈다. 그래서 **초안 → 본문 → 조치**의 순서를 여기서 잰다.
//
// JSX가 아니라 createElement를 쓰는 이유는 tests/ui/write-copy.test.ts와 같다 —
// vitest.config.ts의 include가 `tests/**/*.test.ts`라 .tsx는 실행되지 않는다.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportCard } from "@/components/admin/QueueScreen";
import type { QueueLetter, QueueReport } from "@/lib/admin/queue";

const DRAFT =
  "[targeting] 저격·비방 · 신뢰도 medium — 제3자가 알아볼 수 있고 부정적이다.";

/** `QueueLetter.body`는 tombstone에서 null이라(D-027) 타입이 nullable이다. 이 테스트가
 *  쓰는 것은 살아 있는 편지의 본문이므로 상수로 잡아 둔다. */
const LETTER_BODY = "그 사람 이야기를 아직도 하고 있다.";

const letter: QueueLetter = {
  id: "letter-1",
  mode: "open",
  relationship: "ex",
  body: LETTER_BODY,
  hint: null,
  question: null,
  quarantinedAt: null,
  riskLevel: "low",
  status: "hidden_auto",
  autoHideExempt: false,
  createdAt: "2026-08-15T01:02:03.000Z",
  reportCount: 1,
};

function render(draft: string | null): string {
  const report: QueueReport = {
    id: 7,
    reason: "targeting",
    createdAt: "2026-08-15T02:03:04.000Z",
    incidentId: "0123456789abcdef",
    draft,
    letter,
  };
  return renderToStaticMarkup(
    createElement(ReportCard, { report, busy: false, onResolve: () => {} }),
  );
}

describe("초안이 뜬다 (07 §2)", () => {
  it("저장된 초안 한 줄이 그대로 보인다", () => {
    expect(render(DRAFT)).toContain(DRAFT);
  });

  it("초안이 없으면 본문을 직접 읽으라고 말한다 — 빈 자리를 숨기지 않는다", () => {
    const markup = render(null);
    expect(markup).toContain("아직 없습니다");
    // 초안이 없다고 판정을 못 하는 것은 아니다. 조치는 그대로 있다.
    expect(markup).toContain("위반 — 비공개 유지 (uphold)");
    expect(markup).toContain("문제없음 — 복구 (dismiss)");
  });
});

describe("초안 옆에 조치 버튼이 없다 (07 §2 · D-012)", () => {
  it("조치는 초안과 본문을 지나 카드 아래쪽에만 있다", () => {
    const markup = render(DRAFT);

    const draftAt = markup.indexOf(DRAFT);
    const bodyAt = markup.indexOf(LETTER_BODY);
    const firstButtonAt = markup.indexOf("<button");

    expect(draftAt).toBeGreaterThanOrEqual(0);
    expect(bodyAt).toBeGreaterThan(draftAt);
    // 초안과 첫 버튼 사이에 본문이 있다 = 초안만 보고 누를 수 있는 버튼이 없다.
    expect(firstButtonAt).toBeGreaterThan(bodyAt);
  });

  it("초안을 근거로 조치를 제안하거나 기본값으로 고르지 않는다", () => {
    const markup = render(DRAFT);

    // 두 조치의 표기가 같다 — 한쪽이 권장으로 보이면 그게 승인 버튼이 된다.
    const classes = [...markup.matchAll(/<button[^>]*class="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(classes).toHaveLength(2);
    expect(classes[0]).toBe(classes[1]);

    // 판정 이유 칸은 비어 있다. 초안 문장을 미리 채워두면 그게 사람의 판정으로 남는다.
    expect(markup).toMatch(/<input[^>]*value=""/);
    expect(markup).not.toContain("autofocus");
    expect(markup).not.toContain("checked");
    // 초안은 후보 행과 근거뿐이다. 화면이 조치를 덧붙이지 않는다.
    expect(markup).not.toContain("권장");
    expect(markup).not.toContain("추천");
  });
});
