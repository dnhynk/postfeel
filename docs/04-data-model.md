# 데이터 모델 (v0)

**목적**: 스키마 설계 자체보다 [흐름 문서](./03-flows.md)의 모든 상태가 실제로 표현 가능한지 검증하는 것. §5에 검증 결과와 발견된 구멍 5개를 적었다.

**범위**: 모드 A + B. 모드 C 관련 테이블은 만들지 않는다 — 쓰지 않을 컬럼을 미리 두지 않는다.

---

## 1. 설계 판단 세 가지

### 1-1. 편지 ID는 추측 불가능해야 한다

위험 등급 '중간' 편지는 피드에 안 뜨고 링크로만 접근된다 (위협 모델 §2(비공개)). **ID가 순차면 이 방어가 통째로 무너진다** — 누구나 `/m/1`부터 훑어서 숨겨진 편지를 전부 수집할 수 있다.

→ 공개 ID는 nanoid 22자. 별도 내부 PK를 두지 않고 이걸 PK로 쓴다. v0 규모에서 문자열 PK의 성능 차이는 무의미하다.

### 1-2. 본문을 애플리케이션 레벨로 암호화하지 않는다

A 모드 본문은 어차피 공개다. B 모드 본문은 가려져 있지만, 작성자는 "공개된 벽에 잠가서 붙인다"는 전제로 썼고, 운영자는 신고 대응을 위해 읽어야 한다. 이 상태에서 앱 레벨 암호화는 복잡도만 늘리고 실제로 막는 게 없다.

→ v0는 DB 저장 시 암호화(관리형 DB 기본)와 전송 구간 암호화만. **모드 C에서는 판단이 달라진다** — 그때 다시 정한다.

### 1-3. 이메일은 편지 테이블에서 분리한다

편지는 공개 데이터고 이메일은 개인정보다. 같은 테이블에 두면 피드 쿼리가 매번 개인정보를 스캔하게 되고, 삭제 요청 처리도 지저분해진다.

→ `author_contacts` 분리. 개인정보 삭제 = 이 테이블 한 행 삭제.

**작성자가 편지를 지우면 이 행도 함께 지운다** (`deleted_by_author`로 가는 두 경로 모두 — [운영 §5](./07-operations.md)). `letter_id`에 `on delete cascade`가 있지만 **삭제가 행을 지우지 않고 tombstone을 남기므로**(§3) cascade가 돌지 않는다. `letters/deletion.ts`가 같은 트랜잭션에서 명시적으로 지운다. 그 주소의 목적은 이 편지의 알림 4종뿐인데([발송 §2](./09-notifications.md)) 편지가 작성자 손으로 사라지면 넷 다 발생할 수 없다 — 목적이 끝난 개인정보를 남기는 것이 위 원칙과 어긋난다. 비공개(`hidden_auto`·`hidden_admin`)는 삭제가 아니라 되돌릴 수 있는 상태이고 3번 메일이 그 상태를 알리므로 **행을 지우지 않는다.**

해지로 행을 지울 때는 `email_suppressions`에 **주소 해시만** 남긴다. 안 남기면 "이 주소는 거부했다"는 사실이 행과 함께 사라져 같은 주소가 다시 등록되고, [D-019](./00-decisions.md)가 약속한 "두 번째 통이 없도록"이 성립하지 않는다 ([발송 §1](./09-notifications.md)).

**키 없는 `sha256`으로 충분하다.** 바로 옆 `author_contacts.email`이 평문이라 해시 쪽에만 키를 씌우는 건 방어가 아니라 장식이고, 키를 쓰면 그 키를 교체하는 순간 억제 목록이 조용히 비어 [D-006](./00-decisions.md) 방어가 사라진다 — [D-017](./00-decisions.md)이 가른 "교체 가능한 키" 쪽에 둘 수 없는 값이 하나 더 생기는 셈이다.

---

## 2. 스키마

아래 SQL이 스키마의 **정본**이고, 실제로 적용되는 것은 `migrations/`다. 둘은 구조(테이블 · 컬럼 · 타입 · 제약 · 인덱스)가 같아야 하지만 **주석은 여기가 최신일 수 있다** — 이미 적용된 마이그레이션은 고치지 않기 때문이다 ([README](../README.md)).

