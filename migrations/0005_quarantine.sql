-- D-028 · 임시 차단은 30일 격리 후 반드시 종결한다.
--
-- 출처: docs/00-decisions.md D-028 (M0 답 · 2026-08-16) · docs/04-data-model.md §3
--
-- ── 무엇이 격리되는가 ───────────────────────────────────────
-- **심각 카테고리(`doxx`·`sexual`·`selfharm`) 신고로 자동 비공개된 편지만.**
--
-- M0 답이 "권리침해 여부나 작성자 이의를 **처리할 필요가 있는 경우에만**"으로 범위를
-- 열어 뒀고, 그 질문이 나온 맥락은 미성년 성적 콘텐츠(Q1-b)였다. 내려간 편지 전부를
-- 옮기지 않는 이유는 둘이다.
--   · 일반 신고는 대부분 dismiss된다. 전부 암호화 이동하면 판정 화면이 매번 복호를 탄다
--   · 신고 1건으로 자동 비공개되는 정상 편지까지 매번 옮기게 된다
--
-- ── 복사가 아니라 이동이다 ──────────────────────────────────
-- `letters`의 본문 계열을 **비우고** 여기로 옮긴다. 양쪽에 두면 격리가 아니라 사본이
-- 하나 늘어나는 것이고, 그건 D-027이 없앤 상태로 되돌아가는 것이다.
--
-- 그래서 0003이 세운 제약 둘을 완화한다. 격리 중인 행은 본문이 없어도 정상이다.
-- 판별자는 `letters.quarantined_at`이다 — CHECK 제약에서 다른 표를 볼 수 없으므로
-- 편지 쪽에 표식이 있어야 한다.
--
-- ── 외래키가 있다 (access_log와 다르다) ─────────────────────
-- 0004의 접속기록은 조인 키를 **금지**했다. 여기는 반대로 **연결이 목적**이다 —
-- 복원하려면 어느 편지의 본문인지 알아야 한다. 두 표의 규칙이 다른 이유가 이것이다.
--
-- ── 30일과 legal_hold ───────────────────────────────────────
-- `quarantined_at + 30일`이 시한이다. 그 안에 완전 삭제 · 복원 · legal_hold 중 하나로
-- 끝낸다. `legal_hold = true`면 시한이 멈춘다 — 적법한 영장·법원 명령·구체적 보존
-- 요청이 있을 때만 세운다.
--
-- **이의 제기가 pending이면 자동 파기하지 않는다** (사용자 판단, 2026-08-16). 대신
-- 시한을 넘긴 항목이 운영 큐에 뜬다. 운영자가 못 본 대가를 작성자가 지지 않게 하되,
-- 넘긴 사실 자체는 드러나야 하기 때문이다. 파기 잡은 D-031에서 만든다.

create schema if not exists quarantine;

create table quarantine.letter_content (
  -- 복원 대상. **여기는 조인이 목적이라 외래키를 둔다** (위 주석).
  letter_id          text primary key
                       references public.letters(id) on delete cascade,

  -- 본문·단서·질문·답 해시·변형 해시를 JSON 한 덩어리로 묶어 AES-256-GCM으로 봉인한다.
  -- 컬럼을 쪼개지 않는 이유: 필드가 늘 때마다 스키마가 바뀌고, 그 사이 마이그레이션에서
  -- 평문이 잠깐 드러나는 창이 생긴다.
  content_ciphertext bytea not null,
  content_iv         bytea not null,
  content_tag        bytea not null,

  quarantined_at     timestamptz not null default now(),

  -- 적법한 영장·법원 명령·구체적 보존 요청이 있을 때만. 세우면 30일 시한이 멈춘다.
  legal_hold         boolean not null default false
);

-- 시한 만료 조회 (D-031 파기 잡 · 운영 큐). legal_hold는 대상이 아니다.
create index letter_content_deadline on quarantine.letter_content (quarantined_at)
  where legal_hold = false;

-- ── letters 쪽 표식과 제약 완화 ─────────────────────────────

alter table letters add column quarantined_at timestamptz;

-- 격리 중인 행은 본문이 없어도 정상이다.
alter table letters drop constraint body_present_unless_deleted;
alter table letters add constraint body_present_unless_deleted check (
  status = 'deleted_by_author'
  or quarantined_at is not null
  or body is not null
);

-- 잠긴 편지도 격리되면 hint·question·answer_hmac이 비워진다.
alter table letters drop constraint locked_fields;
alter table letters add constraint locked_fields check (
  status = 'deleted_by_author'
  or quarantined_at is not null
  or (mode = 'locked' and hint is not null and question is not null and answer_hmac is not null)
  or (mode = 'open'   and hint is null     and question is null     and answer_hmac is null)
);

-- 격리 표식이 있으면 본문이 letters에 남아 있으면 안 된다. 이동을 강제하는 제약이고,
-- 0003의 `deleted_is_purged`와 같은 역할이다 — 코드가 절반만 하면 DB가 거부한다.
alter table letters add constraint quarantined_is_moved check (
  quarantined_at is null
  or (body is null
      and hint is null
      and question is null
      and answer_hmac is null
      and answer_variant_hmacs = '{}')
);
