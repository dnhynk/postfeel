// `GET /api/manage/:token` · `DELETE /api/manage/:token` (05-api §3).
//
// **킬 스위치를 여기서 보지 않는다.** `public_read_enabled = false`여도 계속 동작한다
// (05-api §6 · 07 §3) — 사고 대응 중에도 작성자는 자기 편지를 지울 수 있어야 한다.
// 안전 테스트 #15가 고정한다.
//
// **틀린 토큰은 어느 편지에 대한 시도인지 흘리지 않는다.** 404 본문은 편지와 무관한
// 고정 문구 하나이고(errors.ts `notFound`), 이 파일은 아무것도 로그로 남기지 않는다.
//
// `POST /api/manage/:token/contact`(이메일 등록)는 여기 없다 — 발송 표면의 것이다.

import { ensureSession, withSession } from "@/lib/analytics/session";
import { gone, notFound } from "@/lib/errors";
import { record } from "@/lib/events";
import { deleteByAuthor } from "@/lib/letters/deletion";
import { findByManageToken, manageView } from "@/lib/letters/manage";

interface Context {
  params: Promise<{ token: string }>;
}

/** 06 §3 `letter_deleted { ageHours }`. 밀리초를 시간으로. */
const HOUR_MS = 3_600_000;

export async function GET(request: Request, context: Context): Promise<Response> {
  const { token } = await context.params;

  // 익명 세션 쿠키. `manage_view`(06 §3)가 서버 이벤트라 여기서 세운다.
  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  const letter = await findByManageToken(token);
  if (!letter) return respond(notFound());

  // `manage_view { status }` (06 §3). **틀린 토큰에서는 보내지 않는다** — 위에서 이미
  // 404로 나갔다. 존재하지 않는 토큰까지 세면 관리 화면 방문 수에 스캔 시도가 섞인다.
  // **편지 ID는 담지 않는다** (06 §2). `status`만 담는다.
  try {
    await record("manage_view", session.sessionId, { status: letter.status });
  } catch {
    // 관리 화면 조회를 계측 실패로 깨지 않는다.
  }

  // 05-api §2: 토큰 소지자는 작성자 본인이므로 "이미 지웠다"를 알려주는 편이 맞다.
  if (letter.status === "deleted_by_author") return respond(gone());

  return respond(Response.json(manageView(letter)));
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  const { token } = await context.params;

  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  const letter = await findByManageToken(token);
  if (!letter) return respond(notFound());

  // 상태 변경은 deletion.ts에서만 한다 (README 「편지 상태는 한 파일에서만 바꾼다」).
  // 이미 지워진 편지면 false — 그때는 GET과 같은 410이다 (05-api §2).
  const deleted = await deleteByAuthor(letter.id);
  if (!deleted) return respond(gone());

  // `letter_deleted { ageHours }` (06 §3). **S-9(작성자 후회)의 크기이자 주간 지표 #7이자
  // 위협 모델 §7 전환 트리거(24시간 내 삭제율 5% 초과)의 유일한 소스다.** 실제로 지워졌을
  // 때만 보낸다 — 위에서 `deleted`가 false면 이미 지워진 편지라 새 사건이 아니다.
  // **편지 ID는 담지 않는다** (06 §2). 나이만 담는다.
  try {
    await record("letter_deleted", session.sessionId, {
      ageHours: (Date.now() - letter.createdAt.getTime()) / HOUR_MS,
    });
  } catch {
    // 삭제를 계측 실패로 되돌리지 않는다. 편지는 이미 내려갔다.
  }

  // 삭제 사유를 묻지 않는다 (S-9). 요청 본문을 읽지 않는 것도 같은 이유다.
  return respond(new Response(null, { status: 204 }));
}
