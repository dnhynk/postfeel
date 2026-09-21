import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/layout/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "PostFeel",
};

// 푸터는 공용 레이아웃에 둔다 — 약관·처리방침에 도달할 길이 여기 말고는 없다
// (components/layout/Footer.tsx).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {children}
        <Footer />
      </body>
    </html>
  );
}
