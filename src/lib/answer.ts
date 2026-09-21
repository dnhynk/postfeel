// 열쇠 답 정규화와 대조. 04 §4를 그대로 옮긴 것이고, 여기서 규칙을 늘리지 않는다.
//
//   1. 유니코드 NFC 정규화     ← 한글 자모 분리 입력(맥/윈도우 차이) 흡수
//   2. 앞뒤 공백 제거
//   3. 모든 내부 공백 제거     ← 한국어 띄어쓰기 불일치가 매우 흔함
//   4. 영문 소문자화
//   5. 문장부호 제거 (.,!?~·'"「」)
//   → HMAC-SHA256(answer_key, letter_id || normalized)
//
// `letter_id`를 키 재료에 넣어 편지별 솔트로 쓴다. 같은 답을 쓴 두 편지의 해시가
// 같아지지 않는다 (04 §4).
//
// **숫자 한글 표기 통일(`3`↔`삼`) 같은 확장을 넣지 않는다.** 04 §4가 명시적으로
// 뺐다 — 오탐이 늘고 이득이 불확실하다. 표기 흔들림은 정규화가 아니라 D-021의
// 표기 변형(answer_variant_hmacs)이 담당한다.
//
// 답 원문은 어디에도 저장되지 않는다 (04 「저장하지 않는 것」 · 안전 테스트 23).

import { constantTimeEqual, hmacSha256 } from "./crypto";
import { env } from "./env";

/** 04 §4가 열거한 문장부호. 목록을 늘리려면 문서를 먼저 고친다. */
const PUNCTUATION = /[.,!?~·'"「」]/g;

export function normalizeAnswer(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, "")
    .toLowerCase()
    .replace(PUNCTUATION, "");
}

/** HMAC-SHA256(answer_key, letter_id || normalize(answer)) (04 §4). */
export function answerHmac(letterId: string, raw: string): Buffer {
  return hmacSha256(env.ANSWER_KEY, letterId + normalizeAnswer(raw));
}

/**
 * 입력한 답이 저장된 해시들 중 하나와 맞는가.
 *
 * - 비교는 **상수 시간**이다 (05-api §2 · S-6).
 * - **어느 쪽에 맞았는지 돌려주지 않는다.** 반환값은 boolean 하나고, 여기서 로그도
 *   남기지 않는다. 원본이냐 변형이냐가 새면 정답 근접도가 새는 것과 같다.
 * - 첫 일치에서 빠져나오지 않는다. 빠져나오면 비교 횟수가 곧 "몇 번째에서 맞았는지"라
 *   같은 정보가 시간으로 샌다.
 */
export function matchesAnswer(
  letterId: string,
  raw: string,
  stored: Buffer,
  variants: Buffer[],
): boolean {
  const candidate = answerHmac(letterId, raw);
  let matched = 0;
  for (const hash of [stored, ...variants]) {
    matched |= constantTimeEqual(candidate, hash) ? 1 : 0;
  }
  return matched === 1;
}
