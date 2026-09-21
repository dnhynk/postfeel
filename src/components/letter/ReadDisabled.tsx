// `public_read_enabled = false`일 때의 화면 — 05-api §6 · 07-operations §3.
//
// 이 스위치는 피드만이 아니라 **공개 읽기 전체**를 끈다. 이미 공유된 링크도 죽는다 —
// 그게 의도한 동작이다. 문제 콘텐츠가 여러 건일 때 피드만 끄면 공유 링크로 계속 읽힌다.
//
// **이 컴포넌트는 편지 데이터를 인자로 받지 않는다.** 받아놓고 조건부로 숨기면 HTML
// 소스에 그대로 남는다. 스위치가 꺼졌을 때는 read.ts의 `loadLetter`·`loadFeed`가 아예
// 조회하지 않으므로 본문이 프로세스에 들어오지도 않는다.
//
// 링크를 두지 않는 것도 같은 이유다. 읽기가 꺼진 동안 보낼 곳이 없다.

export function ReadDisabled() {
  return (
    <div className="py-16 text-center">
      <p className="text-gray-600">
        지금은 편지를 볼 수 없습니다. 잠시 후 다시 시도해 주세요.
      </p>
    </div>
  );
}
