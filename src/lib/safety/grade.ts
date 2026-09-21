// 층 1 결과와 층 2 결과를 합쳐 최종 등급을 낸다. **순수 함수다** — DB도 네트워크도
// 없다. 규칙은 전부 문서에서 그대로 왔고, 규칙마다 단위 테스트가 붙어 있다
// (tests/lib/safety-grade.test.ts).
//
// 이 파일이 합치는 자리를 독점하는 이유: 같은 규칙이 표면마다 흩어지면 한 곳만
// 고쳐지고 나머지가 남는다. 등급이 갈리는 판단은 여기서만 한다.

import { SENSITIVE_KINDS } from "./types";
import type {
  ClassifierOutcome,
  Flag,
  FlagKind,
  Layer1Result,
  RiskLevel,
} from "./types";

/**
 * 판정 결과. 05-api §1의 세 응답과 1:1로 대응한다.
 *
 * | action    | 응답 | `filter_events.outcome` | 저장 |
 * |---|---|---|---|
 * | `block`   | 200 `{ status: 'blocked' }`            | `blocked`   | **안 함** |
 * | `confirm` | 200 `{ status: 'needs_confirmation' }` | `warned`    | 아직 안 함 |
 * | `create`  | 201 `{ status: 'created' }`            | `published` | 함 |
 *
 * `block`에 `confirmation`을 발급하지 않는다 — 클라이언트를 조작해도 통과 경로가
 * 없다 (05-api §1 · 안전 테스트 3).
 *
 * `confirm`은 분류기가 `ok`일 때만 나오므로, 재제출로 실제 생성될 때의
 * `classifier_state`는 항상 `'ok'`다.
 */
export type Decision =
  | { action: "block"; risk: "high"; flags: Flag[] }
  | { action: "confirm"; risk: "medium"; flags: Flag[]; notice?: string }
  | {
      action: "create";
      risk: "low" | "medium";
      flags: Flag[];
      classifierState: "ok" | "unavailable";
    };

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function maxRisk(...risks: RiskLevel[]): RiskLevel {
  return risks.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a), "low");
}

/**
 * D-016 — 같은 표현이라도 **어느 칸에 썼는가**로 등급이 갈린다.
 *
 * 학교·회사가 단서(`hint`)·질문(`question`)에 있으면 `high`, 본문(`body`)에 있으면
 * `medium`. 단서 입력란은 "알아보게 하라"는 목적을 가진 칸이라(D-011), 여기 소속이
 * 들어가면 그 자체로 특정 장치가 완성된다.
 *
 * **`question`도 `hint`와 같이 `high`다** (2026-08-14 사용자 확인 · D-016에 절 추가).
 * 원래 문서는 이 칸을 정하지 않았고 이 자리에는 "임의로 넓히지 않는다"는 주석이 있었다.
 * 물어서 정한 근거는 둘이다 — ① 질문도 카드에 그대로 노출되고(03 §1-4 "모두에게
 * 보입니다") `OO고 3반에서 내 짝꿍 이름은?`처럼 단서와 같은 정도로 대상을 좁힌다.
 * ② `medium`은 '피드 제외'인데 B 모드 편지는 애초에 공유 링크로 유통되므로 피드 제외가
 * 실질 방어가 못 된다. 질문 칸만 `medium`이면 소속을 그리로 옮기는 우회로가 생긴다.
 */
function fieldRule(flags: Flag[]): RiskLevel {
  let risk: RiskLevel = "low";
  for (const flag of flags) {
    if (flag.kind !== "school" && flag.kind !== "company") continue;
    if (flag.field === "hint" || flag.field === "question") {
      risk = maxRisk(risk, "high");
    } else if (flag.field === "body") {
      risk = maxRisk(risk, "medium");
    }
  }
  return risk;
}

const SENSITIVE: ReadonlySet<FlagKind> = new Set(SENSITIVE_KINDS);

