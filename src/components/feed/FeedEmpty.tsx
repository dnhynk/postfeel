// 피드 빈 상태 — 03 흐름 0 「빈 상태」.
//
// **가짜 편지로 채우지 않는다** (D-007). 편지가 0개인 상태는 출시 시점에 반드시
// 존재하고, 그 해법은 시드 데이터가 아니라 "실제로 쓴 편지 30~50통 확보"라는 출시 준비
// 작업이다 (03 흐름 0). 화면은 정직하게 비어 있는다.
//
// 문구가 두 개인 이유: 03의 "아직 이 관계로 쓴 편지가 없어요"는 문서가 **"필터 조합으로
// 0건이 나오는 경우"**라고 명시한 문구다. 필터가 없는데 그 문구를 쓰면 사실과 다르고,
// 사용자는 필터를 바꾸면 뭔가 있다고 오해한다.

import Link from "next/link";

export function FeedEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="py-16 text-center">
      <p className="text-gray-600">
        {filtered
          ? "아직 이 관계로 쓴 편지가 없어요."
          : "아직 남겨진 편지가 없어요."}
      </p>
      <Link
        href="/write"
        className="mt-4 inline-block rounded-md border border-gray-900 px-4 py-2 text-sm text-gray-900 hover:bg-gray-900 hover:text-white"
      >
        첫 편지 쓰기
      </Link>
    </div>
  );
}
