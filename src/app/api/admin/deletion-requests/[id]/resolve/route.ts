// `POST /api/admin/deletion-requests/:id/resolve` `{ letterId, note? }` (07 §5).
//
// ── 이 엔드포인트는 05-api §4 표에 없었다 ───────────────────
// 07 §1의 매일 루틴에 "삭제 요청 → §5"가 있고 04 §2의 `deletion_requests`에는
// `status`·`resolved_at` 컬럼이 이미 있는데, 큐에서 내리는 경로가 없어 목록이 무한히
// 쌓이는 상태였다. **코디네이터 판단으로 추가했고 05-api §4와 07 §5에 함께 적었다.**
//
// `letterId`가 필수인 이유: 대조는 **운영자가 사람으로** 한다 (04 §5 발견 3 · 07 §5).
// 서버가 `body_excerpt`로 편지를 찾아 지우면 본문 일부만 아는 사람이 남의 편지를 지울 수
// 있다. 접수 시 비워둔 `letter_id`를 이 호출이 채운다.
//
// 편지는 `deleted_by_author`가 된다 — 관리 링크를 잃어버렸을 뿐 결국 작성자 본인의
// 삭제다 (07 §5 · 05-api §2 표).

import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { resolveDeletionRequest } from "@/lib/admin/queue";
import { conflict, invalidRequest, notFound } from "@/lib/errors";

interface Context {
  params: Promise<{ id: string }>;
}

/** 07 §2 원칙 3의 한 줄. 500자는 **가설값**이다. */
const NOTE_MAX = 500;

const schema = z.object({
  letterId: z.string().trim().min(1),
  note: z.string().trim().max(NOTE_MAX).optional(),
});

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  const requestId = Number(id);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) return notFound();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest("요청 형식이 올바르지 않습니다.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest("대조한 편지 ID를 함께 보내 주세요.");
  }

  const { letterId, note } = parsed.data;
  const outcome = await resolveDeletionRequest(
    requestId,
    letterId,
    note ? note : null,
  );
  if (outcome === "not_found") return notFound();
  if (outcome === "letter_not_found") {
    return invalidRequest("그 ID의 편지가 없습니다. 대조한 ID를 확인해 주세요.");
  }
  if (outcome === "already_resolved") {
    return conflict("이미 처리된 삭제 요청입니다.");
  }

  return new Response(null, { status: 204 });
}
