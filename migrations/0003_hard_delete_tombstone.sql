-- D-027 · 삭제는 완전 파기다. 상태만 바꾸는 soft delete를 쓰지 않는다.
--
-- 출처: docs/00-decisions.md D-027 (M0 답 · 2026-08-16) · docs/04-data-model.md §3
--
-- ── 왜 행을 지우지 않고 tombstone을 남기는가 ────────────────
-- 행을 통째로 지우면 `manage_token_hash`로 찾을 수 없어 GET /api/manage/:token이 404가
-- 된다. 그러면 작성자가 **"내가 지웠다"와 "운영자가 내렸다"를 구분하지 못한다** —
-- 05-api §2가 전자에 410을, 후자에 200 + 이의 제기를 주기로 한 이유가 사라진다.
-- 안전 테스트 #11이 그 410을 고정하고 있다.
--
-- 그래서 남기는 것은 셋뿐이다: `manage_token_hash` · `status` · `deleted_at`.
-- **원문은 전부 사라지므로 파기 요구와 충돌하지 않는다.**
--
-- ── 제약으로 강제하는 이유 ──────────────────────────────────
-- 0001이 "허용값을 주석이 아니라 제약으로 둔다. 오타 하나가 편지를 조회 불가 상태로
-- 만든다"고 적었다. 여기서는 반대 방향이 더 위험하다 — **파기했다고 적어두고 본문이
-- 남는 것**은 조회 불가보다 나쁘고, 코드를 읽어서는 발견되지 않는다.
-- `deleted_is_purged`가 그 상태를 스키마에서 불가능하게 만든다.
--
-- ── 지우지 않는 것 ──────────────────────────────────────────
-- `author_fp_hash`는 여기서 지우지 않는다. D-031이 `fp_hash`에 90일 수명을 따로 줬고,
-- 그 파기는 편지 삭제가 아니라 **시간**이 트리거다. 두 규칙을 한곳에 섞으면 어느 쪽이
-- 실제로 지웠는지 알 수 없어진다.
-- `risk_flags`는 본문이 아니라 판정 결과(유형 코드 배열)라 남긴다.

-- 1. 본문 계열 컬럼을 열어 준다. tombstone에서는 전부 null이 된다.
alter table letters alter column body drop not null;

-- 2. 기존 제약은 잠긴 편지에 hint·question·answer_hmac이 반드시 있기를 요구한다.
--    tombstone은 그 셋이 없으므로 그대로 두면 파기가 불가능하다.
alter table letters drop constraint locked_fields;

-- 3. 이미 soft delete된 행이 있으면 여기서 실제로 파기한다.
--    **이 UPDATE가 이 마이그레이션의 본체다.** 아래 제약은 재발을 막을 뿐이고,
--    이미 남아 있는 본문은 이 문장이 지운다.
update letters
   set body                 = null,
       hint                 = null,
       question             = null,
       answer_hmac          = null,
       answer_variant_hmacs = '{}'
 where status = 'deleted_by_author';

-- 4. 잠금 필드 규칙을 되살리되 tombstone을 예외로 둔다.
alter table letters add constraint locked_fields check (
  status = 'deleted_by_author'
  or (mode = 'locked' and hint is not null and question is not null and answer_hmac is not null)
  or (mode = 'open'   and hint is null     and question is null     and answer_hmac is null)
);

-- 5. 살아 있는 편지에는 본문이 반드시 있다. `drop not null`이 연 구멍을 여기서 닫는다.
alter table letters add constraint body_present_unless_deleted check (
  status = 'deleted_by_author' or body is not null
);

-- 6. **삭제됐으면 원문이 하나도 남아 있지 않다.** D-027의 본문.
alter table letters add constraint deleted_is_purged check (
  status <> 'deleted_by_author'
  or (body is null
      and hint is null
      and question is null
      and answer_hmac is null
      and answer_variant_hmacs = '{}')
);
