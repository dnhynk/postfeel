// 걸린 항목을 사람 말로 옮긴다 (02 §3 · 05-api §1).
//
// 원칙은 위협 모델 §3 그대로다:
//   · **무엇이 걸렸는지 정확히 알려준다.** "부적절한 표현" 같은 모호한 문구는 우회
//     학습만 시킨다
//   · 규칙 위반이 아니라 **결과**를 말한다 — "다른 사람도 알아본다"
//
// 인터스티셜 문구는 원래 분류기가 준 `notice`를 쓴다(05-api §1). 여기 있는 것은
// **`notice`가 없을 때의 폴백**이다 — 층 2가 죽었거나, 층 1만으로 판정됐거나,
// notice가 본문을 인용해 서버가 버린 경우. 그때도 위 원칙은 지켜야 한다.

import type { Flag, FlagField, FlagKind } from "@/lib/safety/types";

/**
 * 04 §2 `risk_flags`의 kind (05-api §1의 `FLAG_KINDS`).
 *
 * **Record로 둔다.** 목록에 kind가 하나 늘면 여기서 컴파일이 깨진다 — 라벨이 없는
 * 플래그는 화면에서 조용히 사라지고, 그러면 02 §3의 "무엇이 걸렸는지 정확히
 * 알려준다"를 못 지킨 채 아무도 모른다.
 *
 * `contact`·`url`은 층 1이 내는 값이다 (02 §2 · 05-api §1).
 */
const FLAG_LABEL: Record<FlagKind, string> = {
  person_name: "사람 이름으로 보이는 표현",
  school: "학교 이름으로 보이는 표현",
  company: "회사 이름으로 보이는 표현",
  place_time_combo: "장소와 시기를 함께 가리키는 표현",
  self_harm: "자해를 암시하는 표현",
  sexual_minor: "미성년자를 대상으로 한 성적 표현",
  threat: "협박으로 읽힐 수 있는 표현",
  contact: "연락처로 보이는 표현",
  url: "링크로 보이는 표현",
  // D-033의 7범주. 문장 틀이 `${field}에 ${label}이 있습니다.`라 라벨은 전부 `표현`으로
  // 끝나야 조사가 맞는다.
  //
  // **"다른 사람의"를 라벨마다 붙인다.** 이 kind는 작성자 본인 이야기에는 붙지 않으므로
  // (prompt.ts), 그 조건을 문구가 말해주지 않으면 자기 이야기를 쓴 사람이 무엇을 고쳐야
  // 할지 알 수 없다.
  //
  // 범주 이름은 D-033의 열거를 그대로 쓰되 **`성적 피해`는 화면에 옮기지 않는다** —
  // 걸린 사람에게 피해 사실을 되읽히는 문구가 되고, 어느 문장이 걸렸는지는 `성생활·성적
  // 지향`만으로도 짚인다.
  sensitive_health: "다른 사람의 건강·질병에 관한 표현",
  sensitive_sexlife: "다른 사람의 성생활·성적 지향에 관한 표현",
  sensitive_belief: "다른 사람의 사상·신념·종교에 관한 표현",
  sensitive_politics: "다른 사람의 정치적 견해·정당·노동조합 가입에 관한 표현",
  sensitive_biometric: "다른 사람의 유전정보·생체인식정보에 관한 표현",
  sensitive_crime: "다른 사람의 범죄경력·수사·재판에 관한 표현",
  sensitive_ethnicity: "다른 사람의 인종·민족에 관한 표현",
};

/** 화면의 입력란 이름과 같은 말을 쓴다. 어느 칸을 고쳐야 하는지 바로 알아야 한다. */
const FIELD_LABEL: Record<FlagField, string> = {
  body: "본문",
  hint: "단서",
  question: "질문",
};

/** `본문에 학교 이름으로 보이는 표현이 있습니다.` — 02 §3 예시와 같은 문장이다. */
export function flagSentences(flags: readonly Flag[]): string[] {
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const flag of flags) {
    const label = FLAG_LABEL[flag.kind];
    const field = FIELD_LABEL[flag.field];
    if (!label || !field) continue;
    const sentence = `${field}에 ${label}이 있습니다.`;
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    sentences.push(sentence);
  }
  return sentences;
}

/**
 * 결과를 말하는 한 줄 (02 §3의 인터스티셜 예시 마지막 문장).
 *
 * 규칙 위반("금지된 표현입니다")이 아니라 결과를 말한다.
 */
export const CONSEQUENCE =
  "이대로 올리면 이 편지를 본 다른 사람도 그 사람이 누구인지 알아볼 수 있습니다.";

/**
 * 플래그가 하나도 없을 때.
 *
 * 분류기가 거부(refusal)하면 차단이지만 말할 플래그가 없다(05-api §1). 그때
 * "부적절한 표현이 있습니다"라고 지어내면 §3의 원칙을 정면으로 어긴다 — 무엇이
 * 걸렸는지 모르면서 아는 척하는 것이고, 사용자는 무엇을 고쳐야 할지 모른 채 우회만
 * 배운다. 그래서 **모른다는 사실을 그대로 말한다.**
 */
export const UNKNOWN_REASON =
  "무엇이 걸렸는지 자동으로 확인하지 못했습니다.";

/** `flags`에 `self_harm`이 있으면 위기 상담 안내를 함께 띄운다 (D-026 · 03 §1-6-1). */
export function hasSelfHarm(flags: readonly Flag[]): boolean {
  return flags.some((flag) => flag.kind === "self_harm");
}
