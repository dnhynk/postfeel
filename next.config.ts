import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 개별 편지 페이지는 `noindex` — 02 S-10 · 05-api §6 「색인」 · README 절대 규칙 4.
   *
   * **v0에서 유일하게 사후 조치가 불가능한 항목이라 처음부터 켠다.** 한 번 색인되면
   * 편지를 지워도 캐시·스크랩에 남고 우리가 지울 수 없다.
   *
   * 헤더가 여기 있는 이유: App Router의 페이지(서버 컴포넌트)는 응답 헤더를 직접
   * 설정할 수 없다. 남는 길은 이 `headers()`와 미들웨어 둘인데, 미들웨어를 신설하면
   * "킬 스위치는 미들웨어가 아니라 핸들러에서 확인한다"(05-api §6)를 깰 자리가 생긴다.
   * 헤더 하나 때문에 그 자리를 만들지 않는다. 메타 태그는 page.tsx의 metadata에 있다 —
   * 05-api §6이 "HTTP 헤더 + 메타 태그 둘 다"라고 명시했다.
   *
   * `/m/:path*`가 덮는 것: `/m/:id`, `/m/:id/`(308 후 최종 응답), 그리고 `/m/:id` 아래
   * 모든 하위 경로 — 나중에 유통 워커가 붙일 `/m/:id/opengraph-image`가 여기 포함된다.
   * `/m/:id` 하나만 적으면 하위 경로가 noindex 밖으로 새고, 그러면 S-10이 뚫린다.
   */
  async headers() {
    return [
      {
        source: "/m/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
    ];
  },
};

export default nextConfig;
