// 작성 화면의 문구가 docs/03-flows.md와 글자 그대로 같은지 (03 §1-1 ~ §1-6-1)
//
// 03 §1-4가 "v0에서 문구가 가장 중요한 화면"이라고 못박았다 — 여기 문구가 S-1(저격)
// 발생률을 직접 결정한다. 문구는 주석으로 지킬 수 없어서 렌더 결과로 고정한다.
// 아래 문자열은 **문서에서 복사한 것**이고, 코드에서 복사한 것이 아니다.
//
// JSX가 아니라 createElement를 쓰는 이유: vitest.config.ts의 include가
// `tests/**/*.test.ts`라 .tsx는 아예 실행되지 않는다. 설정 파일은 이 표면의 소유가
// 아니므로 테스트 쪽을 맞춘다.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockedScreen } from "@/components/write/blocked-screen";
import { DoneScreen } from "@/components/write/done-screen";
import { Interstitial } from "@/components/write/interstitial";
import { LockedStep } from "@/components/write/locked-step";
import { ModeStep } from "@/components/write/mode-step";
import { RelationshipStep } from "@/components/write/relationship-step";
import { ReviewStep } from "@/components/write/review-step";
import { CRISIS_CONTACTS } from "@/lib/crisis";
import type { Flag } from "@/lib/safety/types";

