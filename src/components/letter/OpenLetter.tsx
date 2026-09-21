// 본문이 보이는 화면 — 03 흐름 2 「A 모드」: "카드를 누르면 본문이 보인다. 끝."
//
// 해제 쿠키로 열린 B 모드 편지도 같은 화면을 쓴다. 그래서 `mode`로 분기하지 않고
// `body`가 있는지로 분기한다 (read.ts의 `isUnlocked`).

import { Reactions } from "@/components/reactions/Reactions";
import type { OpenLetterResponse } from "@/lib/letters/read";
import { LetterMeta } from "./LetterMeta";

export function OpenLetter({ letter }: { letter: OpenLetterResponse }) {
  return (
    <article className="rounded-lg border border-gray-200 p-6">
      <p className="whitespace-pre-wrap break-words text-lg leading-relaxed text-gray-900">
        {letter.body}
      </p>
      <div className="mt-6 text-right">
        <LetterMeta
          relationship={letter.relationship}
          createdAt={letter.createdAt}
        />
      </div>

      {/* 고정형 반응 (04 §2 · 05-api §2). 개수는 `readLetter`가 이미 실어 왔다.
          **잠긴 편지(미해제)에는 붙지 않는다** — 05-api §2의 locked 응답에 `reactions`가
          없어서 보여줄 값 자체가 없다. 없는 필드를 만들어 채우지 않는다. */}
      <div className="mt-6">
        <Reactions letterId={letter.id} initial={letter.reactions} />
      </div>

      {/* 열람 후 응답(`이 편지, 당신에게 온 것 같나요?`)과 그 이후 화면은 다른 워커다
          (03 흐름 2 「열람 성공 후」 · POST /api/unlocks/:unlockId/response).
          신고·공유도 각각 다른 표면이다. 여기서 만들지 않는다. */}
    </article>
  );
}
