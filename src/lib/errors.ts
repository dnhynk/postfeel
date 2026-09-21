// 오류 응답 형태. 05-api §6이 형태를 못박았다.
//
//   { error: { code, message, retryAfter? } }
//
// message는 **사용자에게 그대로 보여줄 한국어**다. 코드 → 문구 매핑 테이블을 두지
// 않는다(05-api §6 명시). 매핑 테이블을 두면 문구가 두 곳에 살게 되고, 화면마다
// 다른 문구를 쓰고 싶은 순간 서버 문구가 죽은 코드가 된다.

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** 429에서만. 초 단위 (05-api §2 unlock 429) */
    retryAfter?: number;
  };
}

/**
 * 오류 응답 하나를 만든다.
 *
 * `extra`는 형태에 정의된 선택 필드(`retryAfter`)를 넣는 자리다. 여기에 새 필드를
 * 더하려면 05-api §6을 먼저 고친다.
 */
export function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: { retryAfter?: number },
): Response {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return Response.json(body, { status });
}

// ── 흔한 케이스 ────────────────────────────────────────────
// 각 항목은 문서가 상태 코드를 지정한 자리에만 있다. 문서에 없는 상황을 여기서
// 만들어내지 않는다.

/** 요청 본문이 스키마에 맞지 않을 때. 문구는 부르는 쪽이 상황에 맞게 준다. */
export function invalidRequest(message: string): Response {
  return jsonError("invalid_request", message, 400);
}

/**
 * 존재하지 않거나 비공개 상태인 편지 (05-api §2 「상태별 표면 응답」).
 * 403이 아니라 404다 — 403은 편지의 존재를 확인해준다.
 */
export function notFound(): Response {
  return jsonError("not_found", "편지를 찾을 수 없습니다.", 404);
}

/** 작성자가 이미 지운 편지의 관리 화면 (05-api §2). 토큰 소지자는 작성자 본인이라 알려준다. */
export function gone(): Response {
  return jsonError("gone", "이미 삭제된 편지입니다. 되돌릴 수 없습니다.", 410);
}

/** 편지당 1회인 등록이 이미 있을 때 (05-api §3 이메일 등록). */
export function conflict(message: string): Response {
  return jsonError("conflict", message, 409);
}

/** 05-api §5 레이트리밋. `retryAfter`는 초 단위다. */
export function rateLimited(retryAfter: number): Response {
  return jsonError(
    "rate_limited",
    "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
    429,
    { retryAfter },
  );
}

/** `writing_enabled = false` (05-api §2 · §6 킬 스위치). */
export function writingDisabled(): Response {
  return jsonError(
    "writing_disabled",
    "지금은 편지를 쓸 수 없습니다. 잠시 후 다시 시도해 주세요.",
    503,
  );
}

/** 운영자 인증 실패 (05-api §4). 어느 쪽이 틀렸는지 말하지 않는다. */
export function unauthorized(): Response {
  return jsonError("unauthorized", "권한이 없습니다.", 401);
}
