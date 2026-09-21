-- PostFeel v0 초기 스키마
--
-- 출처: docs/04-data-model.md §2 (전문) + docs/06-analytics.md §1 (events)
-- 문서가 진실이다. 여기에 문서에 없는 컬럼·테이블·제약을 더하지 않는다.
--
-- 의도적으로 없는 것:
--   · expires_at / expired 상태  → D-024 (편지는 무기한 보관, 자동 파기 없음)
--   · 모드 C 관련 테이블         → 04 §범위 (쓰지 않을 컬럼을 미리 두지 않는다)
--   · 레이트리밋 카운터 테이블   → 05-api §5 ("별도 카운터 테이블은 두지 않는다")

-- ── 편지 ────────────────────────────────────────────────
create table letters (
  id                text primary key,          -- nanoid(22), 추측 불가 (§1-1)
  mode              text not null,             -- 'open' | 'locked'
  relationship      text not null,             -- 'ex'|'friend'|'family'|'coworker'|'other'
  body              text not null,             -- 최대 500자 (가설값)

  -- locked 모드 전용
  hint              text,                      -- 공개됨
  question          text,                      -- 공개됨
  answer_hmac       bytea,                     -- HMAC(answer_key, id || normalize(answer)). 원문 저장 안 함
  answer_variant_hmacs bytea[] not null default '{}',  -- 표기 변형 3~5개의 HMAC (D-021). 원문은 여기도 없다

  -- 자동 등급 (위협 모델 §2)
  risk_level        text not null,             -- 'low' | 'medium'   ('high'는 저장되지 않음)
  risk_flags        jsonb not null default '[]',  -- 분류기 응답의 flags 배열 그대로 (스키마는 API §1)

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

  constraint locked_fields check (
    (mode = 'locked' and hint is not null and question is not null and answer_hmac is not null)
    or (mode = 'open' and hint is null and question is null and answer_hmac is null)
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
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
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
  key    text primary key,   -- 'public_read_enabled', 'writing_enabled'
  value  jsonb not null
);

-- ── 계측 (06-analytics.md §1) ────────────────────────────
-- 외부 분석 도구를 붙이지 않는다. 편지 ID·이메일·본문은 여기 담기지 않는다 (§2)
create table events (
  id          bigserial primary key,
  name        text not null,
  session_id  text not null,      -- 익명 랜덤, 쿠키. 계정 아님
  props       jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index events_name_time on events (name, created_at desc);
