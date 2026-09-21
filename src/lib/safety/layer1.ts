// 층 1 — 정규식 + 사전 (연락처 · URL · 학교 · 회사). 로컬 실행이라 실패 경로가 없다
// (D-015 · 05-api §1). 여기서는 네트워크를 타지 않고 **예외를 던지지 않는다** — 문자열
// 연산과 정규식뿐이라 던질 자리가 없다.
//
// 규칙은 patterns.ts(정규식) · dictionaries/(학교·회사) · normalize.ts(우회 정규화)에
// 나뉘어 있고, 이 파일은 **필드를 돌며 합치기만 한다.**
//
// ── 여기서 하지 않는 것 두 가지 ─────────────────────────────
//
// 1. **한국어 인명을 추측하지 않는다.** 정규식으로 되지 않아서 층 2를 둔 것이고
//    (02 S-2 · D-020), 여기서 시도하면 오탐이 폭증해 02 §2가 등급을 셋으로 나눈 이유가
//    무너진다.
//
// 2. **D-016(어느 칸이면 어느 등급인가)을 여기서 적용하지 않는다.** 학교·회사 플래그는
//    `field`만 정확히 채워 넘기고 등급 판정은 grade.ts의 `fieldRule` 한 곳에서 한다.
//    같은 규칙이 두 파일에 있으면 한쪽만 고쳐진다. 연락처·URL은 다르다 — 02 §2가 칸과
//    무관하게 `high`로 정했고 grade.ts가 알 수 없는 판단이라 여기서 `risk`에 반영한다.
//
// `answer`는 보지 않는다. 05-api §1이 "답은 등급 판정 대상이 아니"라고 못 박았고,
// `FlagField`에도 `answer`가 없다 (04 「저장하지 않는 것」).

import { findDictionaryHits } from "./dictionaries/match";
import { detectionText } from "./normalize";
import { findPatternHits } from "./patterns";
import { FLAG_KINDS } from "./types";
import type {
  Flag,
  FlagField,
  FlagKind,
  Layer1Result,
  LetterDraft,
  RiskLevel,
} from "./types";

/** 공개되는 칸 셋. 셋 다 카드에 뜬다 (03 §1-4: 단서·질문 옆에 "모두에게 보입니다"). */
const SCANNED_FIELDS: readonly FlagField[] = ["body", "hint", "question"];

/** 02 §2 — 연락처·URL은 칸과 무관하게 `high`다. S-2: "여기는 등급이 아니라 게시 자체를 막는다". */
const ALWAYS_HIGH: readonly FlagKind[] = ["contact", "url"];

/** 출력 순서를 고정한다 — `risk_flags`가 그대로 저장되고 테스트가 이 순서를 본다. */
function byKindOrder(a: Flag, b: Flag): number {
  return FLAG_KINDS.indexOf(a.kind) - FLAG_KINDS.indexOf(b.kind);
}

export function runLayer1(draft: LetterDraft): Layer1Result {
  const flags: Flag[] = [];
  let risk: RiskLevel = "low";

  for (const field of SCANNED_FIELDS) {
    const raw = draft[field];
    if (raw === undefined || raw === "") continue;

    // 필드당 한 번만 정규화하고 패턴·사전이 나눠 쓴다.
    const text = detectionText(raw);

    const kinds = new Set<FlagKind>();
    for (const hit of findPatternHits(text)) kinds.add(hit.kind);
    for (const hit of findDictionaryHits(text)) kinds.add(hit.kind);

    const fieldFlags: Flag[] = [];
    for (const kind of kinds) {
      fieldFlags.push({ kind, field });
      if (ALWAYS_HIGH.includes(kind)) risk = "high";
    }
    flags.push(...fieldFlags.sort(byKindOrder));
  }

  return { risk, flags };
}
