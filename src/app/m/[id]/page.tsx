// `/m/:id` — 편지 열람 (03 흐름 2).
//
// ── noindex는 두 곳에 있다 (05-api §6 · 02 S-10 · README 절대 규칙 4) ──
//   · HTTP 헤더 `X-Robots-Tag: noindex` → next.config.ts의 headers()
//     (App Router 페이지는 응답 헤더를 직접 설정할 수 없다)
//   · 메타 태그 `<meta name="robots" content="noindex">` → 아래 metadata
// robots.txt로 `/m/`을 막지는 않는다 — 크롤러가 페이지를 못 읽으면 이 둘도 못 읽는다.
//
// 이 페이지는 셸이다. 조회는 read.ts, 렌더는 components/letter/LetterScreen이 한다.

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { LetterScreen } from "@/components/letter/LetterScreen";
import { LetterViewTracker } from "@/components/letter/LetterViewTracker";
import { fingerprint } from "@/lib/fingerprint";
import { UNLOCK_COOKIE, loadLetter } from "@/lib/letters/read";

/** 05-api §6 — 킬 스위치를 매 요청 확인한다. */
export const dynamic = "force-dynamic";

/**
 * 02 S-10 — **v0에서 유일하게 사후 조치가 불가능한 항목이라 처음부터 켠다.**
 *
 * 편지 내용은 어떤 메타 필드에도 넣지 않는다. 제목·설명에 본문을 넣으면 색인을 막아도
 * 링크 미리보기로 새어나간다.
 */
export const metadata: Metadata = {
  robots: { index: false },
};

export default async function LetterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [cookieStore, requestHeaders] = await Promise.all([
    cookies(),
    headers(),
  ]);

  const load = await loadLetter(id, {
    // 쿠키 값은 DB 대조로만 검증된다 (04 §4 · 안전 #16). 여기서는 실어 나르기만 한다.
    unlockId: cookieStore.get(UNLOCK_COOKIE)?.value ?? null,
    fpHash: fingerprint(requestHeaders),
  });

  // 없는 편지와 내려간 편지(`hidden_auto`·`hidden_admin`·`deleted_by_author`)가 똑같이
  // 404다 (05-api §2 「상태별 표면 응답」 · §7 #10). 구분해서 알려주면 그 자체가
  // 편지의 존재를 확인해준다.
  if (load.state === "not_found") notFound();

  // `letter_view { mode, relationship, source }` (06 §3). 이 페이지는 서버 컴포넌트라
  // 이벤트를 직접 보낼 수 없고, 이 이벤트는 클라이언트 이벤트다 — 아무것도 그리지 않는
  // 트래커가 보낸다. `source`가 중요하다: `link` 비중이 유통이 작동하는지를 직접 보여준다
  // (D-006 · 주간 지표 #3). 판정 규칙은 view-source.ts.
  //
  // 킬 스위치로 막힌 화면(`disabled`)에서는 보내지 않는다 — 편지를 조회조차 하지 않았으니
  // 담을 속성이 없고, 열람이 일어난 것도 아니다.
  return (
    <main className="mx-auto max-w-2xl p-6">
      {load.state === "letter" && (
        <LetterViewTracker
          mode={load.letter.mode}
          relationship={load.letter.relationship}
        />
      )}
      <LetterScreen load={load} />
    </main>
  );
}