```sql
-- ── 편지 ────────────────────────────────────────────────
create table letters (
  id                text primary key,          -- nanoid(22), 추측 불가 (§1-1)
  mode              text not null,             -- 'open' | 'locked'
  relationship      text not null,             -- 'ex'|'friend'|'family'|'coworker'|'other'
  body              text,                      -- 최대 500자 (가설값). 파기·격리된 행에서는 null (§3)

  -- locked 모드 전용
  hint              text,                      -- 공개됨
  question          text,                      -- 공개됨
  answer_hmac       bytea,                     -- HMAC(answer_key, id || normalize(answer)). 원문 저장 안 함
  answer_variant_hmacs bytea[] not null default '{}',  -- 표기 변형 3~5개의 HMAC (D-021). 원문은 여기도 없다

  -- 자동 등급 (위협 모델 §2)
  risk_level        text not null,             -- 'low' | 'medium'   ('high'는 저장되지 않음)
  risk_flags        jsonb not null default '[]',  -- 층 1·층 2가 낸 flags 배열 (스키마는 API §1)

  -- 분류기 상태 (D-015 · 재분류 잡). 등급과 분리한다 — 등급은 판정 결과고 이건 판정 과정이다
  classifier_state       text     not null default 'ok',  -- 'ok'|'unavailable'|'failed'
  classifier_retry_count smallint not null default 0,

  status            text not null,             -- §3 상태 기계
  auto_hide_exempt  boolean not null default false,  -- 운영자가 '문제없음' 판정한 건 (§3 주석)

  manage_token_hash bytea not null unique,     -- sha256(랜덤 32B). 원문 저장 안 함 (D-014)
  author_fp_hash    bytea not null,            -- 레이트리밋·반복 탐지용

  created_at        timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  deleted_at        timestamptz,               -- 만료 컬럼은 두지 않는다 (D-024)
  quarantined_at    timestamptz,               -- 값이 있으면 본문이 격리로 옮겨져 있다 (D-028)

  -- 잠금 필드 규칙. 파기·격리된 행은 본문 계열이 비어 있으므로 예외다
  constraint locked_fields check (
    status = 'deleted_by_author'
    or quarantined_at is not null
    or (mode = 'locked' and hint is not null and question is not null and answer_hmac is not null)
    or (mode = 'open'   and hint is null     and question is null     and answer_hmac is null)
  ),

  -- ── 본문이 있어야 할 때와 없어야 할 때를 제약으로 고정한다 ──
  -- 주석으로 두면 코드가 절반만 했을 때 아무도 모른다. 아래 셋은 그 상태를 DB가 거부한다
  constraint body_present_unless_deleted check (
    status = 'deleted_by_author' or quarantined_at is not null or body is not null
  ),
  -- 삭제됐으면 원문이 하나도 남아 있지 않다 (D-027)
  constraint deleted_is_purged check (
    status <> 'deleted_by_author'
    or (body is null and hint is null and question is null
        and answer_hmac is null and answer_variant_hmacs = '{}')
  ),
  -- 격리 표식이 있으면 본문은 letters가 아니라 quarantine에 있다 (D-028)
  constraint quarantined_is_moved check (
    quarantined_at is null
    or (body is null and hint is null and question is null
        and answer_hmac is null and answer_variant_hmacs = '{}')
  ),

  -- 허용값을 주석이 아니라 제약으로 둔다. 오타 하나가 편지를 조회 불가 상태로 만든다
  constraint mode_values       check (mode in ('open','locked')),
  constraint risk_level_values check (risk_level in ('low','medium')),
  constraint status_values     check (status in (
    'published','hidden_auto','hidden_admin','deleted_by_author')),
  constraint classifier_state_values check (
    classifier_state in ('ok','unavailable','failed'))
);

-- 재분류 잡이 훑을 대상. 이 인덱스가 없으면 편지가 쌓일수록 10분마다 전체 스캔이다
create index letters_classifier_pending on letters (created_at)
  where classifier_state = 'unavailable';

-- 피드 쿼리: feed_visible = (status='published' and risk_level='low')
-- 커서가 (created_at, id)라 인덱스도 두 컬럼이다 (API §2)
create index letters_feed on letters (created_at desc, id desc)
  where status = 'published' and risk_level = 'low';
create index letters_relationship on letters (relationship, created_at desc, id desc)
  where status = 'published' and risk_level = 'low';

-- ── 개인정보 (분리) ──────────────────────────────────────
create table author_contacts (
  letter_id   text primary key references letters(id) on delete cascade,
  email       text not null,
  -- 발송 (09-notifications.md)
  unsubscribe_token        text not null unique,  -- 랜덤 32B. 관리 토큰과 별개 — 해지에 삭제 권한을 주지 않는다
  first_unlock_notified_at timestamptz,           -- '누군가 열었습니다'를 편지당 1회로 고정
  recipient_yes_notified_at timestamptz,          -- 'yes 응답' 알림도 편지당 1회 (D-023)
  created_at  timestamptz not null default now()
);

-- ── 해지 억제 목록 (발송 §1) ─────────────────────────────
-- 해지한 주소가 다시 등록되는 걸 막는다. 편지와 연결되지 않고, 원문 주소도 없다
create table email_suppressions (
  email_hash      bytea primary key,   -- sha256(normalize(email))
  unsubscribed_at timestamptz not null default now()
);

-- ── B 모드 열람 시도 ─────────────────────────────────────
create table unlock_attempts (
  id            bigserial primary key,
  letter_id     text not null references letters(id) on delete cascade,
  fp_hash       bytea not null,
  succeeded     boolean not null,
  attempted_at  timestamptz not null default now()
);
create index unlock_attempts_window on unlock_attempts (letter_id, fp_hash, attempted_at desc);

-- ── 열람 성공 + 수신자 응답 (북극성 지표 소스) ─────────────
create table unlocks (
  id                  bigserial primary key,
  unlock_id           text not null unique,   -- nanoid(22). 클라이언트에 노출되는 유일한 식별자 (§1-1)
  letter_id           text not null references letters(id) on delete cascade,
  fp_hash             bytea not null,
  recipient_response  text,   -- 'yes'|'no'|'unknown'|null(무응답)
  unlocked_at         timestamptz not null default now(),
  responded_at        timestamptz,
  unique (letter_id, fp_hash)  -- 재열람이 북극성 분자를 부풀리지 못하게 스키마에서 막는다
);

-- ── 신고 ────────────────────────────────────────────────
create table reports (
  id              bigserial primary key,
  letter_id       text not null references letters(id) on delete cascade,
  reason          text not null,   -- 'doxx'|'targeting'|'impersonation'|'sexual'|'selfharm'|'spam'|'other'
  reporter_fp_hash bytea not null,
  status          text not null default 'pending',   -- 'pending'|'upheld'|'dismissed'
  -- 텔레그램 알림이 유일하게 실어 나가는 식별자 (D-034 · migrations/0007).
  -- **DB가 기본값으로 만든다** — 앱이 채우면 "알림은 갔는데 대조할 수 없는 신고"가
  -- 실패 모드로 남는다. 16자 hex(64비트)라 눈으로 대조할 만큼 짧다
  incident_id     text not null default substr(replace(gen_random_uuid()::text,'-',''),1,16),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create unique index reports_incident_id on reports (incident_id);
create index reports_pending on reports (created_at) where status = 'pending';

-- ── 이의 제기 (§5 발견 2) ────────────────────────────────
create table appeals (
  id          bigserial primary key,
  letter_id   text not null references letters(id) on delete cascade,
  message     text,
  status      text not null default 'pending',   -- 'pending'|'restored'|'rejected'
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  constraint appeal_status_values check (status in ('pending','restored','rejected'))
);
create index appeals_pending on appeals (created_at) where status = 'pending';

-- ── 삭제 요청 (관리 링크 분실, §5 발견 3) ─────────────────
create table deletion_requests (
  id           bigserial primary key,
  letter_id    text references letters(id) on delete set null,
  body_excerpt text not null,        -- 본인 확인용 대조 문구
  contact      text,                 -- 회신용 (선택)
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

-- ── 고정형 반응 ──────────────────────────────────────────
create table reactions (
  letter_id  text not null references letters(id) on delete cascade,
  kind       text not null,   -- 'same'|'wish_well'|'unspoken'|'letting_go'
  fp_hash    bytea not null,
  created_at timestamptz not null default now(),
  primary key (letter_id, kind, fp_hash)
);

-- ── 필터 판정 로그 (본문 없음) ────────────────────────────
create table filter_events (
  id             bigserial primary key,
  risk_level     text not null,     -- 'low'|'medium'|'high'
  flags          jsonb not null,
  mode           text not null,
  -- 서버가 실제로 관측 가능한 값만 둔다 (§5 발견 5)
  --   'blocked'   = high, 저장 안 함
  --   'warned'    = medium, 인터스티셜을 띄웠고 결과는 아직 모름
  --   'published' = 생성됨 (low 즉시 / warned에서 confirmation으로 강행)
  outcome        text not null,
  created_at     timestamptz not null default now(),
  constraint outcome_values check (outcome in ('blocked','warned','published'))
);

-- ── 운영 ────────────────────────────────────────────────
create table admin_actions (
  id          bigserial primary key,
  action      text not null,
  target_id   text,
  note        text,
  created_at  timestamptz not null default now()
);

create table app_settings (
  -- 'public_read_enabled' · 'writing_enabled'는 운영자가, 'retention_healthy'는
  -- 파기 작업이 끈다 (D-031 · 07 §3)
  key    text primary key,
  value  jsonb not null
);

-- ── 법정 접속기록 (D-030) ───────────────────────────────
-- **별도 스키마다.** public에 두면 다른 표와 조인 가능한 자리에 놓이고, 그러면
-- "조인 키를 두지 않는다"가 규약일 뿐 구조가 아니게 된다.
-- 외래키도 request_id도 없다. 이 기록만으로는 누가 어떤 편지를 썼는지 알 수 없다
create schema audit;

create table audit.access_log (
  id            bigserial primary key,
  -- 원본 IP를 AES-256-GCM으로 봉인한 세 조각. 해시가 아닌 이유는 목적이 반대라서다 —
  -- fp_hash는 되돌릴 수 없어야 하고, 이 값은 적법한 요청에 되돌릴 수 있어야 한다
  ip_ciphertext bytea not null,
  ip_iv         bytea not null,
  ip_tag        bytea not null,
  -- "아주 거친 요청 분류". **이용자 요청 안에서 작성과 열람이 구분되지 않는다** —
  -- 구분하면 시각 대조로 "이 IP가 이 시각에 편지를 썼다"가 나온다
  channel       text not null,
  captured_at   timestamptz not null default now(),
  constraint channel_values check (channel in ('app','admin','cron'))
);
create index access_log_purge on audit.access_log (captured_at);

-- ── 격리 (D-028) ────────────────────────────────────────
-- 심각 카테고리 신고로 내려간 편지의 본문을 **옮겨** 담는다(복사가 아니다).
-- 접속기록과 반대로 **여기는 연결이 목적이라 외래키를 둔다** — 복원하려면
-- 어느 편지의 본문인지 알아야 한다
create schema quarantine;

create table quarantine.letter_content (
  letter_id          text primary key references public.letters(id) on delete cascade,
  -- 본문·단서·질문·답 해시·변형 해시를 JSON 한 덩어리로 묶어 봉인한다.
  -- 쪼개지 않는 이유: 필드가 늘 때마다 스키마가 바뀌고, 그 사이 마이그레이션에서
  -- 평문이 잠깐 드러나는 창이 생긴다
  content_ciphertext bytea not null,
  content_iv         bytea not null,
  content_tag        bytea not null,
  quarantined_at     timestamptz not null default now(),
  -- 적법한 영장·법원 명령·구체적 보존 요청이 있을 때만. 세우면 30일 시한이 멈춘다
  legal_hold         boolean not null default false
);
create index letter_content_deadline on quarantine.letter_content (quarantined_at)
  where legal_hold = false;
```

