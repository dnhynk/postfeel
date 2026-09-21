// POST /api/letters — 05-api §1의 5단계를 그대로 구현한다.
//
//   risk = low     → 즉시 생성, 201
//   risk = medium  → 200 { status: 'needs_confirmation', risk, flags, confirmation }
//   risk = high    → 200 { status: 'blocked', risk, flags }   ← confirmation 없음
//   재제출         → 서명 검증 + contentHash 대조 → 등급 재판정 없이 생성
//
// **예외 하나** — 분류기 장애로 medium이 된 편지에는 인터스티셜을 띄우지 않고 201로
// 즉시 생성한다 (05-api §1 「층 2 실패 시」 마지막 문단). 말할 플래그가 없는 모호한
// 경고는 우회 학습만 시킨다. 그 판정은 여기서 하지 않는다 — grade.ts가 `action:
// 'create'` + `classifierState: 'unavailable'`로 돌려주고, 이 파일은 그걸 따른다.
// 안전 테스트 12가 고정한다.
//
// `high`는 저장하지 않는다. `filter_events`에만 남는다 (04 「저장하지 않는 것」).

import {
  MAX_ANSWER,
  MAX_BODY,
  MAX_HINT,
  MAX_QUESTION,
} from "@/components/write/limits";
import { withSession, ensureSession } from "@/lib/analytics/session";
import { contentHash, issue, verify } from "@/lib/confirmation";
import { invalidRequest, rateLimited, writingDisabled } from "@/lib/errors";
import { record } from "@/lib/events";
import { fingerprint } from "@/lib/fingerprint";
import { createLetter, recordFilterEvent } from "@/lib/letters/create";
import { LIMITS, countLettersByAuthor, exceeded } from "@/lib/ratelimit";
import { grade } from "@/lib/safety/grade";
import { classify } from "@/lib/safety/classifier";
import { runLayer1 } from "@/lib/safety/layer1";
import type {
  ClassifierOutcome,
  Flag,
  LetterDraft,
  LetterMode,
  Relationship,
} from "@/lib/safety/types";
import { retentionHealthy, writingEnabled } from "@/lib/settings";

const MODES: LetterMode[] = ["open", "locked"];
const RELATIONSHIPS: Relationship[] = [
  "ex",
  "friend",
  "family",
  "coworker",
  "other",
];

interface RequestBody {
  mode?: unknown;
  relationship?: unknown;
  body?: unknown;
  hint?: unknown;
  question?: unknown;
  answer?: unknown;
  ageConfirmed?: unknown;
  confirmation?: unknown;
}

/** 없거나 빈 문자열이면 undefined. 05-api §2의 선택 필드를 한 가지로 정리한다. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() === "" ? undefined : value;
}

interface ParsedRequest {
  draft: LetterDraft;
  confirmation?: string;
}

/**
 * 05-api §2의 요청 형태. 실패 메시지는 **사용자에게 그대로 보여줄 한국어**다
 * (05-api §6 — 코드→문구 매핑 테이블을 두지 않는다).
 */
