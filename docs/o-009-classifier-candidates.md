# O-009 · 층 2 모델 후보 조사

[D-029](./00-decisions.md)(층 2를 국내 리전 모델로)가 방향을 정했고, 이 문서는 **후보를 걸러낸 근거**다. 최종 선정은 [M7-1](./08-milestones.md)의 실측으로 한다 — 여기서 정하지 않는다.

조사일 **2026-08-16**. 벤더 문서는 바뀐다. **선정 직전에 다시 확인한다.**

---

## 1. 판정 기준

순서대로 적용한다. 앞 관문에서 떨어지면 뒤는 보지 않는다.

| # | 관문 | 왜 |
|---|---|---|
| 1 | **추론이 국내에서 도는가** | [D-034](./00-decisions.md). 저장 위치가 아니라 **처리 위치**다 |
| 2 | JSON 스키마 강제 출력 | [05-api §1](./05-api.md)이 요구한다. 자유 텍스트 파싱으로 대체하지 않는다 |
| 3 | 지연이 3초 예산에 들어오는가 | [05-api §1](./05-api.md) |
| 4 | 재현율·오탐율 | 평가셋 v2 ([M7-3](./08-milestones.md)) |

**1번을 맨 앞에 두는 이유**: 2~4를 먼저 재고 1번에서 떨어지면 그 측정이 통째로 버려진다. `gpt-5.6-luna`에서 실제로 그렇게 됐다.

> ### 이 조사에서 두 번 걸린 함정
>
> **"데이터 레지던시 지원"도 "국내 기업"도 관문 1의 답이 아니다.** 저장(at rest)만 국내이고 추론은 해외일 수 있고(§2 탈락 1), 한국 회사가 해외 클라우드에 추론을 위탁할 수 있다(§2 탈락 2). 둘 다 실제로 나왔다.
>
> 관문 1은 **벤더의 문서에서 "추론/처리가 어디서 일어나는가"라는 문장을 직접 찾아** 판정한다.

---

## 2. 후보별 결과

| 후보 | 관문 1 (추론 위치) | 판정 |
|---|---|---|
| **Azure OpenAI · Korea Central** | `Standard`(단일 리전) SKU면 **배포 리전에서 처리** | **후보** |
| **NAVER CLOVA Studio · HCX-007** | 국내 클라우드. 문서로 재확인 필요 | **후보** |
| OpenAI 직접 (`gpt-5.6-luna` 현행) | **추론은 미국** | **탈락** |
| Upstage Solar | **추론을 미국에 위탁** | **탈락** |
| AWS Bedrock · 서울 | 최신 모델이 CRIS로 타 리전 경유 | **조건부 탈락** |

### 탈락 1 · OpenAI 직접 — 한국 레지던시로 해결되지 않는다

한국을 포함한 데이터 레지던시를 제공하지만 **저장 데이터에만 적용된다.** 확장은 *"only targeted for data that is stored or is at rest and not data that is being used for inference by a model, whose default location continues to be the US"*이고, 프롬프트는 *"temporarily processed on US-based infrastructure"*를 거친다.

→ 저장 위치를 옮겨도 **편지 본문이 미국에서 처리된다.** [D-034](./00-decisions.md)가 국외 이전에 처리를 포함시켰으므로 이 경로는 닫힌다.

### 탈락 2 · Upstage Solar — 한국 회사인데 추론이 미국이다

한국(용인) 소재 기업이고 `response_format: {"type":"json_schema"}`를 지원해 관문 2는 통과한다. 그러나 **자사 개인정보처리방침의 국외이전 표**가 관문 1에서 떨어뜨린다:

| 수탁자 | 국가 | 목적 |
|---|---|---|
| Amazon Web Services | 미국 | 시스템 운영·데이터 보관·**모델 추론** |
| Fireworks.ai | 미국 | **모델 추론** |
| RunPod | 미국 | **추론 서비스** |
| Tavily | 미국 | 추론 서비스 |

→ 별도 온프레미스/전용 계약(Neurocloud 등)으로 국내 추론이 가능한지는 따로 협의할 문제이고, 공개 API 기준으로는 탈락이다.

### 조건부 탈락 3 · AWS Bedrock 서울

Bedrock 자체는 서울 리전(`ap-northeast-2`)에서 쓸 수 있으나, **최신 모델은 서울에서 직접 호출되지 않고 Cross-Region Inference(CRIS)가 필요**하다는 보고가 있다. CRIS는 정의상 **다른 리전에서 추론한다** → 관문 1 탈락.

