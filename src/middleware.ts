// 법정 접속기록을 남기는 유일한 지점 — [D-030](../docs/00-decisions.md).
//
// ── 왜 미들웨어인가 ─────────────────────────────────────────
// 라우트마다 기록을 흩뿌리면 **빠뜨린 자리가 곧 기록 누락**이고, 누락된 접속기록은
// 보관 의무 관점에서 "안 남겼다"와 같다. 새 라우트를 추가한 사람이 기록을 잊어도
// 여기 한 곳이 덮는 구조여야 한다.
//
// ── Node 런타임을 명시하는 이유 ─────────────────────────────
// 미들웨어의 기본은 Edge 런타임이고 거기서는 `pg`가 돌지 않는다. `runtime: 'nodejs'`가
// 없으면 빌드나 런타임에서 깨진다. **이 줄을 지우면 접속기록이 통째로 멈춘다.**
//
// ── 정적 자산은 세지 않는다 ─────────────────────────────────
// 아래 matcher가 `_next/static`·이미지를 뺀다. 법정 접속기록이 재는 것은 사람의
// 접속이지 브라우저가 페이지 하나에 딸려 받는 파일 수십 개가 아니다. 그것까지 남기면
// 같은 접속이 수십 행이 되어 오히려 기록이 읽히지 않는다.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { channelOf, recordAccess } from "@/lib/access-log";
import { clientIp } from "@/lib/fingerprint";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  try {
    await recordAccess(
      clientIp(request.headers),
      channelOf(request.nextUrl.pathname),
    );
  } catch (error) {
    // 기록 실패로 요청을 막지 않는다 — DB가 흔들릴 때 서비스 전체가 죽는 쪽이 나쁘다.
    // 다만 삼키지 않는다. 조용히 비는 구간이 가장 나쁘다 (access-log.ts 주석).
    console.error("[access-log] 접속기록 실패", error);
  }

  return NextResponse.next();
}

export const config = {
  runtime: "nodejs",
  matcher: [
    // 정적 자산과 파비콘을 뺀 전부.
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
