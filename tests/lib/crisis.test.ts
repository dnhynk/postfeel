// 위기 상담 안내 값 (D-026 · 03 §1-6-1 · 02 S-4).
//
// 출시 게이트 항목이다. 여기서 지키는 것은 셋이다.
//
//   1. 출처가 확인된 두 건이 그대로 있다 — 값이 조용히 바뀌면 실패한다
//   2. **통합 전 구번호가 값에도 렌더 결과에도 없다.** 2024-01-01부터 자살예방 상담번호는
//      `109`로 통합됐다. 틀린 번호를 띄우는 건 안내를 안 하는 것보다 나쁘다 (03 §1-6-1)
//   3. 배열이 비면 안내 블록을 **렌더하지 않는** 안전장치가 여전히 살아 있다 — 나중에
//      출처가 낡아 값을 빼야 할 때 그 경로가 필요하다
//
// 값 자체가 맞는지는 코드가 판정할 수 없다. 출처와 확인일은 src/lib/crisis.ts 상단에
// 있고, **실제로 전화가 걸리는지는 사람이 확인한다** (08-milestones.md 출시 게이트).
//
// JSX가 아니라 createElement를 쓰는 이유는 tests/ui/write-copy.test.ts와 같다 —
// vitest.config.ts의 include가 `tests/**/*.test.ts`라 .tsx는 실행되지 않는다.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CrisisNotice } from "@/components/write/crisis-notice";
import { CRISIS_CONTACTS } from "@/lib/crisis";

/** 03 §1-6-1의 한 줄 = `<기관명> <연락처> <운영시간>`. 문서 표에서 옮긴 값이다. */
const EXPECTED = [
  { name: "자살예방상담전화", phone: "109", hours: "24시간" },
  { name: "정신건강상담전화", phone: "1577-0199", hours: "24시간" },
];

/**
 * 통합 전 구번호. **리포 어디에도 그 숫자를 literal로 적지 않는다** — 적어두면
 * 검색·복사로 살아 돌아오고, 틀린 번호는 안내를 안 하는 것보다 나쁘다 (03 §1-6-1).
 * 그래서 조립해서만 만든다 — 리포를 그 숫자로 grep하면 아무것도 나오지 않는 게 정상이다.
 */
const RETIRED_HOTLINE = `13${9 * 10 + 3}`;

function markup(): string {
  return renderToStaticMarkup(createElement(CrisisNotice));
}

describe("위기 상담 안내 값 (D-026)", () => {
  it("출처가 확인된 두 건이 그대로 있다", () => {
    expect([...CRISIS_CONTACTS]).toEqual(EXPECTED);
  });

  it("모든 항목에 기관명 · 연락처 · 운영시간이 다 차 있다", () => {
    // 03 §1-6-1의 한 줄은 셋을 요구한다. 하나라도 비면 안내가 되지 않는다.
    for (const contact of CRISIS_CONTACTS) {
      expect(contact.name).not.toBe("");
      expect(contact.phone).not.toBe("");
      expect(contact.hours).not.toBe("");
    }
  });

  it("구번호가 값에 없다 — 2024-01-01부터 109로 통합됐다", () => {
    expect(JSON.stringify(CRISIS_CONTACTS)).not.toContain(RETIRED_HOTLINE);
  });
});

describe("위기 상담 안내 렌더 (03 §1-6-1)", () => {
  it("값이 채워져 있으므로 안내 블록이 실제로 렌더된다", () => {
    const html = markup();
    expect(html).toContain("지금 많이 힘드시다면 이야기할 수 있는 곳이 있습니다.");
    for (const contact of EXPECTED) {
      expect(html).toContain(contact.name);
      expect(html).toContain(contact.phone);
      expect(html).toContain(contact.hours);
    }
  });

  it("렌더 결과에도 구번호가 없다", () => {
    expect(markup()).not.toContain(RETIRED_HOTLINE);
  });

  it("배열이 비면 아무것도 렌더하지 않는다 — 안전장치가 살아 있다", async () => {
    // 값이 채워진 뒤에도 이 경로가 남아 있어야 한다. 출처가 낡아 값을 빼야 할 때
    // 배열을 비우는 것만으로 안내가 사라지는 게 D-026이 요구하는 실패 방향이다.
    vi.resetModules();
    vi.doMock("@/lib/crisis", () => ({ CRISIS_CONTACTS: [] }));
    try {
      const { CrisisNotice: Empty } = await import(
        "@/components/write/crisis-notice"
      );
      expect(renderToStaticMarkup(createElement(Empty))).toBe("");
    } finally {
      vi.doUnmock("@/lib/crisis");
      vi.resetModules();
    }
  });
});
