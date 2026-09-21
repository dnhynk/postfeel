// `/report/:id` (03 화면 목록 · 02 §4).
//
// 편지 카드·편지 화면의 `신고`가 여기로 온다. **2번 이내 조작**이 요구사항이라 중간에
// 확인 단계를 두지 않는다 (02 §4).
//
// 편지를 조회하지 않는다 — 없는 편지 ID로 들어와도 화면은 그대로 뜨고, 접수 시점에
// 404가 난다. 화면이 편지의 존재를 확인해주면 그 자체가 조회 경로가 된다 (05-api §2의
// "403이 아니라 404" 규칙과 같은 이유).
//
// **noindex.** 개별 편지 페이지가 색인되면 안 되는데(S-10) 신고 URL에 편지 ID가 들어 있다.

import type { Metadata } from "next";
import { ReportForm } from "@/components/report/ReportForm";

export const metadata: Metadata = {
  title: "신고",
  robots: { index: false },
};

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReportForm letterId={id} />;
}