/** 렌더 결과의 텍스트만 남긴다 — 문구 비교에 마크업이 끼어들지 않게. */
function text(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const noop = () => {};

describe("03 §1-1 관계 선택", () => {
  const rendered = text(createElement(RelationshipStep, { onSelect: noop }));

  it("질문과 다섯 개의 선택지가 문서 그대로다", () => {
    expect(rendered).toContain("누구에게 보내지 못한 말인가요?");
    for (const label of ["옛 연인", "친구", "가족", "동료", "그 외"]) {
      expect(rendered).toContain(label);
    }
  });
});

describe("03 §1-3 모드 선택", () => {
  const rendered = text(
    createElement(ModeStep, { onSelect: noop, onBack: noop }),
  );

  it("문구가 문서 그대로다", () => {
    expect(rendered).toContain("이 편지를 어떻게 남길까요?");
    expect(rendered).toContain("누구나 읽을 수 있게");
    expect(rendered).toContain("바로 공개됩니다.");
    expect(rendered).toContain("🔒 아는 사람만 열 수 있게");
    expect(rendered).toContain(
      "단서를 남기고, 답을 아는 사람만 열 수 있습니다.",
    );
  });
});

describe("03 §1-4 단서와 열쇠 — v0에서 문구가 가장 중요한 화면", () => {
  const rendered = text(
    createElement(LockedStep, {
      hint: "",
      question: "",
      answer: "",
      onChange: noop,
      onNext: noop,
      onBack: noop,
    }),
  );

  it("지시가 '사람을 특정하라'가 아니라 '순간을 특정하라'다", () => {
    expect(rendered).toContain("둘만 아는 순간을 하나 적어주세요");
    // 문서가 ❌로 못박은 표현이 화면에 있으면 안 된다.
    expect(rendered).not.toContain("이 사람만 알아볼 수 있는 단서");
  });

  it("공개 여부가 입력란 옆에 있다 — 없으면 비공개로 착각하고 식별정보를 쓴다", () => {
    expect(rendered).toContain("그 사람만 답할 수 있는 질문");
    // 단서·질문 둘 다 (모두에게 보입니다)
    expect(rendered.match(/\(모두에게 보입니다\)/g)).toHaveLength(2);
    expect(rendered).toContain("(저장되지 않습니다)");
  });

  it("쓸 수 없는 것을 명시한다", () => {
    expect(rendered).toContain("이름 · 학교 · 회사 · 연락처는 쓸 수 없습니다.");
  });
});

describe("03 §1-5 · 02 §3 제출 전 상시 노출 한 줄", () => {
  it("등급과 무관하게 항상 보인다", () => {
    const rendered = text(
      createElement(ReviewStep, {
        submitting: false,
        error: null,
        onSubmit: noop,
        onBack: noop,
      }),
    );
    expect(rendered).toContain(
      "이 편지는 지울 수 있지만, 이미 본 사람의 기억은 지울 수 없습니다.",
    );
  });
});

describe("02 §3 인터스티셜", () => {
  const flags: Flag[] = [{ kind: "school", field: "body" }];

  it("기본 버튼은 `고칠게요`이고 `이대로 올리기`가 함께 있다", () => {
    const rendered = text(
      createElement(Interstitial, {
        flags,
        submitting: false,
        onRevise: noop,
        onForce: noop,
      }),
    );
    expect(rendered).toContain("잠깐만요.");
    expect(rendered).toContain("고칠게요");
    expect(rendered).toContain("이대로 올리기");
  });

  it("notice가 없으면 무엇이 걸렸는지와 그 결과를 말한다 — 모호한 문구가 아니다", () => {
    const rendered = text(
      createElement(Interstitial, {
        flags,
        submitting: false,
        onRevise: noop,
        onForce: noop,
      }),
    );
    expect(rendered).toContain("본문에 학교 이름으로 보이는 표현이 있습니다.");
    expect(rendered).toContain(
      "이대로 올리면 이 편지를 본 다른 사람도 그 사람이 누구인지 알아볼 수 있습니다.",
    );
    expect(rendered).not.toContain("부적절한 표현");
  });

  it("분류기가 준 notice가 있으면 그것을 쓴다", () => {
    const rendered = text(
      createElement(Interstitial, {
        flags,
        notice: "분류기가 만든 한 문장입니다.",
        submitting: false,
        onRevise: noop,
        onForce: noop,
      }),
    );
    expect(rendered).toContain("분류기가 만든 한 문장입니다.");
  });
});

describe("03 §1-6-1 차단 화면", () => {
  it("걸린 항목을 명시하고 `이대로 올리기`가 없다", () => {
    const rendered = text(
      createElement(BlockedScreen, {
        flags: [{ kind: "school", field: "hint" }],
        onRevise: noop,
      }),
    );
    expect(rendered).toContain("이 편지는 올릴 수 없습니다.");
    expect(rendered).toContain("단서에 학교 이름으로 보이는 표현이 있습니다.");
    expect(rendered).toContain("편지 고치기");
    expect(rendered).not.toContain("이대로 올리기");
  });

  it("self_harm이면 검증된 연락처를 안내한다 (D-026 · 03 §1-6-1)", () => {
    const rendered = text(
      createElement(BlockedScreen, {
        flags: [{ kind: "self_harm", field: "body" }],
        onRevise: noop,
      }),
    );
    // 값이 채워졌으므로 안내 블록이 렌더된다 (출처는 src/lib/crisis.ts 상단).
    expect(CRISIS_CONTACTS.length).toBeGreaterThan(0);
    expect(rendered).toContain(
      "지금 많이 힘드시다면 이야기할 수 있는 곳이 있습니다.",
    );
    expect(rendered).toContain("자살예방상담전화");
    expect(rendered).toContain("109");
    expect(rendered).toContain("정신건강상담전화");
    expect(rendered).toContain("1577-0199");
    expect(rendered).toContain("24시간");
    // 구번호 회귀 방지. 2024-01-01부터 자살예방 상담번호는 109로 통합됐고,
    // 틀린 번호를 띄우는 건 안내를 안 하는 것보다 나쁘다 (03 §1-6-1).
    // 그 숫자를 literal로 적지 않으려고 조립한다 — 자세한 이유는 tests/lib/crisis.test.ts.
    expect(rendered).not.toContain(`13${9 * 10 + 3}`);
  });
});

describe("03 §1-6 완료 화면", () => {
  const rendered = text(
    createElement(DoneScreen, {
      manageToken: "manage-token-value",
      letterId: "letter-id-value",
      mode: "open" as const,
    }),
  );

  it("문구가 문서 그대로이고 관리 링크에 편지 ID가 없다 (D-014)", () => {
    expect(rendered).toContain("편지를 남겼습니다.");
    expect(rendered).toContain("이 링크로 언제든 편지를 지울 수 있습니다.");
    expect(rendered).toContain("복사");
    expect(rendered).toContain("/manage/manage-token-value");
    // D-014는 **관리 링크**에 편지 ID가 없어야 한다는 것이다. 공유 링크(`/m/:id`)에는
    // 당연히 들어간다 — 그게 공유의 대상이다. 둘이 섞이지 않았는지 여기서 본다.
    expect(rendered).not.toContain("/manage/letter-id-value");
    expect(rendered).toContain("/m/letter-id-value");
  });

  it("공유 문구가 03 흐름 3 그대로다", () => {
    // 사용자가 "뭐라고 하면서 보내지"에서 막히면 공유하지 않는다 (03 흐름 3).
    expect(rendered).toContain("혹시 너한테 온 거 아니야?");
    expect(rendered).toContain("링크 복사");
    expect(rendered).toContain("문구 복사");
    // 08 M4가 기각한 문구 — 상대를 "위로가 필요한 사람"으로 분류한다.
    expect(rendered).not.toContain("최근에 헤어진 친구");
  });
});
