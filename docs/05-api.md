# API 명세 (v0)

Next.js App Router Route Handlers. 모든 응답은 JSON.

---

## 1. 위험 등급 판정을 어디서 하는가

[인터스티셜](./03-flows.md)은 제출 **전에** 떠야 하는데, 판정은 서버만 할 수 있다. 순진하게 만들면 분류기가 편지 하나당 두 번 돈다(경고 표시용 1회 + 실제 생성 시 1회).

→ **서명된 판정 토큰**으로 한 번만 돌린다.

```
1. POST /api/letters  { body, hint, question, answer, mode, relationship, ageConfirmed }
2. 서버: 분류 → risk

   risk = low     → 즉시 생성, 201
   risk = medium  → 200 { status: 'needs_confirmation', risk, flags, confirmation, notice? }
   risk = high    → 200 { status: 'blocked', risk, flags }   ← confirmation 없음

3. (medium) 클라이언트가 인터스티셜 표시 → '이대로 올리기'
4. POST /api/letters  { ...같은 payload, confirmation }
5. 서버: 서명 검증 + contentHash 대조 → 등급 재판정 없이 생성
```

**`ageConfirmed`는 `true`가 아니면 400이다** ([D-032](./00-decisions.md)). 검사는 `mode`·본문 검증보다 앞이라 확인 없는 요청은 레이트리밋도 분류기도 타지 않는다 — 비용이 붙기 전에 끊는다. 비교는 엄격 비교라 `"true"`·`1`로 우회되지 않고, 재제출(`confirmation`) 경로도 같은 검증을 지나므로 토큰으로 건너뛸 수 없다.

**`contentHash`에는 넣지 않는다.** 해시는 "경고를 본 그 내용이 맞는가"를 재는 값이고, 연령 확인은 내용이 아니라 매 요청의 조건이다. 넣으면 확인 체크 여부가 재분류 트리거가 된다.

`confirmation` 페이로드:

```ts
{ contentHash: string   // sha256(JSON.stringify([body, hint ?? null, question ?? null, answer ?? null]))
  risk: 'medium'
  flags: Array<{ kind: string, field: 'body' | 'hint' | 'question' }>
  filterEventId: number
  exp: number }         // 발급 후 10분
```

`contentHash`를 넣는 이유: 사용자가 경고를 보고 본문을 고친 뒤 `이대로 올리기`를 누르면 해시가 안 맞고, 그러면 다시 분류한다. 토큰으로 필터를 우회할 수 없다.

**`answer`도 해시에 넣는다.** 빠뜨리면 경고를 본 뒤 답만 갈아끼운 편지가 같은 토큰으로 통과한다. 답은 등급 판정 대상이 아니지만 표기 변형 생성의 입력이라(아래), 1차 판정 때의 답과 실제로 저장되는 답이 다르면 안 된다.

`flags`는 분류기 응답 그대로의 객체 배열이다. 재제출은 등급을 다시 매기지 않으므로 `letters.risk_flags`를 채울 출처가 이 토큰밖에 없다.

`filterEventId`는 1차 판정이 남긴 [`filter_events`](./04-data-model.md) 행이다. 재제출이 오면 그 행을 `warned` → `published`로 올려 **강행률을 서버 측 진실로** 남긴다. 서명 안에 있어 위조할 수 없다.

**단순 문자열 연결을 쓰지 않는다.** `body + hint + question`은 필드 경계가 없어서, 걸린 표현을 본문 끝에서 단서 앞으로 한 글자씩 옮기면 내용이 달라져도 해시가 같다. 그러면 confirmation 하나로 다른 편지를 통과시킬 수 있다. 배열을 직렬화해 경계를 고정한다.

`high`는 `confirmation`을 발급하지 않는다. 클라이언트를 조작해도 통과 경로가 없다.

**`flags`에 `self_harm`이 있으면 차단 화면에 위기 상담 안내를 함께 띄운다** (S-4(위협 모델, 비공개) · [흐름 1-6-1](./03-flows.md)). 응답에 필드를 더하지 않는다 — 이미 내려가는 `flags`로 판정할 수 있다. 오탐이어도 안내가 뜨는 쪽으로 기운다.

### 표기 변형은 등급 판정과 다른 호출이다

[D-021](./00-decisions.md)의 답 표기 변형 3~5개는 **편지가 실제로 생성되는 시점에** 별도 호출로 만든다. 위 5단계의 "등급 재판정 없이"와 충돌하지 않는다 — 재판정하지 않는 것은 등급이고, 변형 생성은 등급을 건드리지 않는 다른 호출이다.

```
mode = 'locked' 이고 실제로 생성될 때만 (201을 돌려준 뒤):
  분류기 호출 2회차 → 변형 3~5개 → 각각 정규화 + HMAC → answer_variant_hmacs
```

- `open` 모드는 답이 없으므로 **호출이 늘지 않는다**
- 차단된(`high`) 편지에는 변형을 만들지 않는다. 생성되지 않는 편지에 돈을 쓰지 않는다
- 이 호출이 실패하면 **변형 없이 생성한다.** `answer_hmac` 하나로 여는 현재 동작으로 떨어질 뿐이라 [D-015](./00-decisions.md)의 등급 강등 경로를 태울 이유가 없다. 편지가 안 만들어지는 쪽이 훨씬 나쁘다
- 4초 예산은 등급 판정 호출 하나의 것이다. 변형 호출은 같은 예산을 따로 쓴다(아래 「동작 파라미터」). 둘을 직렬로 붙이면 `locked` 제출의 최악이 **8초**(4 + 4)여서, 이 문서가 정한 "3초 이상은 고장으로 인식된다"의 두 배를 넘었다

**변형 호출은 제출 응답에 들어가지 않는다.** 편지를 먼저 만들어(`answer_hmac` 하나로 잠긴다) `201`을 돌려주고, 변형 생성과 `answer_variant_hmacs` 갱신은 응답이 나간 뒤에 돈다. 근거는 위 마지막 항목이다 — "이 호출이 실패하면 변형 없이 생성한다"가 이미 변형을 편지 생성의 선행 조건에서 빼놓았다. 실패해도 되는 것을 제출한 사람이 기다릴 이유가 없다.

