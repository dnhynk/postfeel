// `POST /api/admin/reports/:id/resolve` `{ action: 'uphold' | 'dismiss' }` (05-api §4).
//
//   uphold   위반 → 편지를 `hidden_admin`으로 (04 §3)
//   dismiss  문제없음 → `published` + **`auto_hide_exempt = true`** (07 §2 원칙 2)
//
// `dismiss`가 exempt를 세우는 이유: 되살린 편지가 같은 신고로 또 내려가면 악의적
// 신고자 한 명이 무한 반복할 수 있다 (S-8 · 04 §3). 심각 카테고리는 그래도 뚫는다
// (D-025 — 신고 표면이 판단한다).
//
// `note`는 05-api §4의 요청 형태에 없지만 07 §2 원칙 3이 **판정 이유를
// `admin_actions.note`에 한 줄** 남기라고 했다. 그 한 줄이 들어올 자리라 선택 필드로 둔다.

import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { resolveReport } from "@/lib/admin/queue";
import { conflict, invalidRequest, notFound } from "@/lib/errors";

interface Context {
  params: Promise<{ id: string }>;
}

/** 한 줄이면 된다 (07 §2 원칙 3). 500자는 **가설값**이다 — 문서에 상한이 없다. */
const NOTE_MAX = 500;

const schema = z.object({
  action: z.enum(["uphold", "dismiss"]),
  note: z.string().trim().max(NOTE_MAX).optional(),
});

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  const reportId = Number(id);
  if (!Number.isSafeInteger(reportId) || reportId <= 0) return notFound();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest("요청 형식이 올바르지 않습니다.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest("판정은 uphold 또는 dismiss입니다.");
  }

  const { action, note } = parsed.data;
  const outcome = await resolveReport(reportId, action, note ? note : null);
  if (outcome === "not_found") return notFound();
  if (outcome === "already_resolved") {
    return conflict("이미 판정된 신고입니다.");
  }

  return new Response(null, { status: 204 });
}
