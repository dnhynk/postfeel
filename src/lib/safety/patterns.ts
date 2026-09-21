// 공개 저장소에서는 실서비스 규칙을 제외했다.
//
// 층 1 정규식. **확정적으로 잡히는 것만** 잡는다. 한국어 인명·맥락은 층 2 분류기가 맡는다.
//
// 아래 규칙은 인터페이스를 보여주기 위한 무해한 예시 두 개뿐이다. 실서비스의 연락처·
// URL·주소·SNS·학교·회사 패턴은 포함하지 않았다.

import type { DetectionText, DetectionVariant } from "./normalize";
import type { FlagKind } from "./types";

/** 이 파일이 낼 수 있는 flag 종류. */
export type PatternKind = Extract<FlagKind, "contact" | "url" | "school" | "company">;

export interface PatternHit {
  kind: PatternKind;
  /** 어떤 규칙이 잡았는가. 테스트와 디버깅용이고 저장되지 않는다. */
  patternId: string;
}

interface RegexRule {
  id: string;
  kind: PatternKind;
  variants: readonly DetectionVariant[];
  regex: RegExp;
}

const RULES: readonly RegexRule[] = [
  // 예시: 평범한 이메일 주소 형태.
  {
    id: "example_email",
    kind: "contact",
    variants: ["nfc"],
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
  },
  // 예시: `https://`로 시작하는 주소.
  { id: "example_url", kind: "url", variants: ["nfc"], regex: /https?:\/\/\S+/u },
];

/** 한 필드에서 정규식이 잡은 것 전부. 중복 kind는 layer1이 정리한다. */
export function findPatternHits(text: DetectionText): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const rule of RULES) {
    if (rule.variants.some((variant) => rule.regex.test(text[variant]))) {
      hits.push({ kind: rule.kind, patternId: rule.id });
    }
  }
  return hits;
}