응답 뒤의 실행은 `next/server`의 `after()`로 잡는다. 서버리스([D-018](./00-decisions.md))에서 응답 뒤에 남은 일은 `waitUntil`(또는 그것을 쓰는 `after`)로 감싸야만 보장되고, 감싸지 않은 프로미스는 유실된다 — <https://vercel.com/docs/functions/functions-api-reference> · <https://nextjs.org/docs/app/api-reference/functions/after> (둘 다 확인 2026-08-15).

**실측** (2026-08-15) — `POST /api/letters`가 응답할 때까지. 두 호출에 위 예산값을 그대로 넣고 쟀다:

| | 변경 전 | 변경 후 |
|---|---|---|
| 최악 (4초 + 4초) | 8,065ms | 4,033ms |
| 둘 다 정상 (1.6초 × 2) | 3,239ms | 1,628ms |

**감수하는 위험**: 생성 직후 변형이 아직 채워지지 않은 짧은 창이 생기고, 그동안은 원문과 정확히 같은 답만 통과한다. 공유 → 전달 → 열람까지 걸리는 시간을 생각하면 무시할 만하다. 갱신이 끝내 실패해도 결과는 같다 — `answer_hmac` 하나로 여는 동작이다. 미루는 사이에 작성자가 편지를 지웠으면 채우지 않는다.

### 층 2 분류기 호출

모델과 파라미터는 [D-020](./00-decisions.md). **OpenAI `gpt-5.6-luna`**, `reasoning effort` **`none` 또는 `low`**.

**effort를 기본값으로 두면 안 된다** — gpt-5.6 계열은 전부 추론 모델이라 기본값이 `medium`이고, 지연은 모델 등급보다 effort에 더 크게 좌우된다 (아래 실측).

**출력은 JSON 스키마로 강제한다.** 파싱 실패라는 실패 모드가 사라지고, `risk_flags`의 스키마가 여기서 확정된다.

```ts
{ risk: 'low' | 'medium' | 'high'
  flags: Array<{
    kind: 'person_name' | 'school' | 'company' | 'place_time_combo'
        | 'self_harm' | 'sexual_minor' | 'threat'
        | 'contact' | 'url'               // 층 1이 내는 값. 아래 참조
        // 민감정보 7범주 (D-033). 하나라도 붙으면 무조건 high다
        | 'sensitive_health' | 'sensitive_sexlife' | 'sensitive_belief'
        | 'sensitive_politics' | 'sensitive_biometric' | 'sensitive_crime'
        | 'sensitive_ethnicity'
    field: 'body' | 'hint' | 'question'   // 필드가 등급을 가른다 (D-016)
  }>
  notice?: string }                        // 인터스티셜 한 문장. 아래 참조
```

`flags`가 `letters.risk_flags`에 그대로 들어간다. `field`가 있어야 [D-016](./00-decisions.md)의 "단서면 high, 질문·본문이면 high·medium"을 서버가 판정할 수 있다.

**`kind` 목록의 단일 출처는 `src/lib/safety/types.ts`의 `FLAG_KINDS` 배열이다.** 이 스키마의 `enum`을 그 배열에서 만든다 — 타입은 런타임에 없으므로 값으로 된 출처가 없으면 목록이 코드와 스키마 두 곳에 복제되고 반드시 갈라진다.

**`contact`(전화·이메일·SNS·주소)와 `url`(URL·QR)은 층 1이 내는 값이다.** 위협 모델 §2(비공개)가 이 둘을 `high`로 규정하는데, 층 1이 잡은 것을 담을 자리가 없으면 `flags`가 비고, 그러면 위협 모델 §3(비공개)의 "무엇이 걸렸는지 정확히 알려준다"를 차단 화면이 지킬 수 없다. 목록이 하나라 분류기도 같은 `kind`를 쓴다.

**인터스티셜 문구를 같은 호출에서 받는다.** 위협 모델 §3(비공개)은 "무엇이 걸렸는지 정확히 알려준다"를 원칙으로 두는데, flags → 고정 문구 매핑으로는 편지마다 다른 상황을 말할 수 없다. `notice`를 응답 필드로 하나 더 받으면 **왕복이 늘지 않고**, [인터스티셜 회귀율](./06-analytics.md)이 직접 올라갈 여지가 생긴다.

`notice`에는 **본문을 인용하지 않는다.** 그대로 화면에 뜨고, 사용자가 캡처해 공유하면 우리 통제를 벗어난다.

이 문구는 `needs_confirmation` 응답에 `notice`(선택)로 그대로 실려 내려간다(§1 흐름). 내보내기 직전에 서버가 본문·단서·질문·답의 인용 여부를 한 번 더 확인하고, 인용이 의심되면 `notice`를 **버린다** — 클라이언트는 `flags` 기반 문구로 떨어진다. 규칙을 분류기에만 맡기면 프롬프트가 바뀌는 날 조용히 깨진다.

### 분류기가 실패하면

제출 경로가 외부 API에 동기로 의존하므로 실패 정책을 정해야 한다. 근거는 [D-015](./00-decisions.md).

| 층 | 무엇 | 실패 가능성 |
|---|---|---|
| 1 | 정규식 + 사전 (연락처·URL·학교·회사) | 로컬 실행, 실패 없음 |
| 2 | LLM 분류기 (인명·맥락) | 타임아웃 · 네트워크 · 비용 상한 · **거부** |

**동작 파라미터** (전부 가설값)

- 타임아웃 **3초**. 제출 경로라 이 이상은 고장으로 인식된다
- **재시도는 타임아웃이 아닌 실패에만 1회** (1초 후). **타임아웃에는 재시도하지 않는다**
- **총 예산 상한 4초.** 어떤 경로로도 분류 호출 하나가 이 시간을 넘지 않는다
- 동일 `contentHash` 캐시는 **v0에서 두지 않는다.** 저장 위치가 없고(서버리스라 프로세스 로컬 캐시는 인스턴스 간에 공유되지 않는다 · [D-018](./00-decisions.md) / 쓰지 않을 테이블을 미리 두지 않는다 · [데이터 모델](./04-data-model.md)), 같은 내용이 두 번 판정되는 경로도 사실상 없다 — 인터스티셜 재제출은 `confirmation` 토큰이 등급 재판정 자체를 건너뛰게 만든다(위 5단계). 재판정이 실제로 관측되면 그때 저장 위치를 정한다
- 일일 비용 상한 **$5** 초과 시 층 2를 건너뛰고 운영자 알림

