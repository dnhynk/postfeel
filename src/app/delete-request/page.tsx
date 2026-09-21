// `/delete-request` (03 화면 목록 · 04 §5 발견 3).
//
// 관리 링크 분실 시의 삭제 요청 폼. 접수만 하고, 대조와 삭제는 운영자가 한다 (07 §5).
// 관리 화면과 같은 이유로 색인하지 않는다.

import type { Metadata } from "next";
import { DeleteRequestForm } from "@/components/manage/DeleteRequestForm";

export const metadata: Metadata = {
  title: "삭제 요청",
  robots: { index: false },
};

export default function DeleteRequestPage() {
  return <DeleteRequestForm />;
}
