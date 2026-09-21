// 최소 푸터 — `/terms` · `/privacy`로 가는 유일한 길.
//
// 두 페이지는 03 「화면 목록」에 있고 출시 게이트 항목이기도 한데(08), 여기까지 도달할
// 링크가 어디에도 없었다. **개인정보처리방침에 접근할 수 없으면 게시한 것이 아니다.**
//
// **링크 두 개뿐이다.** 시각 방향이 아직 안 잡혔고 `globals.css`는 워커가 고치지 않는다
// (README 「스타일」). 로고 · 저작권 · 소개 문구를 여기서 발명하지 않는다.
//
// **고정 배치를 쓰지 않는다.** 모든 화면 아래에 붙으므로, 문서 흐름 끝에 두어야 작성
// 흐름의 긴 폼이나 잠금 화면의 입력을 가리지 않는다. 색과 크기도 본문보다 낮춰 시선을
// 뺏지 않게 한다 — 접근 경로를 만드는 것이 목적이지 읽히는 것이 목적이 아니다.

import Link from "next/link";

export function Footer() {
  return (
    <footer className="mx-auto max-w-2xl px-6 pb-8 text-sm text-gray-500">
      <Link href="/terms" className="underline">
        이용약관
      </Link>
      <span aria-hidden="true" className="px-2">
        ·
      </span>
      <Link href="/privacy" className="underline">
        개인정보처리방침
      </Link>
    </footer>
  );
}
