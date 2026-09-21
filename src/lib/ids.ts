// 공개 식별자. `letters.id`와 `unlocks.unlock_id`가 이걸 쓴다 (04 §1-1 · §2).
//
// **순차 ID를 쓰지 않는다.** 위험 등급 medium 편지는 피드에 뜨지 않고 링크로만
// 접근되는데, ID가 순차면 누구나 /m/1부터 훑어서 그 편지를 전부 수집할 수 있다.
// 그러면 "medium = 링크로만" 방어가 통째로 무너진다 (04 §1-1 · §5 발견 1).
//
// 라이브러리 대신 node:crypto를 쓰는 이유: nanoid의 기본 알파벳은 64자
// (A-Za-z0-9_-)이고 base64url의 문자 집합과 같다. randomBytes를 base64url로
// 인코딩하면 문자 하나가 정확히 6비트를 받아 편향이 없다 — 길이·문자셋·엔트로피가
// nanoid(22)와 같다(22자 × 6비트 = 132비트). tests/fixtures/letters.ts가 이미 같은
// 방식을 쓰고 있어 구현도 하나로 맞춘다.

import { randomBytes } from "node:crypto";

/** 04 §1-1이 정한 길이. */
export const ID_LENGTH = 22;

/** 22자를 채우려면 132비트가 필요하다. 17바이트 = 136비트. */
const ID_BYTES = 17;

/** 추측 불가능한 공개 ID 한 개 (04 §1-1). */
export function newId(): string {
  return randomBytes(ID_BYTES).toString("base64url").slice(0, ID_LENGTH);
}
