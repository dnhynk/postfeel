-- D-030 · 법정 접속기록을 3개월 분리 보관한다.
--
-- 출처: docs/00-decisions.md D-030 (M0 답 · 2026-08-16)
--
-- ── 왜 별도 스키마인가 ──────────────────────────────────────
-- D-030이 "일반 DB의 letters·events·fp_hash 테이블과 물리적 또는 최소한 논리적으로
-- 분리한다"를 요구한다. v0는 Postgres 한 덩어리를 쓰므로(D-018) **스키마 분리**가
-- 논리적 분리의 실현이다. `public`에 두면 이 표가 다른 표와 조인 가능한 자리에 놓이고,
-- 그러면 "조인 키를 두지 않는다"가 규약일 뿐 구조가 아니게 된다.
--
-- ── 조인 키가 없다 ──────────────────────────────────────────
-- **이 표에는 letters·events·author_contacts 어디로도 향하는 외래키가 없다.**
-- 공통 request_id도 두지 않는다 (D-030). 그래서 "이 편지를 누가 썼는가"에 답할 수
-- 없다 — 답할 수 있는 것은 "이 시각에 이 IP가 접속했다"까지다.
--
-- **남는 위험은 시각 대조다.** letters.created_at과 여기 captured_at을 맞추면 후보가
-- 좁혀진다. 그래서 `channel`을 거칠게 둔다(아래).
--
-- ── 넣지 않는 것 (D-030) ────────────────────────────────────
-- 편지 ID · 본문 · 단서 · 질문 · 답 · 이메일 · fp_hash · 세션 ID · 쿠키 ·
-- User-Agent · Referer · query string. **컬럼이 없으므로 실수로 넣을 수 없다.**
--
-- ── 조회 권한 ───────────────────────────────────────────────
-- D-030은 "애플리케이션 일반 코드에서는 쓰기만 가능하고 조회는 불가능"을 요구한다.
-- **여기서 GRANT로 강제하지 않는다.** 마이그레이션과 앱이 같은 역할로 붙고, WHERE 절이
-- 있는 DELETE(파기 잡)가 SELECT 권한을 요구하기 때문에 소유자에게서 SELECT를 뺏으면
-- 파기가 죽는다. 역할 분리는 **배포 시 별도 DB 사용자**로 한다 (08 M7 · 배포 체크리스트).
--
-- 코드 쪽 방어는 둘이다: 이 표를 읽는 함수를 만들지 않았고(src/lib/access-log.ts),
-- 그 사실을 테스트가 지킨다.

create schema if not exists audit;

create table audit.access_log (
  id            bigserial primary key,

  -- 원본 IP. AES-256-GCM으로 봉인해 세 조각으로 나눠 담는다 (src/lib/crypto.ts `seal`).
  -- 해시가 아니라 암호화인 이유: 적법한 요청에 되돌릴 수 있어야 보관 의무를 이행한 것이다.
  ip_ciphertext bytea not null,
  ip_iv         bytea not null,
  ip_tag        bytea not null,

  -- "아주 거친 요청 분류" (D-030). **이용자 요청 안에서 작성과 열람이 구분되지 않는다.**
  -- 구분하면 시각 대조로 "이 IP가 이 시각에 편지를 썼다"가 나오고, 그건 조인 키를
  -- 없앤 이유를 무너뜨린다. 운영상 필요한 구분(운영자·크론)만 남긴다.
  channel       text not null,

  captured_at   timestamptz not null default now(),

  constraint channel_values check (channel in ('app', 'admin', 'cron'))
);

-- 파기 잡이 훑을 대상 (D-031 · 3개월). 이 인덱스가 없으면 매 회차가 전체 스캔이다.
create index access_log_purge on audit.access_log (captured_at);