### 저장하지 않는 것

| 항목 | 이유 |
|---|---|
| 열쇠 답 원문 | HMAC만. 유출 시 전수 대입 가능성 차단 |
| 관리 토큰 원문 | 해시만. DB 유출로 전 편지 삭제 가능해지는 걸 막음 |
| 등급 'high' 편지 본문 | 게시 보류는 "다시 쓰세요"다. 서버에 남기면 그것도 보관이다. `filter_events`에 통계만. [M0 답](./00-decisions.md)이 이 설계를 확인했다 — **차단 원문 보관 테이블을 만들지 않는다** |
| User-Agent 원문 | 해시만(`fp_hash`) |
| ~~원본 IP~~ | 취소 — [D-030](./00-decisions.md)이 법정 접속기록으로 3개월 보관하게 했다 |

> **원본 IP는 이 스키마 안에 없다.** [D-030](./00-decisions.md)의 접속기록은 `audit` 스키마의 `access_log` 하나이고(`migrations/0004`), 위 표들과 잇는 조인 키를 두지 않는다 — 같은 곳에 두면 `fp_hash`로 분리해 둔 의미가 사라진다.
>
> 남기는 것은 봉인된 IP · 거친 요청 분류 · 시각 셋뿐이고, 편지 ID·본문·이메일·`fp_hash`·세션 ID·User-Agent·Referer는 **컬럼 자체가 없다.** [안전 테스트 26](./05-api.md)이 그걸 지킨다. 3개월 파기는 [파기 작업](./08-milestones.md)이 맡는다.

