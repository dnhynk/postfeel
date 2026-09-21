// `GET /m/:id/opengraph-image` — 05-api §6 「OG 이미지」 · 03 흐름 3.
//
// **D-006에 따라 공유가 유일한 배달 수단이다.** 카카오톡 링크 미리보기가 한국에서 사실상
// 유일한 유입 경로라 이 파일은 부가 기능이 아니라 유통 인프라다 (03 흐름 3).
//
// ── 이 라우트가 지키는 것 ────────────────────────────────────
//
// 1. **상태 필터를 새로 쓰지 않는다.** 조회는 `loadOgCard` → read.ts의 `loadLetter`다.
//    `hidden_auto`·`hidden_admin`·`deleted_by_author`는 404다 (05-api §2 표 · §7 #10).
// 2. **`public_read_enabled = false`면 그림을 만들지 않는다** (05-api §6 표).
// 3. **잠긴 편지 카드에 본문이 없다** (05-api §7 #2). 근거는 card.tsx 상단.
//
// ── noindex ─────────────────────────────────────────────────
//
// 이 경로의 `X-Robots-Tag`는 next.config.ts의 `headers()`가 붙인다 — source가
// `/m/:path*`라 `/m/:id` 아래 하위 경로가 전부 덮인다. OG 경로가 noindex 밖으로 새면
// S-10이 뚫린다(02 S-10 · README 절대 규칙 4).
//
// ── 왜 `force-dynamic`인가 ───────────────────────────────────
//
// 05-api §6은 OG 이미지를 "엣지 캐시"라고 적었지만, 같은 절이 킬 스위치에 대해
// "**미들웨어가 아니라 핸들러에서** 확인한다 — 캐시 때문에 스위치가 즉시 반영되지 않으면
// 킬 스위치의 의미가 없다"고 못박는다. 정적 생성으로 두면 빌드 시점의 편지 상태가
// 이미지에 박제되어 비공개 처리된 편지의 카드가 계속 나간다. 안전 쪽으로 기운다.
//
// 우리 오리진 밖의 캐시(카카오톡·트위터)는 이 설정으로 어쩌지 못한다 — 그건 05-api §2가
// 이미 비가역 한계로 적어둔 것이고, 그래서 카드에 본문 전체를 넣지 않는다.

import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { OG_SIZE, OgCard } from "@/components/share/card";
import { FONT_FAMILY, nanumGothic } from "@/components/share/font";
import { loadOgCard } from "@/components/share/load";
import { fingerprint } from "@/lib/fingerprint";

/** 05-api §6 — 킬 스위치를 매 요청 확인한다. `/m/:id` 페이지와 같다. */
export const dynamic = "force-dynamic";

export const size = OG_SIZE;
export const contentType = "image/png";

/**
 * 대체 텍스트. **편지 내용을 넣지 않는다** — alt는 HTML에 그대로 실려서, 넣는 순간
 * 카드에서 뺀 본문이 메타 태그로 새어나간다.
 */
export const alt = "보내지 못한 말";

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Response> {
  const { id } = await params;
  const load = await loadOgCard(id, { fpHash: fingerprint(await headers()) });

  // 킬 스위치는 404가 아니라 503이다 (05-api §6). 전역이라 어떤 편지에 대해서도
  // 아무것도 알려주지 않고, 스크레이퍼가 "영구히 없음"으로 캐시하지도 않는다 —
  // 404로 내리면 스위치를 되돌린 뒤에도 미리보기가 죽은 채로 남을 수 있다.
  if (load.state === "disabled") return new Response(null, { status: 503 });

  // 없는 편지와 내려간 편지가 똑같이 404다. 403은 편지의 존재를 확인해준다.
  if (load.state === "not_found") return new Response(null, { status: 404 });

  return new ImageResponse(<OgCard content={load.content} />, {
    ...size,
    fonts: [
      {
        name: FONT_FAMILY,
        data: await nanumGothic(),
        weight: 400,
        style: "normal",
      },
    ],
  });
}
