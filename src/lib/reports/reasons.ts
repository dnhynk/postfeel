// 신고 사유 (02 §4 · 04 §3 · 05-api §2).
//
// ── 이 파일이 존재하는 이유 ──────────────────────────────────
// **심각 카테고리 집합이 두 곳에서 쓰인다** — 자동 비공개가 `auto_hide_exempt`를 뚫을지
// (D-025)와 텔레그램 즉시 알림을 보낼지(09 §3). D-025가 못박았다:
//
//   > 이 집합은 텔레그램 즉시 알림과 정확히 같게 둔다. 자동으로 내려가는 것과 사람을
//   > 깨우는 것이 다른 집합이면 둘 중 하나는 반드시 잊힌다.
//
// 그래서 집합을 **여기 한 곳에만** 둔다. 두 표면은 각자 하드코딩하지 않고 이걸 읽는다.

/** 05-api §2 · 04 §2 `reports.reason`의 허용값. 순서는 02 §4의 사유 목록 순서다. */
export const REPORT_REASONS = [
  "doxx",
  "targeting",
  "impersonation",
  "sexual",
  "selfharm",
  "spam",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * 심각 카테고리 — **신상 · 미성년 · 자해** (02 §4 · D-025 · 09 §3).
 *
 * 접수 시점에는 미성년 여부를 알 수 없으므로 신고 사유로 근사한다. `sexual` 전체가
 * 트리거다 (D-025).
 *
 * 이 셋은
 *   · `auto_hide_exempt`와 무관하게 `hidden_auto`로 내려가고 (04 §3 · D-025)
 *   · 텔레그램 즉시 알림을 보낸다 (09 §3)
 *
 * **같은 집합이다. 나누지 않는다.**
 */
export const SEVERE_REPORT_REASONS = ["doxx", "sexual", "selfharm"] as const;

export type SevereReportReason = (typeof SEVERE_REPORT_REASONS)[number];

/** 나머지 넷(`targeting`·`impersonation`·`spam`·`other`)은 exempt가 그대로 막는다 (04 §3). */
export function isSevereReason(reason: ReportReason): reason is SevereReportReason {
  return (SEVERE_REPORT_REASONS as readonly string[]).includes(reason);
}

export function isReportReason(value: unknown): value is ReportReason {
  return (
    typeof value === "string" &&
    (REPORT_REASONS as readonly string[]).includes(value)
  );
}

/**
 * 사유 문구 — **02 §4의 목록 그대로**다. 여기서 다시 쓰지 않는다.
 *
 *   신상 노출 / 저격·비방 / 사칭 / 성적 내용 / 자해·협박 / 스팸 / 기타
 *
 * 신고 화면 · 운영자 큐 · 텔레그램 메시지가 전부 이 표를 읽는다. 09 §3의 예시 메시지는
 * `사유: 미성년 성적 내용`이지만 **접수 시점에 미성년 여부를 알 수 없으므로**(D-025)
 * 알림도 `성적 내용`이라고 쓴다 — 확인되지 않은 것을 단정하지 않는다 (D-007).
 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  doxx: "신상 노출",
  targeting: "저격·비방",
  impersonation: "사칭",
  sexual: "성적 내용",
  selfharm: "자해·협박",
  spam: "스팸",
  other: "기타",
};
