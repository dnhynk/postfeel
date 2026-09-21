// 공개 저장소에서는 실서비스 규칙을 제외했다.
//
// 층 1 **탐지용** 정규화. 저장·표시에는 쓰지 않는다 — 여기서 만든 문자열은 정규식과
// 사전에 먹이는 용도로만 존재하고, 편지 본문은 원문 그대로 저장된다.
//
// src/lib/answer.ts의 `normalizeAnswer`(열쇠 대조)와 섞지 않는다. 목적이 반대라 규칙도
// 반대 방향으로 자란다.
//
// 아래 구현은 인터페이스를 유지하기 위한 최소 예시다. 실서비스의 우회 대응 규칙은
// 포함하지 않았다.

/**
 * 한 필드를 여러 통과본으로 펼친 것. 패턴마다 어느 통과본에서 볼지 직접 고른다
 * (patterns.ts의 `variants`).
 */
export interface DetectionText {
  /** 원문 — NFC만 적용. */
  nfc: string;
  /** 탐지용 정규화 + 모든 공백 제거. */
  compact: string;
  /** `compact`에서 한글·영숫자만 남긴 것. */
  alnum: string;
  /** `alnum`을 전화번호형 패턴용으로 다시 편 것. */
  digits: string;
}

export type DetectionVariant = keyof DetectionText;

const NON_ALNUM_HANGUL = /[^0-9A-Za-z가-힣]/gu;

export function normalizeForDetection(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/gu, "");
}

export function stripSeparators(text: string): string {
  return text.replace(NON_ALNUM_HANGUL, "");
}

/** 예시 구현은 아무것도 바꾸지 않는다. */
export function foldDigitStandins(text: string): string {
  return text;
}

/** 한 필드를 통과본 넷으로 펼친다. 필드당 한 번만 계산해 패턴들이 나눠 쓴다. */
export function detectionText(raw: string): DetectionText {
  const nfc = raw.normalize("NFC");
  const compact = normalizeForDetection(raw);
  const alnum = stripSeparators(compact);
  return { nfc, compact, alnum, digits: foldDigitStandins(alnum) };
}
