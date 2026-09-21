// `POST /api/admin/login` (05-api §4).
//
// 비밀번호 하나로 서명 쿠키를 받는다. 계정 테이블도 사용자 관리도 없다.
//
// **어느 쪽이 틀렸는지 말하지 않는다.** 실패 응답은 errors.ts의 고정 401 하나다.

import { z } from "zod";
import { invalidRequest, rateLimited, unauthorized } from "@/lib/errors";
import { fingerprint } from "@/lib/fingerprint";
import {
  countRecentLoginFailures,
  LOGIN_FAILURE_LIMIT,
  loginRetryAfterSeconds,
  passwordMatches,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/admin/login";
import {
  issueSession,
  SESSION_TTL_SECONDS,
  sessionCookieHeader,
} from "@/lib/admin/session";

const schema = z.object({
  password: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const fpHash = fingerprint(request.headers);

  // 05-api §4 「실패는 5 / 10분」. 비밀번호를 보기 **전에** 막는다 — 대조까지 간 뒤에
  // 세면 한도를 넘긴 요청도 매번 상수 시간 비교를 돌린다.
  const failures = await countRecentLoginFailures(fpHash);
  if (failures >= LOGIN_FAILURE_LIMIT) {
    return rateLimited(await loginRetryAfterSeconds(fpHash));
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest("요청 형식이 올바르지 않습니다.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest("비밀번호를 입력해 주세요.");
  }

  if (!passwordMatches(parsed.data.password)) {
    await recordLoginFailure(fpHash);
    return unauthorized();
  }

  await recordLoginSuccess(fpHash);

  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": sessionCookieHeader(issueSession(), SESSION_TTL_SECONDS),
    },
  });
}
