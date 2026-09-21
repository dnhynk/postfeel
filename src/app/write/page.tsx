// `/write` — 작성 (관계 → 본문 → 모드 → 단서 → 확인). 단일 페이지 다단계
// (03 「화면 목록」).
//
// 페이지는 껍데기만이고 단계는 전부 클라이언트 상태다 (components/write/write-flow).
// 서버에서 읽을 것이 없다 — 작성 화면은 편지도 설정도 조회하지 않는다.

import type { Metadata } from "next";
import { WriteFlow } from "@/components/write/write-flow";

export const metadata: Metadata = {
  title: "편지 쓰기 · PostFeel",
};

export default function WritePage() {
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10">
      <WriteFlow />
    </main>
  );
}