| 경로 | 소요 | 호출 |
|---|---|---|
| 정상 | 약 1.6초 (아래 실측) | 1회 |
| 타임아웃 | 3초 | 1회 — 재시도 없음 |
| 빠른 실패 → 재시도 | 최악 4초 (0초 + 1초 대기 + 3초) | 2회 |
| 느린 실패 → 재시도 | 최악 4초 — 2회차 타임아웃이 남은 예산만큼 잘린다 | 2회 |

**왜 타임아웃에 재시도하지 않는가**

1. 3초를 다 태운 뒤의 재시도는 대개 또 타임아웃이다. 재시도가 실제로 값을 만드는 것은 **빠르게 끝나는 실패** — 연결 거부 · 5xx · 일시적 네트워크 오류다
2. 타임아웃에도 재시도하면 최악이 3초 + 1초 + 3초 = **7초**이고, 제출 경로에서 그건 이 문서가 바로 위에서 정한 "3초 이상은 고장으로 인식된다"를 스스로 넘는다. `locked` 편지는 변형 생성 호출이 뒤에 붙어 더 나빠진다(위 「표기 변형은 등급 판정과 다른 호출이다」)
3. **재시도를 안 해서 지는 비용이 낮다.** [D-015](./00-decisions.md)가 실패 경로를 이미 안전하게 설계했다 — `medium` 강등으로 편지는 생성되고 공유 링크도 살아 있으며, 아래 재분류 잡이 나중에 등급을 갱신한다. 반면 7초 제출은 사용자가 실패로 인식하고 이탈한다

판별은 **SDK의 오류 타입**(`APIConnectionTimeoutError`)으로 한다. 오류 메시지 문자열을 보지 않는다 — 문구는 SDK 판올림에 바뀌고, 그날 이 규칙은 조용히 "전부 재시도"로 돌아간다.

**지연 실측** (2026-08-14 · 같은 편지, 입력 952토큰)

| `reasoning.effort` | 지연 |
|---|---|
| `none` | **1,618 ms** (1,618 ~ 2,117 ms) |
| `low` | **4,397 ms** — 3초 타임아웃을 넘긴다 |

`low`를 쓰면 제출이 매번 3초를 버리고 `unavailable` → `medium` 강등으로 끝난다. 그래서 `none`으로 고정했다([D-020](./00-decisions.md)). 재현율이 부족하면 올릴 대상은 effort가 아니라 **모델 등급**이다.

### 거부(`refusal`)는 장애가 아니다

스키마 강제 출력은 모델이 거절하면 스키마 대신 **`refusal` 필드**를 돌려준다. **우리가 보내는 입력은 정의상 위험할 수 있는 텍스트**라 이건 실제로 발생한다.

```
refusal 응답 → risk = 'high'   (medium 강등이 아니다)
```

거부를 위 「층 2 실패」 경로로 흘려보내면 `medium`으로 강등돼 **게시된다.** S-4·S-5(위협 모델, 비공개)는 게시되면 안 되는 카테고리이고, 하필 그 카테고리가 거부를 유발할 가능성이 가장 높다. 실패는 통과 쪽으로 기울여도 되지만 **거부는 차단 쪽으로 기울인다.**

오탐이면 작성자가 편지를 고쳐서 다시 낸다. 반대 방향의 실패보다 훨씬 싸다.

### 프롬프트 캐싱 — v0에서는 기대하지 않는다

분류 프롬프트(규칙 + 학교·회사 사전 + 예시)는 편지마다 안 바뀌는 접두사라 캐시 대상이다. 캐시된 입력은 $0.20 → **$0.02**로 떨어진다. 다만 v0에서는 **거의 안 걸린다**:

- 최소 1,024 토큰을 넘어야 하고, **정확한 접두사 일치**여야 한다 — 프롬프트에 타임스탬프나 요청 ID가 섞이면 통째로 깨진다
- 캐시 수명이 **30분**인데, 출시 초기 작성 빈도는 그보다 훨씬 뜸하다
- gpt-5.6 계열은 캐시 **기록**에 1.25배를 받는다 — 읽히지 않으면 오히려 손해다

**그래서 v0의 비용 레버는 캐싱이 아니라 모델 등급이다**(luna ↔ terra가 10배). 접두사를 고정해두기만 하고, 캐시 효과는 작성량이 붙은 뒤에 본다.

**대략의 비용**: 편지 한 통이 프롬프트 ~3,000 + 입력 ~1,000 + 출력 ~150 토큰이면 캐시 미스 기준 **약 $0.001**. 하루 1,000통이면 **월 $30 정도**다. 실측 전 추정이다.

이건 **등급 판정 1회 기준**이다. `locked` 편지는 여기에 변형 생성 호출이 더해지고, 신고 큐 초안 판정([운영 §2](./07-operations.md))은 신고 건수만큼 또 붙는다. 셋 다 [D-020](./00-decisions.md)의 일일 $5 상한을 함께 쓴다.

**상한에 닿으면 끄는 순서**: 표기 변형 → 큐 초안 → 등급 판정. 앞의 둘은 없어도 안전 정책이 그대로지만(변형은 열람 편의, 큐 초안은 운영자 보조), 등급 판정이 꺼지면 그 시간대 편지가 전부 `medium`으로 강등된다. 등급 판정을 마지막까지 살린다.

**층 2 실패 시**

```
risk = max(층1 판정, 'medium')
classifier_state = 'unavailable'
```

`risk_flags`가 아니라 별도 컬럼에 적는다. `risk_flags`는 인터스티셜에 "무엇이 걸렸는지" 말하기 위한 것인데, 분류기 장애는 걸린 항목이 아니라 판정을 못 한 상태다. 섞으면 재분류 잡이 훑을 대상을 jsonb 안에서 찾아야 한다 ([데이터 모델 §2](./04-data-model.md)).

층 1이 `high`면 분류기 상태와 무관하게 **차단된다**. 그 외에는 `medium`으로 강등 — 편지는 생성되고 공유 링크도 살아 있지만 피드에는 뜨지 않는다.

**이 경우 인터스티셜을 띄우지 않는다.** 인터스티셜은 "무엇이 걸렸는지" 구체적으로 말해야 하는데(위협 모델 §3(비공개)), 분류기가 죽어서 medium이 된 편지에는 말할 플래그가 없다. "부적절할 수 있습니다" 같은 모호한 경고는 우회 학습만 시킨다.

따라서 응답도 `needs_confirmation`이 아니라 **`201` 즉시 생성**이다. §1 흐름의 `medium → 200` 규칙에 대한 유일한 예외이며, 안전 테스트 12가 이걸 고정한다.

