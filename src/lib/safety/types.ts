// 등급 판정 경계의 타입. 층 1(정규식·사전)과 층 2(LLM 분류기)가 이 형태로만 대화하고,
// 합치는 규칙은 grade.ts 한 곳에 있다.
//
// `FLAG_KINDS`·`FLAG_FIELDS`의 값 집합은 05-api §1의 분류기 JSON 스키마와 **정확히 같다.**
// 여기서 값을 하나 더하면 분류기 스키마와 `letters.risk_flags`가 동시에 어긋난다.
//
// **2026-08-16 · D-033으로 `SENSITIVE_KINDS` 7개가 늘었다.** 05-api §1의 kind 목록에
// 같은 7개를 더해야 문서와 코드가 다시 맞는다 — 그 문서는 이 작업의 범위 밖이라 여기
// 적어둔다. 저장 쪽은 어긋나지 않는다: 이 7개는 전부 `high`라 `letters`에 닿지 않고
// (grade.ts · 04 §2), `risk_flags`는 jsonb라 값 제약이 DB에 없다.

export type RiskLevel = "low" | "medium" | "high";

/**
 * 플래그 종류. **런타임 배열이 단일 출처다.** 분류기(층 2)의 JSON 스키마 enum을 이
 * 배열에서 만든다 — 타입은 런타임에 없으므로 값으로 된 출처가 없으면 목록이 여기와
 * 분류기 스키마 두 곳에 복제되고 반드시 갈라진다. 갈라지면 분류기가 우리가 모르는
 * kind를 돌려주거나, 우리가 정의한 kind를 분류기가 못 쓴다.
 *
 * `contact`(전화·이메일·SNS·주소)와 `url`(URL·QR)은 **층 1이 내는 값**이다. 02 §2는
 * 이 둘을 `high`로 규정하는데 원래 목록은 층 2 분류기 출력만 보고 만들어져서 층 1이
 * 잡는 것을 표현할 자리가 없었다. flags가 비면 02 §3의 "무엇이 걸렸는지 정확히
 * 알려준다"를 차단 화면이 지킬 수 없다 (2026-08-14 코디네이터 승인).
 */
/**
 * D-033의 민감정보 7범주. **`FLAG_KINDS`의 부분집합이고, 아래에서 스프레드로 합친다** —
 * 목록을 두 번 적으면 한쪽만 늘어나는 날이 온다.
 *
 * ── 왜 하나로 묶지 않고 일곱으로 쪼갰나 ─────────────────────
 *
 * 1. **차단 화면이 범주 이름을 말해야 한다** (02 §3). 이 플래그는 전부 `high`라 화면은
 *    차단 화면이고, 거기서 "민감한 정보가 있습니다"만 뜨면 작성자는 어느 문장을 고쳐야
 *    할지 모른 채 우회만 배운다. 라벨은 kind마다 하나이므로(flag-copy.ts) 범주를
 *    말하려면 kind가 범주여야 한다.
 * 2. **D-033이 적어둔 7범주와 1:1이라 문서와 눈으로 대조된다.** 법령이 정한 열거라
 *    나중에 범주가 늘거나 빠지면 목록끼리 맞대보면 끝난다.
 * 3. **쪼개는 비용이 낮다.** 일곱 중 어디로 붙든 판정은 똑같이 `high`다(grade.ts).
 *    경계가 애매한 값(예: 성병 — 건강이자 성생활)을 모델이 다른 칸에 넣어도 결과는
 *    바뀌지 않고 화면 문구만 조금 덜 맞는다. 즉 이 분류는 **판정이 아니라 문구를**
 *    가른다.
 *
 * 반대로 묶었을 때 얻는 것은 enum 한 칸뿐이다. 그 값에 판정이 걸려 있지 않다.
 */
export const SENSITIVE_KINDS = [
  "sensitive_health",
  "sensitive_sexlife",
  "sensitive_belief",
  "sensitive_politics",
  "sensitive_biometric",
  "sensitive_crime",
  "sensitive_ethnicity",
] as const;

export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

export const FLAG_KINDS = [
  "person_name",
  "school",
  "company",
  "place_time_combo",
  "self_harm",
  "sexual_minor",
  "threat",
  "contact",
  "url",
  // D-033의 7개 범주를 **끝에 붙인다.** 앞에 끼우면 `byKindOrder`(layer1.ts)가 쓰는
  // 인덱스가 통째로 밀려 기존 `risk_flags` 출력 순서가 바뀐다.
  ...SENSITIVE_KINDS,
] as const;

export type FlagKind = (typeof FLAG_KINDS)[number];

/** 어느 칸에 있었는가. 필드가 등급을 가른다 (D-016). */
export const FLAG_FIELDS = ["body", "hint", "question"] as const;

export type FlagField = (typeof FLAG_FIELDS)[number];

export interface Flag {
  kind: FlagKind;
  field: FlagField;
}

export type LetterMode = "open" | "locked";
export type Relationship = "ex" | "friend" | "family" | "coworker" | "other";

/** 아직 저장되지 않은 편지. 판정과 `contentHash`의 입력이다 (05-api §1 · §2). */
export interface LetterDraft {
  mode: LetterMode;
  relationship: Relationship;
  body: string;
  hint?: string;
  question?: string;
  answer?: string;
}

/** 층 1 — 로컬 실행이라 실패 경로가 없다 (D-015). */
export interface Layer1Result {
  risk: RiskLevel;
  flags: Flag[];
}

/**
 * 층 2 — 세 가지로만 끝난다.
 *
 * - `ok`          정상 판정. `notice`는 인터스티셜 한 문장 (05-api §1)
 * - `refusal`     모델 거부 → `high`. **장애가 아니다** (05-api §1 · D-020)
 * - `unavailable` 타임아웃·네트워크·비용 상한 → `medium` 강등 (D-015)
 */
export type ClassifierOutcome =
  | { state: "ok"; risk: RiskLevel; flags: Flag[]; notice?: string }
  | { state: "refusal" }
  | { state: "unavailable"; reason: string };
