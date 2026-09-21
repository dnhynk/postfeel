// `POST /api/admin/letters/:id/hide` (05-api §4 · 02 §5 「개별 킬 스위치」).
//
// 신고를 거치지 않고 편지 하나를 즉시 비공개로 내린다 — `hidden_admin` (04 §3). 07 §4의
// 긴급 대응 1번("해당 편지 즉시 비공개")이 쓰는 경로다.
//
// 상태 전이와 `admin_actions` 기록은 `deletion.ts`의 `hideByAdmin`이 한 트랜잭션으로 한다.

import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { invalidRequest, notFound } from "@/lib/errors";
import { hideByAdmin } from "@/lib/letters/deletion";

interface Context {
  params: Promise<{ id: string }>;
}

/** 07 §2 원칙 3의 한 줄. 500자는 **가설값**이다. */
const NOTE_MAX = 500;

const schema = z.object({
  note: z.string().trim().max(NOTE_MAX).optional(),
});

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;

  // 본문은 통째로 선택이다 — 이유 없이도 내릴 수 있어야 한다 (07 §4는 1분을 준다).
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest(`판정 이유는 ${NOTE_MAX}자까지 쓸 수 있습니다.`);
  }

  const note = parsed.data.note;
  // 없는 편지와 이미 지워진 편지는 404다 — 지워진 편지를 다시 내릴 이유가 없다.
  const hidden = await hideByAdmin(id, note ? note : null);
  if (!hidden) return notFound();

  return new Response(null, { status: 204 });
}