**재분류 잡 (M2 필수)**

`classifier_state = 'unavailable'` 편지를 10분마다 재시도하고 `classifier_retry_count`를 올린다. 성공하면 `'ok'`로 바꾸고 등급을 갱신 — `low`면 피드로 승격한다. **3회 실패하면 `'failed'`로 고정**하고 `medium`에 둔 채 [주간 샘플 검수](./07-operations.md) 대상으로 넘긴다.

**이 잡이 없으면 장애 1시간이 그 시간대 편지 전부를 영구히 피드에서 제외한다.**

**누가 부르는가**: `reclassify.yml` 워크플로(공개 저장소에는 없다)가 10분마다 `/api/cron/reclassify`를 리포 시크릿 `CRON_SECRET`과 함께 호출한다. 비 2xx면 워크플로가 실패로 끝나고, `workflow_dispatch`로 손으로도 돌릴 수 있다.

**Vercel Cron이 아니다.** Hobby 계정은 크론이 **하루 1회**가 상한이고, 그보다 잦은 cron 식은 *"fail during deployment"* — 배포 자체를 실패시킨다(<https://vercel.com/docs/cron-jobs/usage-and-pricing>, 확인 2026-08-15). 분 단위 정밀도는 Pro부터다.

**감수하는 한계**: GitHub Actions의 `schedule`은 러너 부하가 높으면 지연되거나 건너뛰고, 리포가 60일간 비활성이면 자동 중지된다. 즉 실행이 보장되지 않는다. v0에서 감수하고 트래픽이 붙으면 Vercel Pro로 옮긴다 — 그때까지 이 한계를 붙잡는 것은 [주간 점검 §7](./07-operations.md)의 "재분류 워크플로가 실제로 돌았는지 확인"이다.

**재분류가 `high`이거나 거부면 `hidden_auto`로 내린다.** 재분류의 `high`는 "이 편지는 애초에 게시되면 안 됐다"는 판정인데, `medium`에 두면 피드에서만 빠지고 공유 링크로는 계속 읽힌다 — B 모드는 링크 유통이 정상 경로다. 주간 샘플 검수에 맡기는 것도 안 된다: 그건 `medium` 20건 샘플이고 주 1회라, S-5(위협 모델, 비공개)가 최악의 경우 일주일 떠 있게 된다. §4(위협 모델, 비공개)의 계산을 그대로 적용해 비공개를 기본값으로 둔다 — 되돌릴 수 있는 조치라 오작동 비용이 낮다.

- `risk_level`은 `medium` 유지. "`high`는 저장되지 않는다"는 전제([데이터 모델 §2](./04-data-model.md)의 제약)는 그대로다. 여기서 바뀌는 것은 등급이 아니라 **status**다
- `classifier_state`는 `'ok'`. 판정은 실제로 끝났다
- **`auto_hide_exempt`를 무시한다.** exempt는 "반복 신고로 다시 내려가지 않는다"는 약속이지 "우리 필터가 틀렸어도 안 내린다"는 약속이 아니다 ([D-025](./00-decisions.md)가 심각 카테고리에 exempt를 뚫어준 것과 같은 계산이고, 여기는 신고자의 악의가 개입할 여지조차 없다)
- **`admin_actions`에 기록한다.** 운영자가 "신고가 아닌데 왜 내려갔지"를 알 수 있는 유일한 경로다

---

## 2. 공개 엔드포인트

### `POST /api/letters`

§1 참조.

```ts
// 요청
{ mode: 'open' | 'locked'
  relationship: 'ex'|'friend'|'family'|'coworker'|'other'
  body: string                    // ≤ 500
  hint?: string                   // locked 필수, ≤ 60
  question?: string               // locked 필수, ≤ 60
  answer?: string                 // locked 필수, ≤ 40
  confirmation?: string }

// 201
{ status: 'created'
  id: string
  manageToken: string }           // 응답에서만 노출. DB엔 해시만
```

- `manageToken`은 **이 응답에서만** 볼 수 있다. 재발급 불가 — 분실하면 `/api/deletion-requests` 경로.
- `writing_enabled = false`면 503.

### `GET /api/feed`

```ts
// ?relationship=friend&cursor=<created_at>_<id>&limit=20
{ items: FeedItem[], nextCursor: string | null }

type FeedItem = {
  id: string
  mode: 'open' | 'locked'
  relationship: string
  createdAt: string
  preview: string        // open: 본문 앞부분 / locked: hint
  reactions: Record<string, number>
}
```

`status='published' AND risk_level='low'`만. `public_read_enabled = false`면 빈 배열 + `disabled: true`.

**커서는 `created_at` 단독이 아니라 `(created_at, id)`다.** 편지 두 통이 같은 타임스탬프를 가지면 단독 커서로는 한 통이 누락되거나 중복된다. 정렬도 `order by created_at desc, id desc`로 맞춘다.

### `GET /api/letters/:id`

```ts
// mode = 'open'
{ id, mode: 'open', relationship, createdAt, body, reactions }

// mode = 'locked' (미해제)
{ id, mode: 'locked', relationship, createdAt, hint, question,
  attemptsRemaining: number, lockedUntil: string | null }
```

> **잠긴 편지 응답에 `body`가 절대 포함되면 안 된다.** 직렬화 실수로 새기 쉬운 지점이라 테스트로 고정한다.

등급 `medium` 편지도 여기서는 정상 조회된다 — 링크 접근은 허용이고 피드 노출만 제외다.

**예외 하나 — 이미 연 사람.** 요청에 해제 쿠키가 있으면 `unlocks`에서 `unlock_id`를 조회하고, `letter_id`가 일치할 때만 `open`과 같은 형태로 `body`를 반환한다 ([데이터 모델 §4](./04-data-model.md)).

**형태가 같다는 것은 필드 집합을 말한다. `mode`는 실제 값 `'locked'`를 유지한다.** `'open'`으로 내리면 [계측 §3](./06-analytics.md)의 `letter_view { mode }`가 거짓이 되어 A/B 모드별 지표가 조용히 망가지고, 클라이언트도 "이미 연 잠긴 편지"와 "원래 공개 편지"를 구분할 수 없다.

쿠키 값은 **DB 대조로만** 검증한다. 쿠키에 든 `letter_id`를 믿으면 값을 바꿔 아무 편지나 열 수 있다.

### `POST /api/letters/:id/unlock`

```ts
// 요청
{ answer: string }

// 200 성공
{ status: 'unlocked', body: string, unlockId: string }

// 200 실패
{ status: 'wrong', attemptsRemaining: number }

// 429
{ status: 'rate_limited', retryAfter: number }
```

- HMAC 비교는 **상수 시간**으로. `answer_hmac`과 `answer_variant_hmacs`를 함께 본다 ([D-021](./00-decisions.md)) — 어느 쪽에 맞았는지는 **응답에도 로그에도 남기지 않는다.** 남기면 정답 근접도가 새어나간다.
- 실패 응답에 정답에 관한 어떤 정보도 넣지 않는다 — 글자 수, 부분 일치, 메시지 차이 전부 (S-6(위협 모델, 비공개)).
- 실패 시 인위적 지연을 시도 횟수에 따라 증가.
- 성공 시 `unlockId`를 **HttpOnly 쿠키로도 내린다**(30일, 가설값). 재방문하면 답을 다시 맞히지 않는다.
- 이미 해제한 `(letter, fp)`가 다시 성공하면 행을 새로 만들지 않고 기존 `unlock_id`를 돌려준다 — `unique (letter_id, fp_hash)`.

### `POST /api/unlocks/:unlockId/response`

```ts
{ response: 'yes' | 'no' | 'unknown' }   // → 204
```

북극성 지표의 유일한 수집 지점. `unlockId`는 해제한 본인만 알고, 1회만 기록된다.

### 나머지

| 메서드 | 경로 | 비고 |
|---|---|---|
| `POST` | `/api/letters/:id/react` | `{ kind }` → `200 { reactions }`. PK 제약으로 중복 자동 차단 |
| `POST` | `/api/letters/:id/report` | `{ reason }`. **즉시 자동 비공개 트리거** |
| `POST` | `/api/deletion-requests` | `{ bodyExcerpt, contact? }`. 관리 링크 분실 |
| `POST` | `/api/events` | `{ name, props? }` → 204. 클라이언트 이벤트 ([계측 §1](./06-analytics.md)) |

반응은 **204가 아니라 방금 센 개수를 돌려준다.** 204로 두면 화면이 개수를 낙관적으로 +1 해야 하는데, 중복 반응은 PK가 막아 실제 행이 생기지 않는다 — 그러면 화면에만 존재하는 개수가 남고 그건 [D-007](./00-decisions.md)이 금지한 "존재하지 않는 신호"다. 형태는 `FeedItem.reactions`와 같다.

이메일 등록은 공개 엔드포인트가 아니다 — §3에 있다.

---

### 상태별 표면 응답

[상태 기계](./04-data-model.md)의 각 상태가 표면마다 무엇을 반환하는지 고정한다. **여기가 비어 있으면 비공개 편지가 링크로 계속 읽히는 사고가 난다.**

**노출 조건은 `status` 하나가 아니다.** `risk_level`이 피드를 가르고, `classifier_state`가 판정 완료 여부를 가른다 — 셋이 함께 본다.

| status | 피드 | `GET /api/letters/:id` | `/m/:id` | OG 이미지 | `/manage/:token` |
|---|---|---|---|---|---|
| `published` · low | 노출 | 200 | 200 | 생성 | 200 |
| `published` · medium | **제외** | 200 | 200 | 생성 | 200 |
| `published` · `classifier_state <> 'ok'` | 제외 | **404** | **404** | **404** | **200** (`pendingReview: true`) |
| `hidden_auto` | 제외 | **404** | **404** | **404** | **200** (상태 + 이의 제기) |
| `hidden_admin` | 제외 | **404** | **404** | **404** | **200** (상태 + 이의 제기) |
| `deleted_by_author` | 제외 | 404 | 404 | 404 | **410** (삭제됨, 복구 불가) |

- **403이 아니라 404**를 쓴다. 403은 편지의 존재를 확인해준다.
- 관리 화면만 예외로 열려 있다. 이의 제기 경로가 여기밖에 없다 ([발견 2](./04-data-model.md)).
- `deleted_by_author`에 410을 쓰는 이유: 토큰 소지자는 작성자 본인이므로 "이미 지웠다"를 알려주는 편이 맞다.

> **한계**: 카카오톡·트위터는 OG 미리보기를 캐시한다. 편지를 내려도 **이미 공유된 곳의 미리보기는 남고, 우리가 지울 수 없다.** S-10(위협 모델, 비공개)과 같은 성격의 비가역 항목이므로, OG 카드에 본문 전체를 넣지 않는 것이 유일한 방어다.

---

## 3. 관리 엔드포인트

**랜덤 토큰 32바이트 (base64url).** 서명 토큰이 아니다 — 근거는 [D-014](./00-decisions.md). 세션 없음.

| 메서드 | 경로 | 응답 |
|---|---|---|
| `GET` | `/api/manage/:token` | `{ id, status, statusReason?, canAppeal, pendingReview, opened, recipientSaidYes }` |
| `DELETE` | `/api/manage/:token` | 204 |
| `POST` | `/api/manage/:token/appeal` | `{ message? }` → 204 |
| `POST` | `/api/manage/:token/contact` | `{ email, ageConfirmed }` → 204. 아래 참조 |

`canAppeal`은 `hidden_auto` · `hidden_admin`에서만 `true`이고, **이의 제기는 편지당 1회다** — 이미 제기한 편지는 결과가 나왔든(`restored`·`rejected`) 아직이든(`pending`) 다시 받지 않는다. `false`인데 들어온 요청은 409, `published`는 400, `deleted_by_author`는 410이다.

근거: 반려된 이의를 다시 제기해도 새 정보가 없다 — 작성자가 새 근거를 덧붙일 수단이 v0에 없다. 무제한 재제기는 [운영 큐](./07-operations.md)만 늘리고 판정을 바꾸지 못한다. 인용된 편지는 `published`로 돌아가므로 애초에 대상이 아니다. **가설값이고 실측 후 조정한다.**

`statusReason`은 문구가 아니라 **코드값**(`reported` · `admin`)이다. §6의 "문구 매핑 테이블을 두지 않는다"는 오류 응답의 `message` 규칙이고, 상태 문구는 상태마다 화면 레이아웃이 달라서 화면이 갖는다.

### `POST /api/manage/:token/contact`

```ts
{ email: string
  ageConfirmed: true }     // 필수. true가 아니면 400
```

**편지 ID가 아니라 관리 토큰으로 받는다.** ID를 키로 두면 편지 링크를 본 사람 누구나 이메일을 붙일 수 있고, 등록이 편지당 1회라서 **진짜 작성자가 409로 밀려난다.** 게다가 그 제3자에게 "누군가 열었습니다" 메일이 발송된다 — 가입하지 않은 사람에게 아웃바운드가 나가는 것이라 [D-006](./00-decisions.md)이 뚫리는 경로다. 토큰은 작성 응답에서만 나오므로 소지자가 곧 작성자다.

`ageConfirmed !== true`면 **이메일을 저장하지 않고 400**을 반환한다. 클라이언트 체크박스만으로는 안 된다 — 아동 개인정보를 수집하지 않기 위한 유일한 방어선이다 ([D-013](./00-decisions.md)).

이 서비스에서 연령 확인이 걸리는 지점은 **여기 하나뿐이다.** 작성·열람·피드에는 없다.

편지당 1회. 이미 등록됐으면 409.

**해지된 주소는 다시 등록되지 않는다.** `sha256(normalize(email))`이 `email_suppressions`에 있으면 저장하지 않고 400을 반환한다 — 근거는 [발송 §1](./09-notifications.md).

검증은 `sha256(token)`으로 `letters.manage_token_hash`(unique index) 조회. **원문 비교가 없으므로 상수 시간 비교도 필요 없다** — 인덱스 조회 시간은 토큰 값에 의존하지 않는다.

토큰은 URL 경로에만 들어가고 편지 ID는 들어가지 않는다. 잘못된 토큰으로도 어느 편지인지 알 수 없다.

**편지가 비공개 상태여도 이 엔드포인트는 응답한다.** 그래야 작성자가 상태를 확인하고 이의를 제기할 수 있다 (§2 「상태별 표면 응답」 참조).

`pendingReview`는 **판정이 안 끝나 보류 중인가**다 ([D-035](./00-decisions.md)). `true`면 그 편지는 링크로도 안 열린다 — 작성자에게 그 사실을 말하지 않으면 자기 링크에서 404를 만나고 편지가 사라진 줄 안다. `status`와 별개인 이유는 §2의 노출 조건 표에 있다.

`opened` · `recipientSaidYes`는 **불리언이다.** 몇 명이 열었는지, 언제 열었는지는 주지 않는다 — 잠긴 편지는 제3자도 열고, 횟수를 보여주면 작성자가 없는 의미를 읽는다 ([D-007](./00-decisions.md)). 이메일을 남기지 않은 작성자가 [D-023](./00-decisions.md)의 응답을 확인할 수 있는 유일한 경로이기도 하다.

---

## 4. 운영자 엔드포인트

**인증: 환경변수 비밀번호 1개 + 서명 쿠키 세션 (7일).** 계정 테이블도 사용자 관리도 없다.

- `POST /api/admin/login` `{ password }` → 서명 쿠키. 실패는 5 / 10분으로 제한
- **`/admin` 페이지와 `/api/admin/*`를 같은 방식으로 막는다.** API만 막고 페이지를 열어두면 큐 화면 껍데기가 노출된다
- 킬 스위치와 마찬가지로 **미들웨어가 아니라 핸들러에서** 확인한다
- Basic Auth를 쓰지 않는 이유: 로그아웃이 없고 새벽에 휴대폰으로 여는 경우가 많다

| 메서드 | 경로 | 용도 |
|---|---|---|
| `GET` | `/api/admin/queue` | 미판정 신고 · 자동 비공개 건 · 이의 제기 · 삭제 요청 |
| `POST` | `/api/admin/reports/:id/resolve` | `{ action: 'uphold' \| 'dismiss' }` |
| `POST` | `/api/admin/appeals/:id/resolve` | `{ action: 'restore' \| 'reject' }` |
| `POST` | `/api/admin/letters/:id/hide` | 직접 비공개 |
| `POST` | `/api/admin/deletion-requests/:id/resolve` | `{ letterId, note? }` — 관리 링크 분실 삭제 요청 처리 |
| `POST` | `/api/admin/settings` | `{ publicReadEnabled?, writingEnabled? }` — 킬 스위치 |

`dismiss`는 편지를 `published`로 되돌리고 `auto_hide_exempt = true`를 세운다 ([데이터 모델 §3](./04-data-model.md)).

`restore`도 같다 — `hidden_admin` 편지를 `published`로 되돌리고 `auto_hide_exempt = true`를 세운다. **이 엔드포인트가 없으면 이의 제기가 접수만 되고 결론이 없다.** `reject`는 상태를 바꾸지 않고 `appeals.status`만 기록한다.

`/api/admin/deletion-requests/:id/resolve`는 [운영 §5](./07-operations.md)의 「관리 링크 분실」을 끝내는 경로다. **`letterId`가 필수다** — 어느 편지인지는 운영자가 `body_excerpt`를 본문과 대조해서 정한다([데이터 모델 §5 발견 3](./04-data-model.md)). 서버가 본문으로 편지를 찾아 지우면 본문 일부만 아는 사람이 남의 편지를 지울 수 있다. 접수 시 비워둔 `deletion_requests.letter_id`를 이 호출이 채운다.

편지는 `hidden_admin`이 아니라 **`deleted_by_author`가 된다.** 관리 링크를 잃어버렸을 뿐 결국 작성자 본인의 삭제이고, 나중에 작성자가 링크를 찾았을 때 §2의 표대로 410("이미 지웠다")을 봐야 사실과 맞는다 — `hidden_admin`이면 "운영자가 내렸다 · 이의 제기 가능"으로 잘못 읽힌다.

모든 운영자 호출은 `admin_actions`에 기록.

---

## 5. 레이트리밋

### fp_hash 산출

```
fp_hash = HMAC-SHA256(fp_key, normalize(ip) + '|' + user_agent)
```

`normalize(ip)`는 이렇게 고정했다 (구현: `src/lib/fingerprint.ts`).

- **출처**: `x-vercel-forwarded-for` → `x-forwarded-for` → `x-real-ip` 순, 셋 다 없으면 `0.0.0.0`(로컬 개발). Vercel이 `x-forwarded-for`를 덮어써 스푸핑을 막고, 앞의 헤더는 Vercel 위에 프록시를 얹어도 덮이지 않는다 ([Vercel 요청 헤더](https://vercel.com/docs/headers/request-headers)). 쉼표 목록이면 첫 항목
- **형태**: IPv4는 전체 주소, IPv6는 canonical하게 편 뒤 **상위 64비트(/64)만** — /64가 인터페이스 식별자 경계라 단말이 그 안에서 주소를 자주 바꾸고, 전체 주소를 쓰면 같은 사람이 매번 다른 fp가 되어 레이트리밋이 무력해진다 ([RFC 4291 §2.5.4](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.4))
- 소문자화 · 앞뒤 공백 제거. `::ffff:a.b.c.d`(IPv4-mapped)는 IPv4로 되돌린다 — 그대로 /64로 자르면 모든 매핑 주소가 한 버킷에 모인다

`answer_key`와 **다른 키를 쓴다** ([D-017](./00-decisions.md)). `fp_key`는 언제든 교체할 수 있다 — 레이트리밋 카운트가 한 번 리셋될 뿐이다. 반면 `answer_key`는 교체하면 잠긴 편지가 전부 안 열린다. 같은 키를 쓰면 교체 가능한 쪽이 교체 불가능한 쪽에 묶인다.

이 경로는 해시만 남긴다 — 원본 IP는 [법정 접속기록](./04-data-model.md)에만 있고 그쪽과는 조인 키가 없다 ([D-030](./00-decisions.md)). **한국 모바일 캐리어 NAT 때문에 다수 사용자가 IP를 공유한다** — 임계값을 넉넉하게 잡지 않으면 정상 사용자가 걸린다.

### 임계값 (전부 가설값)

| 대상 | 제한 | 키 |
|---|---|---|
| 편지 작성 | 10 / 1시간, 3 / 1분 | fp |
| 열람 시도 | **3 / 24시간** | (letter, fp) — UI의 "남은 시도 3번" |
| 열람 시도 | 50 / 24시간 | letter 전역 |
| 열람 시도 | 30 / 10분 | fp 전역 |
| 신고 | 20 / 24시간 | fp |
| 이메일 등록 | 5 / 1시간 | fp |

**저장소는 Postgres다.** 서버리스라 인메모리 카운터가 인스턴스 간에 공유되지 않는다 ([D-018](./00-decisions.md)). 별도 카운터 테이블은 두지 않는다 — 작성은 `letters.author_fp_hash`, 열람은 `unlock_attempts`, 신고는 `reports.reporter_fp_hash`로 이미 셀 수 있다. 없는 걸 만들기 전에 있는 걸 센다.

동시 요청이 한도를 넘길 수 있다. v0에서는 감수하고, 열람 시도만 `unlock_attempts` 삽입과 카운트를 한 트랜잭션에 묶는다 — 여기만 초과의 대가가 "잠긴 편지가 열린다"이기 때문이다.

**`(letter, fp)` 제한만으로는 부족하다** — fp를 갈아치우면 무한 시도가 된다. 그래서 letter 전역 제한을 함께 둔다.

> **감수하는 트레이드오프**: letter 전역 제한은 공격자가 특정 편지의 하루치 시도를 소진시켜 진짜 수신자를 막는 데 쓸 수 있다. 50회는 정상 사용자가 닿기 어려운 수치이고, 진짜 수신자는 보통 공유 링크를 통해 임의 시점에 들어온다. 감수하고 실측 후 조정한다.

---

## 6. 공통 규약

### 오류 형태

```ts
{ error: { code: string, message: string, retryAfter?: number } }
```

`message`는 사용자에게 그대로 보여줄 한국어. 별도 문구 매핑 테이블을 두지 않는다.

### OG 이미지

`GET /m/:id/opengraph-image` — Next.js 규약. `next/og`로 동적 생성, 엣지 캐시.

- `open`: 본문 일부 + 관계
- `locked`: 단서 + 🔒 + 관계 (본문 절대 미포함)

### 색인

- `/m/:id` → `noindex` (HTTP 헤더 + 메타 태그 둘 다) (S-10(위협 모델, 비공개))
- `/` → 허용
- **`robots.txt`에 `/m/`를 `Disallow`하지 않는다.** 크롤링은 허용한다

**`Disallow`와 `noindex`는 같이 쓰면 서로를 무력화한다.** 크롤러가 페이지를 못 가져오면 그 안의 `noindex`도 못 읽고, 그러면 외부에 링크가 걸렸을 때 URL만 색인된 상태가 남는다 — [절대 규칙 4](./README.md)가 막으려던 바로 그 결과다. `noindex`가 작동하려면 크롤러가 페이지를 읽어야 한다.

부수 효과로 카카오톡 OG 스크래핑도 `robots.txt`에 막히지 않는다. 스크래퍼가 `robots.txt`를 어떻게 다루는지는 **검증하지 않았고**, M4에서 실측한다.

### 킬 스위치 확인 위치

| 스위치 | 막는 것 | 막지 않는 것 |
|---|---|---|
| `public_read_enabled` | `GET /api/feed`, `GET /api/letters/:id`, **`POST /api/letters/:id/unlock`**, `/m/:id`, OG 이미지 | `/manage/:token`, `POST /api/unlocks/:unlockId/response`, 운영자 API |
| `writing_enabled` | `POST /api/letters` | 나머지 전부 |

**`POST /api/letters/:id/unlock`도 막는다 — 성공 응답이 `body`를 그대로 내리기 때문이다.** 여기를 열어두면 `/m/:id`와 `GET /api/letters/:id`를 껐는데 이 엔드포인트 직접 호출로 본문이 계속 나가고, 그러면 아래 「공개 읽기 전체를 끈다」가 성립하지 않는다. 반면 `POST /api/unlocks/:unlockId/response`는 **본문을 내리지 않고 이미 연 사람의 응답을 받을 뿐이라** 막지 않는다 — 막으면 스위치를 켠 동안 열람한 사람의 응답이 사라지고, 그게 [북극성 지표](./01-product.md)의 유일한 수집 지점이다.

**막을 때 무엇을 돌려주는가**

| 표면 | 응답 |
|---|---|
| `GET /api/feed` | `200` + 빈 배열 + `disabled: true` (§2) |
| `GET /api/letters/:id` | `503` + `{ error: { code: 'public_read_disabled' } }` |
| `POST /api/letters/:id/unlock` | `503` + `{ error: { code: 'public_read_disabled' } }` — 위와 같은 코드·문구. 시도로 세지 않는다 |
| `/` · `/m/:id` | `200` + 안내 화면. 편지를 **조회하지 않는다** |
| `POST /api/letters` | `503` (§2) |

**404가 아니라 503이다.** 「상태별 표면 응답」이 404를 쓰는 이유는 403이 **특정 편지의** 존재를 확인해주기 때문인데, 킬 스위치는 전역이라 모든 편지가 똑같이 503을 낸다 — 어떤 편지에 대해서도 아무것도 알려주지 않는다. 두 스위치가 같은 코드를 쓴다. 다르면 나중에 한쪽만 고쳐진다.

**페이지는 상태 코드로 말하지 않는다.** App Router의 페이지(서버 컴포넌트)는 임의 상태 코드를 낼 수 없다 — `notFound()`의 404뿐이다. 대신 **본문·단서·질문을 애초에 조회하지 않는다.** 받아놓고 화면에서 숨기면 HTML 소스에 그대로 남는다.

**`public_read_enabled`는 피드만이 아니라 공개 읽기 전체를 끈다** — 이미 공유된 링크도 죽는다. 그게 의도한 동작이다([운영 §3](./07-operations.md)): 문제 콘텐츠가 여러 건일 때 피드만 끄면 공유 링크로 계속 읽힌다. 이름을 `feed_enabled`로 두지 않은 이유다.

관리 화면은 끄지 않는다. 사고 대응 중에도 작성자는 자기 편지를 지울 수 있어야 한다.

**둘 다 미들웨어가 아니라 핸들러에서 확인한다.** 미들웨어 캐시 때문에 스위치가 즉시 반영되지 않으면 킬 스위치의 의미가 없다.

---

## 7. 테스트로 고정할 것

기능 테스트가 아니라 **안전 회귀 테스트**다. 이게 깨지면 배포를 막는다.

1. **해제 쿠키가 없는** 잠긴 편지 `GET` 응답에 `body`가 없다
2. 잠긴 편지 OG 이미지에 본문이 없다
3. `risk=high`는 `confirmation` 없이도, 조작된 `confirmation`으로도 생성되지 않는다
4. `confirmation` 발급 후 본문 **또는 답**을 바꾸면 재분류된다
5. 오답 응답이 정답 길이·내용에 따라 달라지지 않는다
6. `(letter, fp)` 소진 후에도 letter 전역 한도가 독립적으로 걸린다
7. 신고 1건으로 `status`가 `hidden_auto`가 된다
8. `auto_hide_exempt` 편지는 일반 신고를 받아도 `published`를 유지하고, **심각 카테고리(`doxx`·`sexual`·`selfharm`) 신고에는 `hidden_auto`가 된다** ([D-025](./00-decisions.md))
9. `/m/:id`가 `noindex` 헤더를 반환한다
10. `hidden_auto` · `hidden_admin` · `deleted_by_author` 편지가 피드 · `GET /api/letters/:id` · `/m/:id` · OG 전부에서 404다
11. 위 세 상태에서도 `/manage/:token`은 응답한다 (삭제는 410, 나머지는 200 + 이의 제기 가능)
12. 분류기를 강제로 죽이면 편지가 `medium`으로 생성된다 — 차단도 아니고 `low`도 아니다
13. 층 1이 `high`로 판정하면 분류기 장애와 무관하게 차단된다
14. `ageConfirmed`가 없거나 `false`면 이메일이 저장되지 않는다
15. `public_read_enabled=false`에서 `/manage/:token`은 계속 동작한다
16. 위조하거나 **다른 편지의** `unlock_id`를 담은 쿠키로는 `body`가 열리지 않는다
17. 관리 토큰 없이 `/api/letters/:id` 계열 경로로 이메일을 등록할 수 없다
22. 분류기가 `refusal`을 반환하면 편지가 **생성되지 않는다** — `medium`으로 강등되지 않는다
23. 답 원문이 `answer_hmac`·`answer_variant_hmacs` 어디에도 평문으로 존재하지 않는다
25. **삭제된 편지의 본문·단서·질문·답 해시가 DB에 남아 있지 않다** — 상태만 바뀌고 원문이 남으면 실패다 ([D-027](./00-decisions.md))
26. **법정 접속기록에 편지·세션·`fp_hash`로 이어지는 컬럼도 외래키도 없다** ([D-030](./00-decisions.md))
27. **격리된 편지의 본문이 `letters`에 남아 있지 않다** — 그리고 복원하면 정확히 되돌아온다 ([D-028](./00-decisions.md))
28. **보유기간이 지난 데이터가 실제로 파기되고, 기간 안의 것은 남는다** — 그리고 파기가 실패하면 신규 작성이 막힌다 ([D-031](./00-decisions.md))
29. **`ageConfirmed`가 `true`가 아니면 편지가 생성되지 않는다** ([D-032](./00-decisions.md))
30. **식별 가능한 제3자의 민감정보는 `high`로 차단된다** — 판단이 불가능한 경우에도 게시되지 않는다 ([D-033](./00-decisions.md))
31. **판정이 끝나지 않은 편지(`classifier_state <> 'ok'`)는 어디서도 읽히지 않는다** — 피드·직접 조회·열람·반응 전부 ([D-035](./00-decisions.md))

18~21 · 24는 [발송 명세 §6](./09-notifications.md)에 있다. 여기 26건 + 저기 5건 = [게이트](./08-milestones.md)가 세는 31개다.

> **25 · 26번은 2026-08-16에 늘어난 번호다.**
>
> **25** — [D-027](./00-decisions.md)이 soft delete를 폐기하면서 "지웠다고 적혀 있는데 본문이 남아 있다"가 가능한 실패가 됐고, 그건 **코드를 읽어서는 발견되지 않는다** — 겉으로는 404·410이 정상으로 보인다. 10번(삭제된 편지가 표면에서 404)이 덮지 못하는 자리다. 스키마의 `deleted_is_purged` 제약이 1차 방어이고 이 테스트가 2차다.
>
> **26** — [D-030](./00-decisions.md)이 원본 IP를 3개월 보관하게 하면서, **접속기록과 편지를 잇는 컬럼 하나면 무계정 익명성이 끝난다.** 디버깅 편의로 `letter_id`를 붙이는 변경은 리뷰에서 자연스러워 보이고 화면에는 아무 변화가 없다. 이 번호는 **없어야 할 것이 없다**를 재는 것이라 통과해도 보이는 것이 없다 — 그래서 테스트가 아니면 아무도 모른다.

---

## 다음 문서

`06-analytics.md` — 이벤트 명세.