→ 서울에서 **CRIS 없이 직접 호출되는** 모델 중 한국어 판정에 쓸 만한 것이 있으면 후보로 돌아온다 (§5 #3).

---

## 3. 후보 A · Azure OpenAI (Korea Central + `Standard`)

**관문 1 — 통과. 1차 문서에 명시돼 있다.** [Microsoft Learn 「Understanding deployment types」](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types) (2026-08-12 갱신):

> **Data residency for all deployment types**: Data stored at rest remains in the designated Azure geography. However, **inferencing data is processed as follows**:
> - **Global** types: May be processed in **any Azure region**
> - **Data Zone** types: … only within the Microsoft-specified data zone (US, EU, or **Asia Pacific (APAC)**)
> - **Standard (single region)** types: The service **processes data in the deployment region**.

**SKU를 정확히 골라야 한다.**

| SKU | 처리 위치 | 우리에게 |
|---|---|---|
| `GlobalStandard` | 임의의 Azure 리전 | **안 된다** |
| `DataZoneStandard` | APAC 데이터 존 | **안 된다** — APAC은 일본·호주 등을 포함한다. 국내가 아니다 |
| **`Standard`** | **배포 리전** | **이것만 된다** |

> **기본값이 함정이다.** 문서는 *"For most workloads, start with Global Standard"*라고 권한다. 그대로 따르면 관문 1을 조용히 어긴다. **`Standard`를 명시적으로 골라야 한다.**

**남은 위험 — 모델이 그 SKU로 Korea Central에 있는가.** 같은 문서가 경고한다:

> New deployment types become available in a set order: Global, then Data Zone, then single region. **Single-region deployment types arrive last, have no guaranteed availability date**, and depend on capacity that frees up as older models retire.

즉 **최신 모델일수록 `Standard`로 못 쓸 가능성이 높다.** 또 *"Models available in each region and throughput might be limited"*이고 `Standard`는 *"low-to-medium volume workloads"*용이다.

배포 가능한 모델과 쿼터 확인(§5 #2)은 Azure 포털의 Foundry → 배포 대화상자에서 리전·배포 타입으로 필터해서 한다 — 계정이 있어야 한다.

---

## 4. 후보 B · NAVER CLOVA Studio (HCX-007)

**관문 2 — 통과.** [Structured Outputs](https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3-so)를 `responseFormat`으로 지원한다.

```json
{ "responseFormat": { "type": "json", "schema": { "type": "object", "properties": { … } } } }
```

**제약 둘을 지금 기록해 둔다.**

1. **Structured Outputs는 HCX-007에서만 된다.** 모델 선택지가 사실상 하나로 고정된다
2. **동시 사용 불가** — 이미지 입력 · 튜닝 · Function calling · Structured Outputs · **thinking**을 함께 쓸 수 없다. 요청마다 하나만 지정한다

2번이 우리 설계에 닿는다. 현행 층 2는 **effort `none`으로 돈다**([05 §1](./05-api.md) 실측: `none` 1,618ms · `low` 4,397ms). 스키마 강제 출력과 thinking을 함께 못 쓴다면 **thinking 없이 가는 쪽이 원래 우리 선택과 같다** — 제약이 아니라 확인이다. 다만 재현율이 모자라 "effort를 올려 재측정"하는 [등급 사다리](./08-milestones.md)의 다음 칸이 **막힌다.** 그때는 모델을 바꾸는 수밖에 없다.

**관문 1 — 확인 필요(§5 #1).** NAVER Cloud Platform은 국내 리전을 가진 국내 사업자라 국내 추론일 가능성이 높지만, **Upstage 사례가 있으므로 추정하지 않는다.**

---

## 5. 남은 확인 — 선정 전에 답이 있어야 하는 것

| # | 질문 | 어떻게 |
|---|---|---|
| 1 | CLOVA Studio의 **추론 수행 위치**가 국내라고 문서·계약에 적혀 있는가 | NCP 문의 · 이용약관·위탁 문서 |
| 2 | Korea Central에서 **`Standard` SKU로 배포 가능한 모델**과 쿼터 | Azure 포털 (계정 필요) |
| 3 | Bedrock 서울에서 **CRIS 없이 직접 호출**되는 모델 중 쓸 만한 것 | AWS 리전별 모델 지원 문서 |
| 4 | 두 후보의 **단가와 지연** | 직접 호출로 실측 |
| 5 | **배치 API**가 있는가 | 평가셋을 배치로 돌린다([08](./08-milestones.md)). 없으면 단건으로 돌리고 비용을 다시 본다 |

**4·5는 관문 1이 통과된 후보에만 한다.** 순서를 지킨다.

---

## 6. 선정 절차

```
관문 1 통과 후보만  → 스키마 강제 출력 실제 호출로 확인
                   → 지연 실측 (단발 · 배치)
                   → 평가셋 v2로 재현율·오탐율
                   → 층별 집계로 "층 2가 자기 몫을 하는가" 확인
```

**마지막 줄이 핵심이다.** `gpt-5.6-luna`는 인명 6/6 · 조합 5/5를 잡았고 층 1은 둘 다 0이었다([`eval/README.md`](../eval/README.md)). 새 모델이 **그 자리를 대체하지 못하면 층 2를 바꾼 의미가 없다** — 국외 이전만 사라지고 방어는 없어진다. 전체 재현율만 보면 이 구멍이 가려진다는 것이 [08이 층별 집계를 요구한 이유](./08-milestones.md)다.

**대체하지 못하는 결과가 나오면 D-029로 돌아간다.** 그때는 국내 추론이 가능한 다른 경로(전용 계약 · 국내 GPU 자체 호스팅)를 재검토하는 것이지, 기준을 낮추는 것이 아니다.
