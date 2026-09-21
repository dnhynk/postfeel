// `POST /api/admin/settings` `{ publicReadEnabled?, writingEnabled? }` (05-api §4 · 07 §3).
//
// 전역 킬 스위치 둘. **1클릭 + 확인 다이얼로그 1회**가 화면 쪽 규칙이다 (02 §5).
//
// 두 스위치의 차이는 07 §3이고 화면이 그 한 줄을 그대로 띄운다:
//   **자리를 비울 때는 읽기가 아니라 작성을 끈다.**

import { z } from "zod";
import { requireAdmin } from "@/lib/admin/auth";
import { updateSettings } from "@/lib/admin/settings";
import { invalidRequest } from "@/lib/errors";
import { publicReadEnabled, writingEnabled } from "@/lib/settings";

/** 07 §2 원칙 3의 한 줄. 500자는 **가설값**이다. */
const NOTE_MAX = 500;

const schema = z
  .object({
    publicReadEnabled: z.boolean().optional(),
    writingEnabled: z.boolean().optional(),
    note: z.string().trim().max(NOTE_MAX).optional(),
  })
  .refine(
    (value) =>
      value.publicReadEnabled !== undefined ||
      value.writingEnabled !== undefined,
    { message: "바꿀 스위치가 없습니다." },
  );

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest("요청 형식이 올바르지 않습니다.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest("바꿀 스위치를 지정해 주세요.");
  }

  const { note, ...patch } = parsed.data;
  await updateSettings(patch, note ? note : null);

  // 바뀐 값을 DB에서 다시 읽어 돌려준다 — 화면이 자기 상태를 추측하지 않게. 캐시가
  // 없으므로(settings.ts) 이 값이 곧 다음 요청이 볼 값이다.
  return Response.json({
    publicReadEnabled: await publicReadEnabled(),
    writingEnabled: await writingEnabled(),
  });
}
