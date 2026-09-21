// OG 카드의 한국어 폰트.
//
// **`next/og`가 기본으로 들고 있는 폰트는 Geist 하나뿐이고 한글 글리프가 없다**
// (`node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf`). 폰트를 넘기지 않으면
// 카드의 한국어가 통째로 네모가 되고, 그러면 카드가 유통 인프라가 아니라 사고다
// (03 흐름 3 · D-006 「공유가 유일한 배달 수단」).
//
// ── 왜 이 파일인가 ─────────────────────────────────────────
//
// **Nanum Gothic Regular** — SIL Open Font License 1.1, Copyright (c) 2010 NHN Corporation.
// 라이선스 전문은 같은 디렉터리의 `OFL.txt`다 (OFL은 배포 시 라이선스 동봉을 요구한다).
// 출처: <https://github.com/google/fonts/tree/main/ofl/nanumgothic> `NanumGothic-Regular.ttf`.
// 파일은 **원본 그대로**다 — 이름이 Reserved Font Name("Nanum")이라 고친 파일을 같은
// 이름으로 배포할 수 없고, 안 고쳤으므로 재다운로드 + 해시 대조로 출처를 확인할 수 있다.
//
// 한글 음절 11,172자 전부와 ASCII 95자를 담는다(측정: `fontTools`의 cmap). 완성형
// 2,350자만 담는 폰트를 쓰면 「뷁」 같은 음절이 사용자 글에서 네모로 뜬다 — 편지 본문은
// 우리가 고르는 텍스트가 아니라서 부분 커버리지는 위험을 남긴다.
//
// 2.0MB다. 한자 8,138자를 함께 담는 Noto Sans KR은 6.2MB인데 편지에 한자가 거의 없어
// 4MB를 더 낼 이유가 없었다. 굵기는 Regular 하나만 싣는다 — 굵기를 하나 더 싣는 값이
// 또 2MB이고, 카드의 위계는 크기와 색으로 충분하다.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** `card.tsx`의 `fontFamily`와 같은 값이어야 한다. */
export const FONT_FAMILY = "NanumGothic";

// `new URL(..., import.meta.url)`은 번들러가 정적으로 알아보는 자산 참조라, 빌드
// 출력에도 파일이 함께 실린다. 경로를 문자열로 조립하면 그 추적이 끊긴다.
const FONT_FILE = new URL("./NanumGothic-Regular.ttf", import.meta.url);

/**
 * 읽은 폰트를 프로세스 안에 들고 있는다.
 *
 * README 「DB 접근」의 "프로세스 로컬 상태를 만들지 않는다"는 **인스턴스 사이에서
 * 공유돼야 하는 값**(레이트리밋 카운트 · 킬 스위치)에 대한 규칙이다. 이건 배포에
 * 고정된 읽기 전용 바이트라 인스턴스마다 값이 갈라질 여지가 없다. 매 요청 2MB를 다시
 * 읽지 않으려고 둔다.
 */
let loading: Promise<Buffer> | null = null;

export function nanumGothic(): Promise<Buffer> {
  loading ??= readFile(fileURLToPath(FONT_FILE));
  return loading;
}
