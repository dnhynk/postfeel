// `POST /api/manage/:token/appeal` (05-api §3).
//
// 위협 모델 §4가 요구한 이의 제기 경로다. 자동 비공개는 사람 판단 없이 즉시 내리고
// 판정을 나중에 하는 구조라(02 §4), 작성자가 그 판정을 되돌릴 요청을 넣는 자리가 여기다.
// 결론은 운영자가 낸다 — `POST /api/admin/appeals/:id/resolve` (05-api §4).

import { z } from "zod";
import { ensureSession, withSession } from "@/lib/analytics/session";
import { conflict, gone, invalidRequest, notFound } from "@/lib/errors";
import { record } from "@/lib/events";
import { canAppeal, findByManageToken, insertAppeal } from "@/lib/letters/manage";

interface Context {
  params: Promise<{ token: string }>;
}

/** 1000자는 **가설값이다** — 문서에 상한이 없다. 실측 후 조정한다. */
const MESSAGE_MAX = 1000;

const schema = z.object({
  message: z.string().trim().max(MESSAGE_MAX).optional(),
});

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { token } = await context.params;

  // 익명 세션 쿠키. `appeal_submitted`(06 §3)가 서버 이벤트라 여기서 세운다.
  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  const letter = await findByManageToken(token);
  if (!letter) return respond(notFound());

  if (letter.status === "deleted_by_author") return respond(gone());
  if (letter.status === "published") {
    return respond(
      invalidRequest("공개 상태인 편지에는 이의를 제기할 수 없습니다."),
    );
  }
  if (!canAppeal(letter)) {
    return respond(conflict("이미 이의를 제기한 편지입니다."));
  }

  // 본문은 통째로 선택이다 — 빈 요청도 정당한 이의 제기다.
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return respond(invalidRequest(`설명은 ${MESSAGE_MAX}자까지 쓸 수 있습니다.`));
  }

  const message = parsed.data.message;
  await insertAppeal(letter.id, message ? message : null);

  // `appeal_submitted` (06 §3). **props가 없다** — 문서의 props 열이 비어 있고, 여기서
  // 담을 수 있는 값(편지 ID · 이의 내용)은 전부 06 §2가 금지한 것이다. 접수됐다는 사실
  // 하나가 이 이벤트의 전부다. 이의 제기 행은 이미 들어갔으므로 기록 실패로 되돌리지 않는다.
  try {
    await record("appeal_submitted", session.sessionId);
  } catch {
    // 이의 제기 접수를 계측 실패로 깨지 않는다.
  }

  return respond(new Response(null, { status: 204 }));
}
