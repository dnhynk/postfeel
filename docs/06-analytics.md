# 계측 명세 (v0)

---

## 1. 도구: 자체 DB에 이벤트 테이블 하나

외부 분석 도구를 붙이지 않는다.

- 이미 Postgres가 있고, v0 볼륨에서 이벤트 테이블 하나로 충분하다
- 외부 도구는 IP를 수집한다. 익명 편지 서비스에서 사용자 행동 로그를 제3자에게 넘기는 건 제품 성격과 안 맞는다
- 붙이는 순간 개인정보처리방침에 수탁자를 적어야 한다

```sql
create table events (
  id          bigserial primary key,
  name        text not null,
  session_id  text not null,      -- 익명 랜덤, 쿠키. 계정 아님
  props       jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index events_name_time on events (name, created_at desc);
```

### 전송 경로 — `POST /api/events`

§3의 이벤트 중 절반은 **클라이언트에서만 관측된다**([데이터 모델 §5 발견 5](./04-data-model.md)) — 인터스티셜을 보고 고치러 갔는지 그냥 나갔는지를 서버는 볼 수 없다. 그래서 자체 수집 엔드포인트를 하나 둔다([API §2](./05-api.md)).

외부 도구를 붙이지 않는 이유는 §1과 같고, 표면마다 각자 만들지 않는 이유는 **§2의 금지 규칙이 한 곳에서만 강제될 수 있기 때문**이다. 12개 표면이 각자 수집기를 만들면 그중 하나가 편지 ID를 담는 날 그 행은 되돌릴 수 없다.

엔드포인트가 지키는 것:

- **이름은 allowlist.** §3과 [발송 §5](./09-notifications.md)에 정의된 이름만 받는다. 모르는 이름은 400 — 아니면 누구나 이 테이블을 채울 수 있다
- **props는 이벤트별 화이트리스트.** 선언되지 않은 키는 버린다. §2의 금지 키 가드는 마지막 방어선이지 첫 방어선이 아니다
- **`session_id`는 서버가 httpOnly 쿠키에서 읽는다.** 클라이언트가 보낸 값을 쓰면 남의 세션에 이벤트를 심을 수 있다
- **서버가 관측할 수 있는 이벤트는 서버가 기록한다.** `letter_created` · `email_sent`처럼 위조되면 지표가 거짓이 되는 이름은 이 엔드포인트로 받지 않는다
- 세션당 레이트리밋. 계측 실패가 사용자 흐름을 막지는 않는다

---

## 2. 절대 담지 않는 것

| 항목 | 이유 |
|---|---|
| 본문 · 단서 · 질문 · 답 | 당연 |
| 이메일 | 개인정보는 `author_contacts`에만 |
| **편지 ID** | 아래 참조 |
| IP · User-Agent 원본 | 레이트리밋용 `fp_hash`와 분석은 분리 |

### 편지 ID를 이벤트에 담지 않는 이유

담으면 `session_id ↔ letter_id` 연결이 생기고, 그 순간 **"누가 어떤 편지를 썼는지" 조회 가능한 테이블을 우리가 직접 만드는 것**이 된다. 무계정으로 설계해서 얻은 익명성을 분석 편의로 깨는 셈이다.

→ 편지 ID 대신 **속성만** 담는다: `mode`, `relationship`, `risk`. 퍼널 분석에는 이것으로 충분하고 연결은 생기지 않는다.

`session_id` 보관기간은 `fp_hash`와 함께 [L-001](./00-decisions.md) 확인 후에 정한다 — 편지 보관 기간([D-024](./00-decisions.md) 무기한)과는 별개다. 그때까지 90일을 기본값으로 둔다.

---

## 3. 이벤트

### 유입 · 탐색

| 이벤트 | props |
|---|---|
| `feed_view` | `{ filter }` |
| `feed_card_click` | `{ mode, relationship }` |
| `letter_view` | `{ mode, relationship, source: 'feed'\|'link' }` |

`source`가 중요하다. [D-006](./00-decisions.md)에 따라 공유 링크가 유일한 배달 수단이므로, `link` 비중이 유통이 작동하는지를 직접 보여준다.

### 작성

| 이벤트 | props |
|---|---|
| `write_start` | `{ entry: 'feed'\|'letter'\|'direct' }` |
| `write_relationship_selected` | `{ relationship }` |
| `write_body_done` | `{ length }` |
| `write_mode_selected` | `{ mode }` |
| `write_submit_attempt` | `{ mode }` |
| `filter_warned` | `{ risk, flags }` |
| `filter_revised` | `{ risk }` — 고치러 돌아감 |
| `filter_forced` | `{ risk }` — 경고 무시하고 게시 |
| `filter_abandoned` | `{ risk }` — 경고 후 이탈 |
| `letter_created` | `{ mode, relationship, risk }` |
| `contact_added` | — |

`filter_revised / filter_forced / filter_abandoned`가 **인터스티셜 회귀율**의 소스다 ([제품 정의](./01-product.md)). 경고 문구가 실제로 작동하는지를 직접 측정하는 유일한 수단이다.

### 열람