---

## 3. 상태 기계

```
      [제출]
        │
        ├── risk = high ──▶ 저장 안 함 (filter_events만)
        │
        └── risk = low|medium
                  │
                  ▼
            ┌──────────────┐
            │  published   │◀────────────┐
            └──────────────┘             │
              │   │   │                  │
              │   │   └─ 작성자 삭제 ──▶ deleted_by_author
              │   │
              │   └───── 운영자 조치 ──▶ hidden_admin
              │
              └─ 신고 1건 ──▶ hidden_auto
                                 │
                                 ├─ 문제없음 ──▶ published (auto_hide_exempt = true) ─┘
                                 └─ 위반 ──────▶ hidden_admin
                                                     │
                                                     └─ 이의 제기 인용 ──▶ published
                                                        (auto_hide_exempt = true)
```

**만료 상태가 없다.** 편지는 무기한 보관하고 자동으로 사라지지 않는다 ([D-024](./00-decisions.md)). 편지가 없어지는 길은 위 세 개 — 작성자 삭제 · 운영자 조치 · [삭제 요청](./07-operations.md) — 뿐이고, 그래서 그 셋이 실제로 동작하는지가 유일한 방어다.

**`status`만으로는 노출이 결정되지 않는다.** `published`인데 안 읽히는 편지가 둘 있다.

