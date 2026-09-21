// 작성 화면에서만 쓰는 클래스 조합.
//
// `src/app/globals.css`는 워커가 고치지 않는다(README 「스타일」). 그래서 새 토큰을
// 만들지 않고 Tailwind v4 기본 스케일만 조합한다. 같은 조합을 화면마다 다시 적으면
// 버튼 하나 고칠 때 여섯 군데를 고쳐야 해서 여기 모아둔다. **디자인 시스템이 아니라
// 이 표면의 지역 상수다.**

const BASE =
  "inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";

/** 기본 동작. 인터스티셜에서는 `고칠게요`가 이걸 쓴다 (02 §3). */
export const PRIMARY = `${BASE} bg-neutral-900 text-white hover:bg-neutral-700`;

/** 부차 동작. `이대로 올리기`가 이걸 쓴다 — 기본 버튼이 아니라는 게 보여야 한다. */
export const SECONDARY = `${BASE} border border-neutral-300 text-neutral-700 hover:bg-neutral-100`;

/** 관계·모드처럼 고르는 카드. */
export const CHOICE =
  "block w-full rounded-lg border border-neutral-300 px-4 py-3 text-left hover:border-neutral-900 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900";

export const INPUT =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-neutral-900";

/** 입력란 옆의 공개 여부 표시. 이 문구가 안 보이면 사용자가 비공개라고 착각한다 (03 §1-4). */
export const FIELD_NOTE = "text-sm text-neutral-500";