function parseRequest(payload: unknown): ParsedRequest | string {
  if (typeof payload !== "object" || payload === null) {
    return "요청 형식이 올바르지 않습니다.";
  }
  const raw = payload as RequestBody;

  // D-032 — 작성에도 만 14세 확인이 붙는다(열람·피드에는 붙지 않는다). **다른 검증보다
  // 먼저 본다**: 확인 없는 요청은 분류기·레이트리밋·저장 경로 근처에도 가지 않는다.
  // 클라이언트 체크박스만으로는 안 된다 — 이메일 등록의 같은 규칙과 같은 이유이고
  // (manage/[token]/contact/route.ts · 안전 테스트 14), 비교도 같은 엄격 비교다.
  // `!== true`를 느슨하게 열어두면 아무 값이나 넣어 우회할 수 있다. 안전 테스트 29.
  if (raw.ageConfirmed !== true) {
    return "만 14세 이상임을 확인해 주세요.";
  }

  if (typeof raw.mode !== "string" || !MODES.includes(raw.mode as LetterMode)) {
    return "편지를 어떻게 남길지 선택해 주세요.";
  }
  if (
    typeof raw.relationship !== "string" ||
    !RELATIONSHIPS.includes(raw.relationship as Relationship)
  ) {
    return "누구에게 보내지 못한 말인지 선택해 주세요.";
  }
  const mode = raw.mode as LetterMode;
  const relationship = raw.relationship as Relationship;

  if (typeof raw.body !== "string" || raw.body.trim() === "") {
    return "편지 내용을 적어주세요.";
  }
  if (raw.body.length > MAX_BODY) {
    return `본문은 ${MAX_BODY}자까지 쓸 수 있습니다.`;
  }

  const hint = optionalText(raw.hint);
  const question = optionalText(raw.question);
  const answer = optionalText(raw.answer);
  const confirmation = optionalText(raw.confirmation);

  if (mode === "locked") {
    if (hint === undefined) return "둘만 아는 순간을 하나 적어주세요.";
    if (hint.length > MAX_HINT) return `단서는 ${MAX_HINT}자까지 쓸 수 있습니다.`;
    if (question === undefined) return "그 사람만 답할 수 있는 질문을 적어주세요.";
    if (question.length > MAX_QUESTION) {
      return `질문은 ${MAX_QUESTION}자까지 쓸 수 있습니다.`;
    }
    if (answer === undefined) return "답을 적어주세요.";
    if (answer.length > MAX_ANSWER) {
      return `답은 ${MAX_ANSWER}자까지 쓸 수 있습니다.`;
    }
    return {
      draft: { mode, relationship, body: raw.body, hint, question, answer },
      ...(confirmation === undefined ? {} : { confirmation }),
    };
  }

  // open에 단서·질문·답이 실려 오면 거절한다. 조용히 버리면 그 값이 들어간
  // contentHash와 저장되는 편지가 어긋나고, 04의 locked_fields 제약과도 맞지 않는다.
  if (hint !== undefined || question !== undefined || answer !== undefined) {
    return "누구나 읽을 수 있는 편지에는 단서·질문·답을 넣지 않습니다.";
  }

  return {
    draft: { mode, relationship, body: raw.body },
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}

// ── notice ────────────────────────────────────────────────
//
// 05-api §1: **`notice`에는 본문을 인용하지 않는다.** 그대로 화면에 뜨고, 사용자가
// 캡처해 공유하면 우리 통제를 벗어난다. 분류기가 규칙을 어기고 조각을 실어 보낼 수
// 있으므로 내보내는 경계에서 한 번 막는다 — 인용이 의심되면 문구를 버리고
// 클라이언트의 flags 기반 폴백으로 떨어진다.

/** 인터스티셜 한 문장이라 이보다 길 이유가 없다. 가설값. */
const NOTICE_MAX = 200;

/** 이 길이의 연속 일치는 우연이 아니다. 가설값. */
const QUOTE_WINDOW = 12;

function quotesDraft(notice: string, draft: LetterDraft): boolean {
  for (const text of [draft.body, draft.hint, draft.question, draft.answer]) {
    if (!text) continue;
    for (let i = 0; i + QUOTE_WINDOW <= text.length; i += 1) {
      if (notice.includes(text.slice(i, i + QUOTE_WINDOW))) return true;
    }
  }
  return false;
}

function safeNotice(
  notice: string | undefined,
  draft: LetterDraft,
): string | undefined {
  if (notice === undefined) return undefined;
  const trimmed = notice.trim();
  if (trimmed === "" || trimmed.length > NOTICE_MAX) return undefined;
  return quotesDraft(trimmed, draft) ? undefined : trimmed;
}

/**
 * 분류기가 던지면 `unavailable`로 본다.
 *
 * 계약상 층 2는 실패를 `{ state: 'unavailable' }`로 돌려주지만(safety/types.ts),
 * 던지는 구현이 섞이면 제출 경로가 500이 되어 **분류기 장애가 곧 작성 불가**가 된다.
 * D-015가 명시적으로 피한 실패 모드다. 여기서 계약대로 접는다.
 */
async function classifySafely(draft: LetterDraft): Promise<ClassifierOutcome> {
  try {
    return await classify(draft);
  } catch (error) {
    return {
      state: "unavailable",
      reason: error instanceof Error ? error.message : "classifier_threw",
    };
  }
}

export async function POST(request: Request): Promise<Response> {
  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  // 킬 스위치는 **핸들러에서** 본다. 미들웨어 캐시 때문에 즉시 반영되지 않으면
  // 스위치의 의미가 없다 (05-api §6).
  //
  // **세 번째 스위치는 파기 잡이 끈다** (D-031). 운영자 스위치와 같은 응답을 주는
  // 이유: 작성자에게는 "지금 쓸 수 없다"가 전부이고, 왜 꺼졌는지는 운영자가 알아야
  // 하는 정보이지 이용자에게 흘릴 정보가 아니다. 구분은 `app_settings`에 남는다.
  if (!(await writingEnabled())) return respond(writingDisabled());
  if (!(await retentionHealthy())) return respond(writingDisabled());

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return respond(invalidRequest("요청 본문이 JSON이 아닙니다."));
  }

  const parsed = parseRequest(payload);
  if (typeof parsed === "string") return respond(invalidRequest(parsed));
  const { draft } = parsed;

  // 레이트리밋은 분류기 앞에 둔다. 걸릴 요청에 외부 API 비용을 쓰지 않는다.
  // 카운터 테이블 없이 `letters.author_fp_hash`로 센다 (05-api §5).
  const fpHash = fingerprint(request.headers);
  for (const rule of [
    LIMITS.letterCreatePerMinute,
    LIMITS.letterCreatePerHour,
  ]) {
    const count = await countLettersByAuthor(fpHash, rule.windowMs);
    if (exceeded(count, rule)) {
      return respond(rateLimited(Math.ceil(rule.windowMs / 1000)));
    }
  }

  const created = async (
    risk: "low" | "medium",
    flags: Flag[],
    classifierState: "ok" | "unavailable",
    filterEventId?: number,
  ) => {
    const letter = await createLetter({
      draft,
      risk,
      flags,
      classifierState,
      fpHash,
      ...(filterEventId === undefined ? {} : { filterEventId }),
    });
    try {
      // 06-analytics §2 — 편지 ID는 props에 담지 않는다. 속성만 담는다.
      await record("letter_created", session.sessionId, {
        mode: draft.mode,
        relationship: draft.relationship,
        risk,
      });
    } catch {
      // 계측 실패로 편지 생성을 되돌리지 않는다.
    }
    return respond(
      Response.json(
        { status: "created", id: letter.id, manageToken: letter.manageToken },
        { status: 201 },
      ),
    );
  };

  // ── 재제출 (05-api §1 4~5단계) ───────────────────────────
  // 서명·만료·contentHash가 전부 맞을 때만 재판정 없이 생성한다. 하나라도 어긋나면
  // **아래 판정 경로로 그대로 떨어진다** — 고친 편지는 고친 내용으로 다시 판정받고,
  // 토큰으로 필터를 우회할 수는 없다 (안전 테스트 4).
  if (parsed.confirmation !== undefined) {
    const result = verify(parsed.confirmation, draft);
    if (result.ok) {
      // `letters.risk_flags`를 채울 출처가 이 토큰밖에 없다 (05-api §1).
      // confirm은 분류기가 ok일 때만 나오므로 classifier_state는 'ok'다.
      return created(
        "medium",
        result.payload.flags,
        "ok",
        result.payload.filterEventId,
      );
    }
  }

  // ── 1차 판정 (05-api §1 2단계) ───────────────────────────
  const decision = grade(runLayer1(draft), await classifySafely(draft));

  if (decision.action === "block") {
    await recordFilterEvent({
      outcome: "blocked",
      risk: "high",
      flags: decision.flags,
      mode: draft.mode,
    });
    // confirmation을 발급하지 않는다. 클라이언트를 조작해도 통과 경로가 없다
    // (05-api §1 · 안전 테스트 3).
    return respond(
      Response.json({ status: "blocked", risk: "high", flags: decision.flags }),
    );
  }

  if (decision.action === "confirm") {
    const filterEventId = await recordFilterEvent({
      outcome: "warned",
      risk: "medium",
      flags: decision.flags,
      mode: draft.mode,
    });
    const confirmation = issue({
      contentHash: contentHash(draft),
      flags: decision.flags,
      filterEventId,
    });
    const notice = safeNotice(decision.notice, draft);
    return respond(
      Response.json({
        status: "needs_confirmation",
        risk: "medium",
        flags: decision.flags,
        confirmation,
        ...(notice === undefined ? {} : { notice }),
      }),
    );
  }

  return created(decision.risk, decision.flags, decision.classifierState);
}