| 조건 | 어떻게 되나 |
|---|---|
| `risk_level = 'medium'` | 피드에서만 빠진다. 직접 링크는 열린다 |
| `classifier_state <> 'ok'` | **어디서도 안 읽힌다** — 판정이 끝날 때까지 보류 ([D-035](./00-decisions.md)) |

`classifier_state`를 새 `status` 값으로 만들지 않은 이유는 이 컬럼이 이미 §2에서 **"등급은 판정 결과고 이건 판정 과정이다"**로 정의돼 있기 때문이다. 보류는 조치가 아니라 과정이다.

### 삭제는 완전 파기다

[M0 답](./00-decisions.md)이 **soft delete를 폐기했다.**

| 전이 | 무엇이 남나 | 어디에 |
|---|---|---|
| 작성자 삭제 | **본문·단서·질문·답 해시·변형 해시를 실제로 파기**하고 `manage_token_hash`·상태·`deleted_at`만 남긴 tombstone ([D-027](./00-decisions.md)) | `migrations/0003` |
| **심각 카테고리 신고**로 내려간 편지 | 본문을 `quarantine.letter_content`로 옮긴다(복사 아님). 최대 30일 안에 삭제·복원·`legal_hold` 중 하나로 종결 ([D-028](./00-decisions.md)) | `migrations/0005` · 30일 종결은 [파기 작업](./08-milestones.md)이 강제한다 ([D-031](./00-decisions.md)) |
| 일반 신고(`targeting`·`impersonation`·`spam`·`other`)로 내려간 편지 | 격리하지 않는다. 본문은 `letters`에 남는다 | 대부분 `dismiss`되고, 전부 옮기면 판정 화면이 매번 복호를 탄다 |

