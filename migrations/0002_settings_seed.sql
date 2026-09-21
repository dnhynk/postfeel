-- 킬 스위치 기본값 (05-api §6 · 07-operations §3).
--
-- 0001은 app_settings 테이블만 만들고 행을 넣지 않았다. 두 스위치는 운영자가 끄고
-- 켜는 값이라 행이 실제로 있어야 한다 — POST /api/admin/settings가 update로 동작하고,
-- 켜져 있다는 사실이 데이터로 확인된다.
--
-- src/lib/settings.ts는 행이 없으면 "켜짐"으로 본다. 그게 이 seed와 어긋나지 않는
-- 이유: 마이그레이션이 덜 돈 환경에서 서비스가 통째로 죽는 쪽이 더 나쁘고, 행이 없는
-- 것은 "끄기로 했다"가 아니기 때문이다.

insert into app_settings (key, value) values
  ('public_read_enabled', 'true'::jsonb),
  ('writing_enabled',     'true'::jsonb)
on conflict (key) do nothing;
