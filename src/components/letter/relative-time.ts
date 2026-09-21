// 카드와 편지 머리말의 "3일 전" (03 흐름 0 · 흐름 2의 목업).
//
// 편지는 무기한 보관이라(D-024) 언젠가 "400일 전"이 찍힌다. 개월·연 단위 규칙을 지금
// 만들지 않는 이유는 그 화면이 아직 없기 때문이다 — 필요해지면 그때 정한다.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `now`를 인자로 받는 이유: 테스트가 시계를 고정할 수 있어야 한다. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";

  const elapsed = now.getTime() - then;
  // 시계 오차로 미래가 찍히면 "방금 전"으로 접는다. 음수 시간을 보여주지 않는다.
  if (elapsed < MINUTE) return "방금 전";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}분 전`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}시간 전`;
  return `${Math.floor(elapsed / DAY)}일 전`;
}
