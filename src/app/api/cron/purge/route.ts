// 파기 작업의 호출 지점 ([D-031](../../../../../docs/00-decisions.md)).
//
// 인증·헤더 규약은 `../reclassify/route.ts`와 같다. **fail closed** — `CRON_SECRET`이
// 없으면 401이고 잡을 돌리지 않는다.
//
// ## 재분류와 다른 점 하나
//
// 재분류는 안 돌아도 편지가 medium에 머물 뿐이지만, **파기는 안 돌면 보유기간 위반이
// 쌓인다.** 그래서 실패가 조용히 넘어가지 않는다 — `runPurgeJob`이 `retention_healthy`를
// 끄고, 그 순간부터 신규 작성이 막힌다 (05-api §6).
//
// 스케줄은 `purge.yml` 워크플로(공개 저장소에는 없다)다. 하루 1회면 충분하다 — 기간이 30일·90일·
// 3개월 단위라 시간 정밀도가 필요 없고, Vercel Hobby의 하루 1회 상한(D-018 · 07 §7)과도
// 부딪히지 않는다. 다만 재분류와 같은 이유로 GitHub Actions에 둔다.

import { constantTimeEqual } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { unauthorized } from "@/lib/errors";
import { runPurgeJob } from "@/lib/retention/purge";

/** DB 쓰기가 있다. 정적으로 평가되면 안 된다. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let secret: string;
  try {
    secret = requireEnv("CRON_SECRET");
  } catch {
    return unauthorized();
  }

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (
    !constantTimeEqual(Buffer.from(header, "utf8"), Buffer.from(expected, "utf8"))
  ) {
    return unauthorized();
  }

  // 건수만 돌려준다. 편지 ID는 담지 않는다 — 이 응답은 Actions 로그에 그대로 찍힌다
  // (재분류 라우트와 같은 이유).
  return Response.json(await runPurgeJob());
}
