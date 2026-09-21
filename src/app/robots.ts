// robots.txt — 05-api §6 「색인」 · 02 S-10.
//
// **`/m/`을 `Disallow`하지 않는다. 크롤링은 허용한다.**
//
// `Disallow`와 `noindex`는 같이 쓰면 서로를 무력화한다. 크롤러가 페이지를 못 가져오면
// 그 안의 `noindex`도 못 읽고, 그러면 외부에 링크가 걸렸을 때 **URL만 색인된 상태**가
// 남는다 — README 절대 규칙 4가 막으려던 바로 그 결과다. `noindex`가 작동하려면
// 크롤러가 페이지를 읽어야 한다.
//
// 개별 편지 페이지의 `noindex`는 두 곳에 있다:
//   · HTTP 헤더 `X-Robots-Tag`  → next.config.ts의 headers()
//   · 메타 태그                  → src/app/m/[id]/page.tsx의 metadata
//
// 부수 효과로 카카오톡 OG 스크래핑도 여기 막히지 않는다. 스크래퍼가 robots.txt를
// 어떻게 다루는지는 검증하지 않았고, M4에서 실측한다 (05-api §6).

import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
  };
}
