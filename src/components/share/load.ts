// OG 카드의 데이터 접근 — 05-api §2 「상태별 표면 응답」 · §6 「킬 스위치 확인 위치」.
//
// **read.ts의 `loadLetter`를 그대로 쓴다.** 여기서 쿼리를 새로 쓰면 상태 필터가 두 벌이
// 되고, 그게 read.ts 상단이 "킬 스위치나 상태 필터가 한쪽에만 반영되는 날"이라고 쓴
// 사고다. `hidden_auto`·`hidden_admin`·`deleted_by_author`가 404인 것도,
// `public_read_enabled = false`에서 편지를 **조회조차 하지 않는** 것도 전부 그 함수의
// 동작이고 이 파일은 결과를 카드 내용으로 옮기기만 한다.

import { loadLetter } from "@/lib/letters/read";
import { type CardContent, cardContent } from "./card";

export type OgLoad =
  | { state: "disabled" }
  | { state: "not_found" }
  | { state: "card"; content: CardContent };

export async function loadOgCard(
  id: string,
  options: { fpHash: Buffer },
): Promise<OgLoad> {
  // **해제 쿠키를 넘기지 않는다.** OG 카드는 스크레이퍼가 가져가는 공개 이미지라
  // 요청자가 누구든 같은 그림이어야 하고, 쿠키를 실으면 이미 연 사람의 요청에서
  // 잠긴 편지가 본문 카드로 렌더된다 — 그 순간 안전 테스트 #2가 뚫린다.
  const load = await loadLetter(id, { unlockId: null, fpHash: options.fpHash });

  if (load.state === "disabled") return { state: "disabled" };
  if (load.state === "not_found") return { state: "not_found" };
  return { state: "card", content: cardContent(load.letter) };
}
