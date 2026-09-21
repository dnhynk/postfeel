// `/admin` (03 화면 목록 · 05-api §4 · 07 §3).
//
// ── 페이지도 API와 같은 방식으로 막는다 ─────────────────────
// 05-api §4: "API만 막고 페이지를 열어두면 큐 화면 껍데기가 노출된다." 그래서 인증되지
// 않으면 큐 화면을 렌더하지 않고 **로그인 폼으로 교체한다.** 리다이렉트도 아니고 클라이언트
// 검사도 아니다.
//
// **미들웨어가 아니라 여기서 확인한다** (05-api §4 · §6). 검증 함수는 `/api/admin/*`가
// 쓰는 것과 같은 `verifySession`이다.

import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifySession } from "@/lib/admin/session";
import { DirectHide } from "@/components/admin/DirectHide";
import { KillSwitches } from "@/components/admin/KillSwitches";
import { LoginForm } from "@/components/admin/LoginForm";
import { publicReadEnabled, writingEnabled } from "@/lib/settings";

export const metadata: Metadata = {
  title: "운영",
  robots: { index: false },
};

/** 킬 스위치 값은 매 요청 DB에서 읽는다 (05-api §6). 페이지를 정적으로 굽지 않는다. */
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const store = await cookies();
  if (!verifySession(store.get(ADMIN_COOKIE)?.value)) {
    return <LoginForm />;
  }

  const [publicRead, writing] = await Promise.all([
    publicReadEnabled(),
    writingEnabled(),
  ]);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-lg font-semibold">운영</h1>
      <p className="mt-1 text-sm text-neutral-600">
        하루 2회(아침 · 저녁) 15분. 상한은 하루 1시간입니다 (07 §1).
      </p>

      <p className="mt-4 text-sm">
        <Link href="/admin/queue" className="underline">
          운영자 큐 열기
        </Link>{" "}
        — 미판정 신고 · 자동 비공개 건 · 이의 제기 · 삭제 요청
      </p>

      <KillSwitches publicReadEnabled={publicRead} writingEnabled={writing} />

      <DirectHide />
    </main>
  );
}
