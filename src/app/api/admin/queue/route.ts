// `GET /api/admin/queue` (05-api §4 · 07 §1 · §2).
//
// 미판정 신고 · 자동 비공개 건 · 이의 제기 · 삭제 요청 네 종류를 한 번에 준다.
//
// **킬 스위치를 보지 않는다.** 05-api §6의 표에서 `public_read_enabled`가 막지 않는 쪽에
// 운영자 API가 있다 — 읽기를 끈 상태가 바로 큐를 열어야 하는 상태다.

import { requireAdmin } from "@/lib/admin/auth";
import { loadQueue } from "@/lib/admin/queue";

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  return Response.json(await loadQueue());
}