**tombstone을 남기는 이유는 410이다.** 행을 통째로 지우면 관리 토큰을 찾을 수 없어 404가 되고, 작성자가 "내가 지웠다"와 "운영자가 내렸다"를 구분하지 못한다([05-api §2](./05-api.md) · [안전 테스트 11](./05-api.md)). 원문은 전부 사라지므로 파기 요구와 충돌하지 않는다.

**파기는 제약이 강제한다.** `deleted_is_purged`가 "상태는 삭제인데 본문이 남아 있는" 행을 거부한다 — 코드가 순서를 잊어도 DB가 막는다. [안전 테스트 25](./05-api.md)가 2차 방어다.

**`deleted_by_author`는 종착 상태다.** 작성자가 지운 편지를 운영자 판정이 되살리는 길은 없다 — 되살릴 본문 자체가 없다.

**파기된 편지에 열린 신고가 남을 수 있다.** 작성자가 신고 처리 전에 지우면 큐에 본문 없는 항목이 뜬다. 운영자는 판정할 내용이 없지만 신고를 닫을 수는 있어야 해서, 큐가 `body = null`을 "작성자가 삭제함"으로 그린다.

**격리와 파기는 `letters.body = null`을 공유하지만 뜻이 다르다.** 판별자는 `quarantined_at`이다 — 값이 있으면 격리(되돌릴 수 있다), 없으면 파기(되돌릴 수 없다). 큐 화면이 둘을 다른 문구로 그린다.

### `hidden_admin`에서 나가는 길이 있어야 한다

이 전이가 없으면 이의 제기가 **접수만 되고 끝난다.** 운영자가 판단을 바꿀 방법이 없으면 위협 모델 §4(비공개)가 요구한 "이의 제기 경로"는 화면만 있고 결과가 없는 장치가 된다.

인용 시 `auto_hide_exempt = true`를 함께 세운다 — 신고 `dismiss`와 같은 처리다. 한 번 사람이 들여다보고 되살린 편지가 같은 신고로 또 내려가면 이의 제기가 무의미해진다 (S-8(위협 모델, 비공개)).

### `auto_hide_exempt`가 필요한 이유

신고 1건 = 즉시 자동 비공개(위협 모델 §4(비공개))인데, 운영자가 "문제없음"으로 복귀시킨 편지가 또 신고당하면 다시 내려간다. 악의적 신고자 한 명이 무한 반복할 수 있다 (S-8(위협 모델, 비공개)).

→ 한 번 문제없음 판정을 받은 편지는 이후 자동 비공개 대상에서 빠지고, 신고는 큐에만 쌓인다.

**예외 — 심각 카테고리는 `auto_hide_exempt`를 무시한다.** S-5(위협 모델, 비공개)가 "신고 오면 내린다가 성립하지 않는 유일한 카테고리"라고 못박은 것과, exempt가 약속하는 "이 편지는 다시 안 내려간다"가 정면으로 만난다. 여기서는 S-5가 이긴다 ([D-025](./00-decisions.md)).

접수 시점에 미성년 여부를 알 수 없으므로 실제 판정은 신고 사유로 한다:

```
심각 카테고리 = reason in ('doxx', 'sexual', 'selfharm')
```

이 셋은 exempt와 무관하게 `hidden_auto`로 내려가고, [텔레그램 알림](./09-notifications.md)도 같은 집합으로 나간다. 나머지 넷(`targeting` · `impersonation` · `spam` · `other`)은 exempt가 그대로 막는다.

### 피드 노출 조건은 저장하지 않는다

`feed_visible`을 컬럼으로 두면 `status`·`risk_level`과 어긋날 수 있다. `status='published' AND risk_level='low'`로 파생하고 부분 인덱스로 처리한다.

**운영자가 medium 편지를 개별 승격하는 기능은 넣지 않는다.** 넣으면 사후 검토 모델에 다시 사람 병목이 생긴다. 오탐은 개별 승격이 아니라 필터를 고쳐서 해결한다.

