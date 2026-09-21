// `POST /api/deletion-requests` (05-api §2 「나머지」 · 04 §5 발견 3 · 07 §5).
//
// 관리 링크를 잃어버린 작성자의 경로다. 관리 토큰은 작성 응답에서만 나오고 재발급이
// 없어서(05-api §2), 이 폼이 없으면 링크를 잃은 사람에게는 삭제 경로가 아예 없다 —
// S-9(작성자 후회)가 요구한 세 경로 중 하나다.
//
// **자동으로 편지를 찾아 지우지 않는다.** 본인 확인은 본문 일부 대조이고, 그 대조는
// 운영자가 사람으로 한다 (07 §5). 서버가 본문으로 편지를 찾아 지우면 본문 일부만 아는
// 사람이 남의 편지를 지울 수 있다. 여기서는 접수만 하고 큐에 쌓는다.

import { z } from "zod";
import { invalidRequest } from "@/lib/errors";
import { insertDeletionRequest } from "@/lib/letters/deletion";

/** 본문 상한과 같게 잡는다 (04 §2 `letters.body` 500자). 발췌가 본문보다 길 수 없다. */
const EXCERPT_MAX = 500;
/** 회신용 연락처. 200자는 **가설값이다** — 문서에 상한이 없다. */
const CONTACT_MAX = 200;

const schema = z.object({
  bodyExcerpt: z.string().trim().min(1).max(EXCERPT_MAX),
  contact: z.string().trim().max(CONTACT_MAX).optional(),
});

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest("요청 형식이 올바르지 않습니다.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest(
      `편지 본문의 일부를 ${EXCERPT_MAX}자 안에서 적어 주세요.`,
    );
  }

  const { bodyExcerpt, contact } = parsed.data;
  await insertDeletionRequest(bodyExcerpt, contact ? contact : null);

  // 05-api §5의 레이트리밋 표에 이 엔드포인트가 없다. 임의로 만들지 않는다 — 필요해지면
  // 05-api를 먼저 고친다.
  return new Response(null, { status: 204 });
}
