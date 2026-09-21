// 공개 저장소에서는 실서비스 규칙을 제외했다.
//
// 분류기 평가셋. 실서비스 평가셋(위험·정상 사례와 층 1 탐지 기대값)은 필터를 우회하는
// 지도가 되므로 비공개다. 아래는 형식을 보여주는 가상 예시 두 건이다.
//
// 위험 사례라도 실재하는 개인의 정보를 쓰지 않는다 — 메일·URL은 RFC 2606 예약 도메인
// (`example.com`)만 쓴다.

import type { LetterDraft } from "@/lib/safety/types";

/** 위험 사례의 유형. 러너의 유형별 집계가 이 값으로 나온다. */
export type RiskType =
  | "person_name"
  | "school"
  | "company"
  | "contact"
  | "url"
  | "combo"
  | "sensitive";

export interface EvalCase {
  /** `r01` · `n01` 형식. 출력에서 건을 지목할 때 쓴다. */
  id: string;
  /** 정답 라벨. 이진이다 (탐지는 `medium` 이상). */
  label: "risk" | "normal";
  /** 위험 사례의 유형. 정상에는 없다. */
  type?: RiskType;
  /** 층 1(정규식·사전)이 잡을 수 있는 유형인가. 기대값이다. */
  layer1Catchable: boolean;
  /** 이 건이 무엇을 재는가. 한 줄. */
  note: string;
  /** 층 1이 **잡으면 안 되는** 표현. 정상 사례의 오탐 지점을 적어둔다. */
  probes?: string;
  draft: LetterDraft;
}

export const CASES: readonly EvalCase[] = [
  {
    id: "r01",
    label: "risk",
    type: "contact",
    layer1Catchable: true,
    note: "본문에 연락처 (예시)",
    draft: {
      mode: "open",
      relationship: "ex",
      body: "할 말이 있으면 someone@example.com 으로 보내.",
    },
  },
  {
    id: "n01",
    label: "normal",
    layer1Catchable: false,
    note: "개인적인 감정 서술뿐인 편지 (예시)",
    draft: {
      mode: "open",
      relationship: "friend",
      body: "네가 준 편지는 아직 서랍에 있어. 버리지 못했어.",
    },
  },
];
