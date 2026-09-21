// 피드 카드 한 장 — 03 흐름 0.
//
// **잠긴 카드와 열린 카드가 같은 목록에 섞여 있다.** 잠긴 카드가 호기심 엔진이고 열린
// 카드가 읽을거리다. 분리하면 둘 다 약해진다 (03 흐름 0).
//
// **서버 컴포넌트로 남는다.** 클릭 계측은 `FeedCardLink`가, 반응 버튼은 `Reactions`가
// 각자 클라이언트 컴포넌트로 맡는다 — 이 파일을 `"use client"`로 만들면 `LetterMeta`가
// 따라 들어가면서 `pg`가 브라우저 번들로 끌려간다 (FeedCardLink 주석 참조).
//
// **반응 버튼과 공유 버튼은 링크 밖에 있다.** 안에 두면 `<a>` 안에 `<button>`이 들어가
// 마크업이 깨지고, 누르는 순간 편지로 이동한다.

import { LetterMeta } from "@/components/letter/LetterMeta";
import { Reactions } from "@/components/reactions/Reactions";
import { SharePanel } from "@/components/share/SharePanel";
import type { FeedItem } from "@/lib/letters/read";
import { FeedCardLink } from "./FeedCardLink";

export function FeedCard({ item }: { item: FeedItem }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4 hover:border-gray-400">
      <FeedCardLink
        letterId={item.id}
        mode={item.mode}
        relationship={item.relationship}
      >
        {item.mode === "locked" && (
          <p className="mb-1 text-sm text-gray-600">🔒 잠긴 편지</p>
        )}
        {/* locked의 preview는 단서(hint)다. 본문은 여기 오지 않는다 (05-api §2). */}
        <p className="whitespace-pre-wrap break-words text-gray-900">
          {item.preview}
        </p>
        <div className="mt-3 text-right">
          <LetterMeta
            relationship={item.relationship}
            createdAt={item.createdAt}
          />
        </div>
      </FeedCardLink>

      {/* 반응과 공유가 한 줄을 나눠 쓴다. 공유 패널은 펼치면 `w-full`이라 줄을 넘겨
          자기 자리를 잡는다 — 접혀 있을 때 카드가 두 줄로 길어지지 않게 하면서, 펼쳤을 때
          반응 버튼을 밀어내지 않는 형태다. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <Reactions letterId={item.id} initial={item.reactions} />
        <SharePanel letterId={item.id} mode={item.mode} from="feed" />
      </div>
    </div>
  );
}
