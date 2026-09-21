// 공개 저장소에서는 실서비스 규칙을 제외했다.
//
// 사전 매칭. 실서비스의 경계 판정 규칙은 포함하지 않았고, 아래는 단순 포함 검사다.

import type { DetectionText } from "../normalize";
import { COMPANIES } from "./companies";
import { SCHOOLS } from "./schools";

export { COMPANIES, SCHOOLS };

export interface DictionaryHit {
  kind: "school" | "company";
  /** 어떤 항목이 걸렸는가. 테스트·디버깅용이고 **저장되지 않는다**. */
  entry: string;
}

function findEntry(text: string, entries: readonly string[]): string | undefined {
  return entries.find((entry) => text.includes(entry));
}

/** 원문과 정규화본 양쪽에서 본다. */
export function findDictionaryHits(text: DetectionText): DictionaryHit[] {
  const hits: DictionaryHit[] = [];

  const school = findEntry(text.nfc, SCHOOLS) ?? findEntry(text.alnum, SCHOOLS);
  if (school !== undefined) hits.push({ kind: "school", entry: school });

  const company =
    findEntry(text.nfc, COMPANIES) ?? findEntry(text.alnum, COMPANIES);
  if (company !== undefined) hits.push({ kind: "company", entry: company });

  return hits;
}
