// 재분류 잡의 호출 지점 (05-api §1 「재분류 잡」).
// 스케줄은 `reclassify.yml` 워크플로(공개 저장소에는 없다)다 — Vercel Cron이 아니다. Hobby 플랜은
// 하루 1회가 상한이라 10분 주기 cron 식이 **배포 자체를 실패시킨다**
// (https://vercel.com/docs/cron-jobs/usage-and-pricing · 확인 2026-08-15).
//
// ## 인증 — 인증 없이 열어두지 않는다
//
// 워크플로가 리포 시크릿 `CRON_SECRET`을 `Authorization: Bearer <값>` 헤더로 실어 보내고,
// 엔드포인트가 그 값을 대조한다. 헤더 형태는 Vercel Cron이 쓰던 규약을 그대로 뒀다 —
// 호출 주체가 바뀌어도 대조 방식은 같고, 나중에 Vercel Pro로 되돌아가도 라우트는 그대로다.
// https://vercel.com/docs/cron-jobs/manage-cron-jobs (「Securing cron jobs」)
//
// **fail closed다.** 시크릿이 없으면 잡을 돌리지 않고 401이다. 열어두면 아무나 분류기를
// 호출시켜 일일 상한($5, D-020)을 태울 수 있고, 그 뒤로는 그 시간대 편지가 전부 medium으로
// 강등된다 — 인증이 없는 크론 경로는 그 자체로 비용 공격 표면이다.
//
// 미들웨어가 아니라 핸들러에서 확인한다. 05-api §6이 킬 스위치에 같은 규칙을 두는 것과
// 같은 이유이고, 크론 경로는 미들웨어를 거치지 않는 배포 형태가 있어 더 그렇다.

import { constantTimeEqual } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { unauthorized } from "@/lib/errors";
import { runReclassifyJob } from "@/lib/safety/reclassify";

/** 분류기 호출과 DB 쓰기가 있다. 정적으로 평가되면 안 된다. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let secret: string;
  try {
    secret = requireEnv("CRON_SECRET");
  } catch {
    // 환경변수가 없는 배포에서 경로가 무방비로 열리는 것을 막는다. env.ts가 이 값을
    // optional로 두는 이유는 M1 부팅을 막지 않기 위해서이지, 없어도 된다는 뜻이 아니다.
    return unauthorized();
  }

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (
    !constantTimeEqual(Buffer.from(header, "utf8"), Buffer.from(expected, "utf8"))
  ) {
    return unauthorized();
  }

  const outcome = await runReclassifyJob();
  // 편지 ID를 돌려주지 않는다. 이 응답은 GitHub Actions 로그에 그대로 찍히고 — 리포에
  // 접근 가능한 사람이면 누구나 읽는다 — 편지 ID는 추측 불가 식별자라(04 §1-1) 흘릴
  // 이유가 없다.
  return Response.json(outcome);
}