/**
 * D-033 — **식별 가능한 제3자 + 민감정보 = 무조건 `high`.**
 *
 * 칸도 보지 않고 분류기가 준 `risk`도 보지 않는다. 민감정보 플래그가 하나라도 있으면
 * `high`다. 이유는 셋이다.
 *
 * ① D-033이 "작성자가 그대로 게시하도록 허용하지 않는다"고 못박았다. `medium`이면
 *    인터스티셜에 `이대로 올리기`가 붙고(02 §3), 그 순간 편지 작성자의 동의가 편지에
 *    언급된 제3자의 동의를 대신하게 된다 — M0 답 Q4-a가 정면으로 부정한 것이다.
 * ② **`medium`은 방어가 아니다.** 실제 처리는 '피드 제외'인데 B 모드 편지는 원래 공유
 *    링크로 유통된다(D-016 · 02 §2). 민감정보가 걸린 편지가 링크로 도는 것은 막히는
 *    게 아무것도 없다는 뜻이다.
 * ③ **판단이 불가능해도 게시하지 않는다** (D-033). 그래서 "식별 가능한가"를 여기서 다시
 *    재지 않는다 — 인명·소속 플래그가 함께 왔는지로 조건을 걸면 이름 없이 `너`·`그 사람`
 *    으로만 지목한 편지가 전부 빠져나간다. 식별 가능성 판단은 프롬프트에서 한 번만 하고
 *    (애매하면 낸다), 플래그가 왔다는 것은 이미 그 판단을 통과했다는 뜻이다.
 *
 * `fieldRule`과 나란히 두는 이유도 같다: 등급이 갈리는 판단은 grade.ts 한 곳에서 한다.
 * 모델이 `risk: 'low'`를 주더라도 이 규칙이 이긴다.
 */
function sensitiveRule(flags: Flag[]): RiskLevel {
  return flags.some((flag) => SENSITIVE.has(flag.kind)) ? "high" : "low";
}

export function grade(
  layer1: Layer1Result,
  classifier: ClassifierOutcome,
): Decision {
  // 층 1 플래그에도 D-016을 적용한다. 층 1이 학교·회사를 사전으로 잡으므로
  // (D-015 표) 판정은 이 자리에 있어야 한다.
  // 민감정보도 같이 본다 — 층 1은 지금 이 kind를 내지 않지만, 규칙을 "어느 층이
  // 냈는가"에 걸어두면 나중에 사전이 붙는 날 조용히 빠진다.
  const layer1Risk = maxRisk(
    layer1.risk,
    fieldRule(layer1.flags),
    sensitiveRule(layer1.flags),
  );

  // ① 층 1이 high면 **분류기 상태와 무관하게** 차단한다
  //    (05-api §1 마지막 문단 · 안전 테스트 13).
  if (layer1Risk === "high") {
    return { action: "block", risk: "high", flags: layer1.flags };
  }

  // ② 거부는 장애가 아니라 위험 신호다 → high (D-020 · 안전 테스트 22).
  //    medium 강등 경로(③)로 흘려보내면 게시된다 — S-4·S-5가 바로 그 카테고리다.
  if (classifier.state === "refusal") {
    return { action: "block", risk: "high", flags: layer1.flags };
  }

  // ③ 분류기 장애 → max(층1, 'medium'), classifier_state='unavailable',
  //    그리고 **인터스티셜을 띄우지 않고 201 즉시 생성**한다 (D-015 · 05-api §1).
  //    말할 플래그가 없는 모호한 경고는 우회 학습만 시키기 때문이다.
  //    §1 흐름의 "medium → 200" 규칙에 대한 유일한 예외이고 안전 테스트 12가 고정한다.
  //
  //    **D-033과 겹치는 자리가 여기다 — 이 작업에서 바꾸지 않았다.** 민감정보를 볼 수
  //    있는 층은 층 2뿐인데(층 1에는 사전이 없다), 층 2가 죽으면 이 경로로 게시된다.
  //    D-033의 "판단이 불가능한 경우에도 게시하지 않는다"를 **분류기 장애까지** 넓혀
  //    읽으면 D-015의 강등 경로 자체가 이 범주에 대해서는 성립하지 않는다. 좁게 읽으면
  //    (민감정보인지·누구 것인지 애매한 경우) 지금 코드가 맞다. 어느 쪽인지는 D-033
  //    본문으로 정해지지 않으므로 여기서 임의로 넓히지 않는다 — 코디네이터 판단이다.
  if (classifier.state === "unavailable") {
    return {
      action: "create",
      risk: maxRisk(layer1Risk, "medium") as "low" | "medium",
      flags: layer1.flags,
      classifierState: "unavailable",
    };
  }

  const flags = [...layer1.flags, ...classifier.flags];
  const risk = maxRisk(
    layer1Risk,
    classifier.risk,
    fieldRule(classifier.flags),
    sensitiveRule(classifier.flags),
  );

  // ④ high는 저장하지 않는다 — filter_events에만 남는다
  //    (04 §3 · 04 「저장하지 않는 것」). 게시 보류는 "다시 쓰세요"이고,
  //    서버에 남기면 그것도 보관이다.
  if (risk === "high") {
    return { action: "block", risk: "high", flags };
  }

  if (risk === "medium") {
    return {
      action: "confirm",
      risk: "medium",
      flags,
      ...(classifier.notice === undefined ? {} : { notice: classifier.notice }),
    };
  }

  return { action: "create", risk: "low", flags, classifierState: "ok" };
}
