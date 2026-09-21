// `/admin/queue` (05-api §4 · 07 §1 · §2).
//
// `/admin`과 같은 방식으로 막는다 — 인증되지 않으면 큐 대신 로그인 폼이다. 여기가 특히
// 중요하다: 이 화면에는 신고당한 편지의 **본문**이 뜬다.

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifySession } from "@/lib/admin/session";
import { LoginForm } from "@/components/admin/LoginForm";
import { QueueScreen } from "@/components/admin/QueueScreen";

export const metadata: Metadata = {
  title: "운영자 큐",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

export default async function AdminQueuePage() {
  const store = await cookies();
  if (!verifySession(store.get(ADMIN_COOKIE)?.value)) {
    return <LoginForm />;
  }
  return <QueueScreen />;
}