| 이벤트 | props |
|---|---|
| `unlock_view` | `{ relationship }` |
| `unlock_attempt` | `{ success, attemptNo }` |
| `unlock_success` | `{ relationship, attemptNo }` |
| `recipient_response` | `{ response, relationship }` |
| `post_unlock_continue` | `{ response, target: 'feed'\|'write' }` |
| `post_unlock_exit` | `{ response }` |

마지막 두 개가 [흐름 문서 §2](./03-flows.md)에서 지목한 "아닌 것 같아요" 화면의 성능이다. 이 화면이 §4의 세 번째 퍼널이다.

### 유통

| 이벤트 | props |
|---|---|
| `share_opened` | `{ mode, from: 'create_done'\|'feed'\|'letter' }` |
| `share_copied` | `{ mode, kind: 'link'\|'text' }` |

### 안전 · 관리

| 이벤트 | props |
|---|---|
| `report_submitted` | `{ reason, relationship }` |
| `manage_view` | `{ status }` |
| `letter_deleted` | `{ ageHours }` |
| `appeal_submitted` | — |

발송 관련 이벤트(`email_sent` 등 4종)는 [발송 명세 §5](./09-notifications.md)에 있다. §2의 금지 규칙을 그대로 따른다 — 이메일 주소도 편지 ID도 담지 않는다.

`letter_deleted.ageHours`는 S-9(작성자 후회)(위협 모델, 비공개)의 크기를 보여준다. 24시간 이내 삭제 비율이 높으면 작성 시점에 되돌아볼 여지를 더 줘야 한다는 신호다.

---

## 4. 퍼널 세 개

```
작성   feed_view → write_start → write_body_done
       → write_submit_attempt → letter_created → share_copied

열람   letter_view(source=link) → unlock_view → unlock_attempt
       → unlock_success → recipient_response

루프   recipient_response(no|unknown) → post_unlock_continue → write_start
```

세 번째가 이 제품의 생명선이다. 잠긴 편지를 여는 사람 대부분은 의도한 수신자가 아니고, 그 사람들을 작성자로 전환시키지 못하면 성장이 없다.

---

## 5. 북극성

```sql
-- 주간 "본인에게 온 편지였다" 응답 열람 수
select count(*)
from unlocks u
join letters l on l.id = u.letter_id
where u.recipient_response = 'yes'
  and u.responded_at >= now() - interval '7 days'
  and l.status = 'published';   -- 이후 내려간 편지는 제외
```

`l.status = 'published'` 조건이 [제품 정의](./01-product.md)의 "안전하게"에 해당한다. 나중에 신고로 내려간 편지의 열람은 성과로 세지 않는다.

---

## 6. 주간 리뷰 — 이 일곱 개만 본다

매주 같은 숫자를 같은 순서로 본다. 늘리지 않는다.

| # | 지표 | 계산 | 나쁜 신호 |
|---|---|---|---|
| 1 | 북극성 | §5 | 전주 대비 감소 |
| 2 | 작성 전환율 | `letter_created / feed_view` | — |
| 3 | 링크 유입 비중 | `letter_view(source=link) / letter_view` | 낮으면 유통이 안 도는 것 |
| 4 | 루프 유지율 | `post_unlock_continue / recipient_response` | 낮으면 "아닌 것 같아요" 화면 실패 |
| 5 | **신고율** | `report_submitted / letter_created` | **3% 초과 → 전환 트리거(위협 모델, 비공개)** |
| 6 | **인터스티셜 회귀율** | `filter_revised / filter_warned` | 낮으면 경고 문구가 무시되는 것 |
| 7 | 24시간 내 삭제율 | `letter_deleted(ageHours<24) / letter_created` | 5% 초과 |

5번과 7번은 위협 모델 §7(비공개)의 전환 트리거와 **같은 식**이다. 트리거 판정도 이 식으로 한다 — 계측되지 않는 정의를 트리거에 두면 발동 여부를 판정할 수 없다.

다만 분자는 그 주에 **접수된** 신고·삭제이고 분모는 그 주에 **생성된** 편지라 코호트가 정확히 일치하지 않는다. 추세를 보는 용도이고, 편지 수가 주마다 크게 흔들리면 이 비율이 실제보다 커진다.

성장 지표와 방어 지표를 **같은 화면에서** 본다 ([제품 원칙 6](./01-product.md)).

---

## 7. 측정할 수 없는 것 (정직하게 기록)

| 항목 | 왜 불가능한가 |
|---|---|
| 의도한 수신자에게 실제로 닿았는가 | 자기신고(`recipient_response`)가 유일한 근사. 검증 불가 |
| 동일 대상 반복 작성 | v0에 수신자 식별자가 없다 ([발견 4](./04-data-model.md)) |
| 편지를 읽고 감정이 나아졌는가 | 묻지 않는다. 물으면 마찰이 늘고 응답은 부정확하다 |
| 실제 재연결 발생 여부 | 서비스 밖에서 일어난다 |
| 카톡 공유 후 도달 | 카톡은 아웃바운드 추적을 주지 않는다. `share_copied`까지가 관측 한계 |

이 목록을 지우고 추정치로 채우고 싶은 유혹이 생길 텐데, 그러면 지표 전체의 신뢰가 무너진다.

---

## 다음 문서

`07-operations.md` — 운영 런북.
