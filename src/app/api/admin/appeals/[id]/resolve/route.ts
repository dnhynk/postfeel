// `POST /api/admin/appeals/:id/resolve` `{ action: 'restore' | 'reject' }` (05-api §4).
//
//   restore  인용 → `published` + **`auto_hide_exempt = true`** (신고 `dismiss`와 같다)
//   reject   반려 → **편지 상태를 바꾸지 않고** `appeals.status`만 기록
//
// **이 엔드포인트가 없으면 이의 제기가 접수만 되고 결론이 없다** (04 §3 · 05-api §4).
// 위협 모델 §4가 요구한 "이의 제기 경로"가 화면만 있고 결과가 없는 장치가 된다.

import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { resolveAppeal } from "@/lib/admin/queue";
import { conflict, invalidRequest, notFound } from "@/lib/errors";

interface Context {
  params: Promise<{ id: string }>;
}

/** 07 §2 원칙 3의 한 줄. 500자는 **가설값**이다. */
const NOTE_MAX = 500;

const schema = z.object({
  action: z.enum(["restore", "reject"]),
  note: z.string().trim().max(NOTE_MAX).optional(),
});

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  const appealId = Number(id);
  if (!Number.isSafeInteger(appealId) || appealId <= 0) return notFound();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest("요청 형식이 올바르지 않습니다.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest("판정은 restore 또는 reject입니다.");
  }

  const { action, note } = parsed.data;
  const outcome = await resolveAppeal(appealId, action, note ? note : null);
  if (outcome === "not_found") return notFound();
  if (outcome === "already_resolved") {
    return conflict("이미 판정된 이의 제기입니다.");
  }

  return new Response(null, { status: 204 });
}
