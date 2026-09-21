// 이벤트 이름·props 화이트리스트 (06-analytics §3 · 09-notifications §5).
//
// `POST /api/events`는 공개 표면이다. 이름을 자유롭게 받으면 누구나 우리 테이블을
// 채울 수 있고, props를 그대로 받으면 06 §2가 금지한 값(편지 ID·이메일)이 들어온다.
// `src/lib/events.ts`의 금지 키 가드는 **마지막 방어선**이지 첫 방어선이 아니다.
//
// ── `source`가 무엇을 가르나 ────────────────────────────────
// **서버가 관측할 수 있는 이벤트는 서버가 기록한다.** 클라이언트가 보낼 수 있으면
// 위조할 수 있고, 위조 가능한 숫자는 주간 리뷰(06 §6)에서 아무 의미가 없다.
// `email_sent`를 클라이언트가 보낼 수 있으면 발송 지표가 통째로 거짓이 된다.
//
// 그래서 `/api/events`는 `source: 'client'`만 받는다. `'server'`는 그 표면의 서버
// 코드가 `record()`를 직접 부른다. 자기 표면의 이벤트가 client여야 한다고 판단되면
// 표를 고치지 말고 코디네이터에게 묻는다 — 이 표는 12개 표면이 공유한다.
//
// 이 파일에는 DB도 요청도 없다. 클라이언트 번들에 들어가도 안전해야 한다.

import type { EventProps } from "@/lib/events";
import { FLAG_FIELDS, FLAG_KINDS } from "@/lib/safety/types";

export type EventSource = "client" | "server";

export interface EventSpec {
  source: EventSource;
  /** 06-analytics §3 · 09 §5의 props 열. 여기 없는 키는 버린다. */
  props: readonly string[];
}

/**
 * 06-analytics §3 전부 + 09-notifications §5 4종. **여기 없는 이름은 400이다.**
 *
 * 이름과 props를 문서에서 그대로 옮겼다. 늘리려면 문서를 먼저 고친다.
 */
export const EVENTS = {
  // ── 유입 · 탐색 (06 §3) ────────────────────────────────
  feed_view: { source: "client", props: ["filter"] },
  feed_card_click: { source: "client", props: ["mode", "relationship"] },
  letter_view: { source: "client", props: ["mode", "relationship", "source"] },

  // ── 작성 (06 §3) ───────────────────────────────────────
  write_start: { source: "client", props: ["entry"] },
  write_relationship_selected: { source: "client", props: ["relationship"] },
  write_body_done: { source: "client", props: ["length"] },
  write_mode_selected: { source: "client", props: ["mode"] },
  write_submit_attempt: { source: "client", props: ["mode"] },
  // 인터스티셜 회귀율(06 §6 #6)의 유일한 소스. 서버는 사용자가 고쳤는지 그냥
  // 나갔는지 볼 수 없다 (04 §5 발견 5) — 그래서 이 넷만은 반드시 클라이언트다.
  filter_warned: { source: "client", props: ["risk", "flags"] },
  filter_revised: { source: "client", props: ["risk"] },
  filter_forced: { source: "client", props: ["risk"] },
  filter_abandoned: { source: "client", props: ["risk"] },
  // 실제로 행이 생겼는지는 서버만 안다.
  letter_created: { source: "server", props: ["mode", "relationship", "risk"] },
  contact_added: { source: "server", props: [] },

  // ── 열람 (06 §3) ───────────────────────────────────────
  unlock_view: { source: "client", props: ["relationship"] },
  unlock_attempt: { source: "server", props: ["success", "attemptNo"] },
  unlock_success: { source: "server", props: ["relationship", "attemptNo"] },
  recipient_response: { source: "server", props: ["response", "relationship"] },
  post_unlock_continue: { source: "client", props: ["response", "target"] },
  post_unlock_exit: { source: "client", props: ["response"] },

  // ── 유통 (06 §3) ───────────────────────────────────────
  share_opened: { source: "client", props: ["mode", "from"] },
  share_copied: { source: "client", props: ["mode", "kind"] },

  // ── 안전 · 관리 (06 §3) ────────────────────────────────
  report_submitted: { source: "server", props: ["reason", "relationship"] },
  manage_view: { source: "server", props: ["status"] },
  letter_deleted: { source: "server", props: ["ageHours"] },
  appeal_submitted: { source: "server", props: [] },

  // ── 발송 (09 §5) ───────────────────────────────────────
  email_sent: { source: "server", props: ["kind"] },
  email_failed: { source: "server", props: ["kind"] },
  email_unsubscribed: { source: "server", props: ["kind"] },
  admin_alert_sent: { source: "server", props: ["reason"] },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof EVENTS;

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && value in EVENTS;
}

/** `/api/events`가 받아도 되는 이름인가. */
export function isClientEvent(name: EventName): boolean {
  return EVENTS[name].source === "client";
}

// ── props 정제 ─────────────────────────────────────────────

/**
 * 문자열 props의 상한. props는 전부 열거값이거나 짧은 라벨이라 이 길이면 충분하고,
 * 넘는 값은 자르지 않고 **버린다** — 잘라서 담으면 잘린 값이 정상값인 척한다.
 * 가설값이다.
 */
const MAX_STRING = 64;

/** `filter_warned.flags`의 상한. 편지 하나에 이보다 많은 플래그는 정상이 아니다. 가설값. */
const MAX_FLAGS = 20;

// 목록의 단일 출처는 safety/types.ts의 런타임 배열이다 (05-api §1). 여기서 다시
// 적으면 kind가 하나 늘어나는 날 조용히 어긋난다.
const KINDS: ReadonlySet<string> = new Set(FLAG_KINDS);
const FIELDS: ReadonlySet<string> = new Set(FLAG_FIELDS);

/** 05-api §1의 flags 배열만 남긴다. kind·field 밖의 키는 버린다. */
function sanitizeFlags(value: unknown): Array<{ kind: string; field: string }> {
  if (!Array.isArray(value)) return [];
  const flags: Array<{ kind: string; field: string }> = [];
  for (const entry of value.slice(0, MAX_FLAGS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, field } = entry as { kind?: unknown; field?: unknown };
    if (typeof kind !== "string" || !KINDS.has(kind)) continue;
    if (typeof field !== "string" || !FIELDS.has(field)) continue;
    flags.push({ kind, field });
  }
  return flags;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (key === "flags") return sanitizeFlags(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length <= MAX_STRING ? value : undefined;
  }
  return undefined;
}

/**
 * 이벤트가 선언한 키만, 담을 수 있는 형태로만 남긴다.
 *
 * 모르는 키는 조용히 버린다 — 400으로 돌려주면 클라이언트가 어떤 키가 통과하는지
 * 알아내는 도구가 된다. 계측은 부가 기능이라 사용자 흐름을 막지 않는다.
 */
export function pickProps(name: EventName, raw: unknown): EventProps {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const props: EventProps = {};
  for (const key of EVENTS[name].props) {
    if (!(key in source)) continue;
    const value = sanitizeValue(key, source[key]);
    if (value !== undefined) props[key] = value;
  }
  return props;
}