---

## 4. 열쇠 답 정규화

[흐름 문서](./03-flows.md)에서 넘긴 미해결 항목.

```
1. 유니코드 NFC 정규화     ← 한글 자모 분리 입력(맥/윈도우 차이) 흡수
2. 앞뒤 공백 제거
3. 모든 내부 공백 제거     ← 한국어 띄어쓰기 불일치가 매우 흔함
4. 영문 소문자화
5. 문장부호 제거 (.,!?~·'"「」)
→ HMAC-SHA256(answer_key, letter_id || normalized)
```

`letter_id`를 키 재료에 넣어 편지별 솔트 역할을 시킨다. 같은 답을 쓴 두 편지의 해시가 같아지지 않는다.

**키 이름이 `server_secret`이 아니라 `answer_key`다.** 하나의 시크릿으로 열쇠와 레이트리밋 식별자를 동시에 만들면, 그 키를 교체하는 순간 **이미 게시된 잠긴 편지가 전부 영구히 안 열린다.** 용도별로 나눈 근거는 [D-017](./00-decisions.md).

### 완전 일치만으로는 진짜 수신자가 못 연다

위 규칙은 정규화 후 **완전 일치**다. `스타벅스` / `스벅` / `스타벅스 홍대점`이 전부 불일치한다. [흐름 2](./03-flows.md)는 "진짜 수신자가 한 번 틀렸다고 영영 못 여는 건 제품 실패"라고 못 박았는데, 시도 3회 안에서 이 표기 문제가 가장 흔한 실패 경로일 가능성이 높다.

→ 작성 시점에 분류기 호출로 **표기 변형 3~5개**를 생성하고, 각각에 같은 정규화·HMAC을 적용해 `answer_variant_hmacs`에 넣는다. 열람 시 `answer_hmac`과 이 배열을 함께 상수 시간 비교한다. **원문은 어느 쪽에도 저장되지 않는다** — 배열에 들어가는 것도 해시뿐이다.

의미가 같은 **표기** 변형만 만든다. 상위 개념이나 추측 가능한 일반명사로 넓히면 제3자 적중률이 올라가 S-6(위협 모델, 비공개)이 약해진다. 근거와 감수하는 위험은 [D-021](./00-decisions.md).

숫자 한글 표기 통일(`3` ↔ `삼`) 같은 건 넣지 않는다 — 오탐이 늘고 이득이 불확실하다.

### 재열람 — 한 번 연 사람은 다시 풀지 않는다

재방문할 때마다 답을 다시 맞혀야 하면 시도 3회를 재소모하고, 진짜 수신자가 자기 편지를 못 여는 상황이 생긴다 ([흐름 2](./03-flows.md)).

→ 해제 성공 시 `unlock_id`를 쿠키에 담고, 재방문 시 **DB 조회로 검증**한다. 쿠키에 `letter_id`를 직접 넣지 않는 이유는 그러면 누구나 위조해서 본문을 볼 수 있기 때문이다. 랜덤값 + DB 대조라 위조가 불가능하고 행 하나를 지우면 폐기된다 — [D-014](./00-decisions.md)의 관리 토큰과 같은 논리다.

`unique (letter_id, fp_hash)`를 함께 건다. 쿠키를 지우고 다시 푼 사람이 북극성 분자를 두 번 올리면 안 된다. 재해제는 기존 행을 유지하고 `recipient_response`를 덮어쓰지 않는다 — 첫 응답이 가장 정직하다.

쿠키 수명 **30일**은 가설값이다.

---

## 5. 검증 — 흐름 문서의 상태가 다 표현되는가

전부 대조했다. **구멍 5개가 나왔다.**

### ✅ 표현됨

피드 카드(잠김/열림 혼합), 관계 필터, 다단계 작성, 단서·질문·답, 인터스티셜(`risk_flags`), 관리 링크, 선택 이메일, 남은 시도 횟수, 시간 기반 회복, 열람 후 응답, 작성자 알림, OG 카드, 신고→자동 비공개, 킬 스위치.

### ⚠️ 발견 1 — 순차 ID면 '중간 등급 = 링크만' 방어가 무의미

