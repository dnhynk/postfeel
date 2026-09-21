# 분류기 평가셋

출시 게이트의 "분류기 동작" 판정 도구다. 기준 전문은
[08-milestones.md 「"분류기 동작"의 합격 기준」](../docs/08-milestones.md).

> 층 2 모델은 미정이다([D-029](../docs/00-decisions.md) ·
> [O-009](../docs/o-009-classifier-candidates.md)).

> **공개 저장소에서는 실서비스 평가셋을 제외했다.** 위험·정상 사례와 층 1 탐지 기대값은
> 필터를 우회하는 지도가 되므로 비공개다. `dataset.ts`에는 형식을 보여주는 가상 예시 두
> 건만 있다.

```bash
npm run eval
```

**`OPENAI_API_KEY`와 Postgres가 둘 다 필요하다.** 키는 `classify()`가 쓰고, DB는
`budget.ts`의 일일 상한 조회·누적(`app_settings`)이 쓴다. DB가 없으면 `checkBudget`이
실패해 전 건이 `unavailable` → D-015 강등 → `medium`이 되고, 재현율 1.0 · 오탐율
1.0이라는 무의미한 숫자가 나온다.

> **`층 2 상태` 칸의 `unavailable`이 0이 아닌 실행은 게이트 판정으로 쓰지 않는다.**

## 파일

| | |
|---|---|
| `dataset.ts` | 정답 라벨 · 유형 · `layer1Catchable`의 형식. 공개본은 가상 예시 2건 |
| `run.ts` | 러너. 파이프라인을 그대로 부르고 층별로 집계한다 |
| `resolve.ts` | `node`가 `src/`의 확장자 없는 import를 따라가게 하는 해석 훅 |

## 재는 방법

측정 대상은 **층 1 + 층 2 파이프라인 전체**다. `runLayer1` → `classify` → `grade`를
제출 경로와 같은 함수로 부른다. 판정 규칙을 러너가 다시 구현하지 않는다 — 다시
구현하면 재는 대상이 파이프라인이 아니라 그 복제본이 된다.

**"탐지"는 판정 등급이 `medium` 이상인 것이다.** 오탐도 같은 기준이다.

층을 가르는 방법은 같은 편지를 두 번 판정하는 것이다.

| | |
|---|---|
| 층 1 단독 | `grade(layer1, { state: 'ok', risk: 'low', flags: [] })` |
| 전체 | `grade(layer1, classify(draft))` |

층 1 단독이 이미 `medium` 이상이면 층 1이 잡은 것이고, 아니면서 전체가 `medium`
이상이면 층 2가 잡은 것이다. `unavailable`로 인한 `medium`은 **세 번째 칸**으로 뺀다 —
D-015의 강등 경로는 장애 시 편지를 통과시키는 장치라 그대로 세면 장애가 곧 만점
재현율이 된다(전건 `medium` → 재현율 1.0 · 오탐율 1.0). 탐지력이 아니다.
