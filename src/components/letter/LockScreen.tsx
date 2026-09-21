// B 모드 잠금 화면 — 03 흐름 2.
//
//   🔒 · 단서 · 관계·시각 · 질문 · 입력칸 · [ 열어보기 ] · 남은 시도 N번
//
// **정적인 부분만 여기 있다.** 입력·제출·남은 시도·해제 후 화면은 `UnlockPanel`이고
// (B모드 워커), 이 파일은 그 안에 들어갈 단서·질문 마크업을 넘겨준다.
//
// ── 왜 이 파일이 껍데기인가 (되돌리기 전에 읽는다) ───────────
//
// `unlockId`는 **HttpOnly 쿠키로만** 내려간다(05-api §2). 해제 후 새로고침하면
// 스크립트가 그 값을 잃고, 그러면 `POST /api/unlocks/:unlockId/response`를 부를 수
// 없다 — 그 응답이 북극성 지표의 유일한 수집 지점이다(01 「북극성 지표」). 그래서
// 해제 직후 흐름(본문 → 응답 질문 → 이어가기)은 서버 왕복 없이 **같은 자리에서
// 교체**돼야 하고, 그 자리는 클라이언트 상태여야 한다. 03 흐름 2가 "본문을 먼저
// 보여주고"라고 못박아서, 여기서 잠금 화면을 계속 그리면 해제한 뒤에도 자물쇠·단서·
// 질문이 본문 위에 남는다. 마크업과 문구는 옮기기 전과 글자 그대로 같다.
//
// 오답 시 어떤 정보도 주지 않는다(글자 수·부분 일치·메시지 차이 전부, S-6)는 규칙은
// 해제 응답의 것이고 여기서는 지킬 것이 없다 — 이 화면은 답을 검사하지 않는다.
// 남은 시도 횟수는 **보여준다.** 브루트포서에게는 이미 알려진 정보이고 일반
// 사용자에게는 필요한 정보다 (03 흐름 2).

import type { LockedLetterResponse } from "@/lib/letters/read";
import { LetterMeta } from "./LetterMeta";
import { UnlockPanel } from "./UnlockPanel";

export function LockScreen({ letter }: { letter: LockedLetterResponse }) {
  return (
    <UnlockPanel letter={letter}>
      <p className="text-2xl" aria-hidden="true">
        🔒
      </p>
      {/* 단서와 질문은 공개 정보다 — 피드 카드에도 이미 떠 있다 (03 흐름 1-4). */}
      <p className="mt-2 whitespace-pre-wrap break-words text-lg text-gray-900">
        {letter.hint}
      </p>
      <div className="mt-2 text-right">
        <LetterMeta
          relationship={letter.relationship}
          createdAt={letter.createdAt}
        />
      </div>

      <hr className="my-6 border-gray-200" />

      <p className="whitespace-pre-wrap break-words text-gray-900">
        {letter.question}
      </p>

      {/* 입력·[ 열어보기 ]·"남은 시도 N번"은 UnlockPanel이 그린다 — 셋 다 제출 결과에
          따라 바뀌는 값이라 클라이언트 상태여야 한다. 소진(attemptsRemaining = 0)
          상태의 회복 시각 문구는 여전히 문서에 없어 만들지 않았다: 응답의 lockedUntil을
          쓰려면 문구부터 정해야 한다. */}
    </UnlockPanel>
  );
}
