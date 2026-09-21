// `/m/:id`가 그리는 것 — 03 흐름 2.
//
// 페이지에서 분리한 이유: 페이지는 `next/headers`·`notFound()`를 쓰는 비동기 셸이라
// 렌더만 떼어내 테스트하기 어렵다. 여기는 받은 값만 그리는 순수 컴포넌트라
// `renderToStaticMarkup`으로 **HTML에 무엇이 들어갔는지**를 직접 단언할 수 있다.
//
// `not_found`가 타입에서 빠져 있는 것은 의도다. 페이지가 `notFound()`를 던져 처리하므로
// 여기까지 오지 않는다 — 오지 않는 분기를 만들어두면 그게 죽은 코드다.

import { SharePanel } from "@/components/share/SharePanel";
import type { LetterLoad } from "@/lib/letters/read";
import { isUnlocked } from "@/lib/letters/read";
import { LockScreen } from "./LockScreen";
import { OpenLetter } from "./OpenLetter";
import { ReadDisabled } from "./ReadDisabled";

export type LetterScreenLoad = Exclude<LetterLoad, { state: "not_found" }>;

export function LetterScreen({ load }: { load: LetterScreenLoad }) {
  if (load.state === "disabled") return <ReadDisabled />;
  const { letter } = load;

  return (
    <>
      {/* 본문이 있으면 보여준다 — A 모드이거나, 해제 쿠키로 이미 연 B 모드다.
          없으면 잠금 화면이다. read.ts가 애초에 본문을 가져오지 않았다는 뜻이라
          이 분기에서 감출 값 자체가 없다 (05-api §7 #1). */}
      {isUnlocked(letter) ? (
        <OpenLetter letter={letter} />
      ) : (
        <LockScreen letter={letter} />
      )}

      {/* 공유 (03 흐름 3 · D-006). **잠긴 편지에서 특히 이 자리가 중요하다** — B 모드
          편지는 링크 유통이 정상 경로이고, 여기서 공유되지 않으면 의도한 수신자에게
          닿을 길이 없다.

          `UnlockPanel` 안이 아니라 밖에 둔다. 안에 두면 해제 성공과 동시에 본문으로
          교체되면서 공유 버튼이 사라진다 — 방금 편지를 연 사람이 "이거 네 얘기 같은데"
          하고 넘길 자리가 없어진다.

          킬 스위치로 막힌 화면(`disabled`)에는 붙지 않는다. 위에서 이미 빠져나갔고,
          공유할 편지 자체를 조회하지 않았다. */}
      <div className="mt-4">
        <SharePanel letterId={letter.id} mode={letter.mode} from="letter" />
      </div>
    </>
  );
}
