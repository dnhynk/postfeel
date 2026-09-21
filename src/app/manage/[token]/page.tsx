// `/manage/:token` (03 §1-7 · 03 화면 목록).
//
// 관리 링크로만 접근한다. URL에 편지 ID가 없다 — 토큰만으로 식별한다 (D-014).
//
// **noindex.** 05-api §6이 `noindex`를 요구한 것은 `/m/:id`뿐이지만, 관리 URL은 삭제
// 권한 그 자체라 색인에 남으면 안 된다. 랜덤 토큰이라 크롤러가 도달할 경로가 없어
// 메타 태그로 충분하다고 본다 — HTTP 헤더(next.config.ts)는 건드리지 않는다.

import type { Metadata } from "next";
import { ManageScreen } from "@/components/manage/ManageScreen";

export const metadata: Metadata = {
  title: "편지 관리",
  robots: { index: false },
};

export default async function ManagePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ManageScreen token={token} />;
}