이미 §1-1에서 반영. **이걸 놓쳤으면 피드 제외 로직 전체가 장식이 될 뻔했다.**

### ⚠️ 발견 2 — 이의 제기 경로가 흐름 문서에 없다

위협 모델 §4는 "자동 비공개 → 작성자에게 알림 + 이의 제기 경로"라고 했는데, 흐름 문서에 그 화면이 없다. 이메일을 안 남긴 작성자는 자기 편지가 내려간 사실조차 모른다.

→ `/manage/:token`에 현재 상태와 이의 제기 버튼을 붙인다. `appeals` 테이블 추가 (§6).

### ⚠️ 발견 3 — 삭제 요청 폼의 처리 대상이 없었다

흐름 문서 화면 목록에 `/delete-request`가 있는데 저장할 곳이 없었다. `deletion_requests` 추가. 운영자 큐에 신고와 별도 항목으로 뜬다.

### ⚠️ 발견 4 — "동일 대상 반복 작성 시도율"은 v0에서 측정 불가

위협 모델의 방어 지표에 들어 있는데, v0에는 **수신자 식별자가 존재하지 않는다.** 누구에게 보낸 편지인지 데이터에 없으므로 "같은 대상"을 정의할 수 없다.

→ 지표에서 뺀다 (§6). 근사가 필요하면 `author_fp_hash` + 단서 유사도로 추정할 수 있으나, v0에서는 하지 않는다.

### ⚠️ 발견 5 — "열람 후 불쾌 응답률"도 수집 지점이 없다

흐름 문서는 열람 후 `당신에게 온 것 같나요?` 하나만 묻는다. 질문을 하나 더 붙이면 마찰이 늘고 응답률이 떨어진다.

→ 이 지표는 **신고율로 대체**한다. 그리고 위협 모델의 "단서 검토 반려율"도 사전 검토가 없으니 성립하지 않는다 — **인터스티셜 회귀율**([계측 §6](./06-analytics.md) #6, `filter_revised / filter_warned`)로 대체한다. 이건 오히려 더 유용하다: 경고 문구가 실제로 작동하는지를 직접 측정한다.

소스는 **클라이언트 이벤트**다. 서버는 사용자가 고쳤는지 그냥 나갔는지 볼 수 없다 — 수정 후 재제출은 별개의 요청으로 들어오고, 이탈은 요청 자체가 없다.

그래서 `filter_events.outcome`은 서버가 아는 세 값(`blocked` · `warned` · `published`)으로 좁혔다. **`warned` → `published` 갱신만 서버 진실로 남는다** — `confirmation` 토큰이 1차 판정 행의 id를 서명해 실어 나르므로, 재제출이 오면 그 행을 `published`로 올린다([API §1](./05-api.md)). 강행률은 이 컬럼으로, 회귀·이탈은 이벤트로 본다.

---

## 6. 후속 조치

| 대상 | 내용 | 상태 |
|---|---|---|
| `03-flows.md` | 이의 제기 화면 추가 (발견 2) | ✅ 반영 |
| `01-product.md` | 방어 지표 교체 — 동일 대상 반복 삭제, 불쾌 응답률→신고율, 단서 반려율→인터스티셜 회귀율 (발견 4·5) | ✅ 반영 |

## 미해결

- ~~`fp_hash` 산출 방식~~ → [API §5](./05-api.md)에서 확정. 헤더 우선순위·IPv6 /64 절단 규칙과 그 근거가 거기 있고, 구현은 `src/lib/fingerprint.ts`다
- ~~`fp_hash` 보관 기간~~ → [D-031](./00-decisions.md)이 90일로 확정
- ~~편지 보관 기간~~ → [D-024](./00-decisions.md) 무기한 보관으로 확정. `expires_at`과 `expired` 상태를 뺐다
- ~~`risk_flags` 스키마~~ → [D-020](./00-decisions.md)의 스키마 강제 출력으로 확정됨 ([API §1](./05-api.md))

## 다음 문서

`05-api.md` — 엔드포인트, 레이트리밋 위치, 열쇠 검증 경로. 그다음 `06-analytics.md`.
