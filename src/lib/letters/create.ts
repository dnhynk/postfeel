// 편지 생성 — `POST /api/letters`가 실제로 행을 만드는 자리 (05-api §1 · §2).
//
// 판정은 여기서 하지 않는다. 등급을 합치는 곳은 safety/grade.ts 하나이고, 이 파일은
// **이미 내려진 판정을 저장**한다. 그래서 인자로 `risk`·`flags`·`classifierState`를
// 받는다 — 여기서 다시 계산하면 규칙이 두 곳에 살게 된다.
//
// `high`는 이 파일에 오지 않는다. 저장되지 않고 `filter_events`에만 남는다
// (04 「저장하지 않는 것」). `risk` 타입이 그걸 막고 있다.
//
// 상태는 항상 `published`로 시작한다 (04 §3 상태 기계). 이후의 상태 전이는 전부
// letters/deletion.ts에 있다 — 그 규약대로 여기서는 status를 나중에 UPDATE 하지
// 않는다.
//
// ── 표기 변형은 응답 뒤에 채운다 ────────────────────────────
// 05-api §1이 남겨둔 "locked 제출은 예산이 두 배(4초 + 4초)"가 여기였다. 3초를 제출
// 경로의 상한으로 정해놓고 최악 8초를 기다리게 할 수는 없다. D-021과 05-api §1이 이미
// "이 호출이 실패하면 변형 없이 생성한다"고 정했으므로 변형은 편지 생성의 선행 조건이
// 아니다 — 실패해도 되는 것을 사용자가 기다릴 이유가 없다.
//
// 그래서 편지를 먼저 만들어 응답을 돌려주고, 변형 생성과 `answer_variant_hmacs` 갱신은
// `scheduleAfterResponse`로 미룬다. 실패하면 지금과 같다 — `answer_hmac` 하나로 여는
// 동작이다.
//
// **감수하는 위험**: 생성 직후 몇 초 안에 수신자가 열려고 하면 변형이 아직 없을 수 있고,
// 그동안은 원문과 정확히 같은 답만 통과한다. 공유 → 전달 → 열람까지 걸리는 시간을
// 생각하면 무시할 만하다고 봤다.

import { answerHmac } from "../answer";
import { manageTokenHash, randomToken } from "../crypto";
import { query, withTransaction } from "../db";
import { newId } from "../ids";
import { scheduleAfterResponse } from "../notify/schedule";
import { generateAnswerVariants } from "../safety/classifier";
import type { Flag, LetterDraft, LetterMode, RiskLevel } from "../safety/types";

/** 04 §2 `filter_events.outcome`. 서버가 실제로 관측 가능한 값만 있다 (04 §5 발견 5). */
export type FilterOutcome = "blocked" | "warned" | "published";

/**
 * 필터 판정 로그 한 행. **본문은 들어가지 않는다** (04 §2).
 *
 * `warned`는 id를 돌려준다 — confirmation 토큰이 이 id를 서명해 실어 나르고,
 * 재제출이 오면 같은 행을 `published`로 올린다 (05-api §1).
 */
export async function recordFilterEvent(input: {
  outcome: FilterOutcome;
  risk: RiskLevel;
  flags: Flag[];
  mode: LetterMode;
}): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `insert into filter_events (risk_level, flags, mode, outcome)
     values ($1, $2::jsonb, $3, $4)
     returning id`,
    [input.risk, JSON.stringify(input.flags), input.mode, input.outcome],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("filter_events가 id를 돌려주지 않았다.");
  return Number(id);
}

export interface CreateLetterInput {
  draft: LetterDraft;
  /** 판정 결과. `high`는 여기 오지 않는다. */
  risk: "low" | "medium";
  /** 04 §2 `risk_flags` — 분류기 응답 그대로. 재제출 경로에서는 토큰의 flags다. */
  flags: Flag[];
  classifierState: "ok" | "unavailable";
  fpHash: Buffer;
  /**
   * 재제출이면 1차 판정이 남긴 `filter_events` 행 id. 그 행을 `warned` →
   * `published`로 올린다. 없으면 `published` 행을 새로 넣는다 (05-api §1).
   */
  filterEventId?: number;
}

export interface CreatedLetter {
  id: string;
  /** **이 값이 노출되는 유일한 자리다.** DB에는 sha256만 있다 (D-014). */
  manageToken: string;
}

/**
 * 표기 변형의 HMAC들 (D-021 · 05-api §1).
 *
 * **실패하면 빈 배열이다.** 05-api §1: 이 호출이 실패해도 변형 없이 생성한다 —
 * `answer_hmac` 하나로 여는 동작으로 떨어질 뿐이고, 편지가 안 만들어지는 쪽이 훨씬
 * 나쁘다. 그래서 여기서 던지지 않는다.
 *
 * 원본과 같은 해시는 버린다. 같은 값을 두 번 저장할 이유가 없고, 원문은 어느 쪽에도
 * 남지 않는다 (04 §4).
 */
async function variantHmacs(letterId: string, answer: string, main: Buffer) {
  let variants: string[] = [];
  try {
    variants = await generateAnswerVariants(answer);
  } catch {
    return [];
  }
  if (!Array.isArray(variants)) return [];

  const seen = new Set([main.toString("hex")]);
  const hmacs: Buffer[] = [];
  for (const variant of variants) {
    if (typeof variant !== "string" || variant.trim() === "") continue;
    const hmac = answerHmac(letterId, variant);
    const key = hmac.toString("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    hmacs.push(hmac);
  }
  return hmacs;
}

/**
 * 변형을 만들어 채워 넣는다. **응답이 나간 뒤에 돈다.**
 *
 * 던지지 않는다 — 응답 밖이라 받아줄 사람이 없다. 실패하면 변형이 빈 채로 남고, 그게
 * 05-api §1이 정한 폴백(`answer_hmac` 하나로 여는 동작) 그대로다.
 *
 * 지워진 편지는 건너뛴다. 미루는 사이에 작성자가 지웠으면 채울 이유가 없다.
 */
export async function fillAnswerVariants(
  letterId: string,
  answer: string,
  main: Buffer,
): Promise<void> {
  try {
    const hmacs = await variantHmacs(letterId, answer, main);
    if (hmacs.length === 0) return;
    await query(
      `update letters
          set answer_variant_hmacs = $2
        where id = $1 and status <> 'deleted_by_author'`,
      [letterId, hmacs],
    );
  } catch (error) {
    console.error("[letters] 표기 변형 채우기 실패", error);
  }
}

/**
 * 편지 한 통을 만든다. 행 생성과 `filter_events` 확정이 한 트랜잭션이다 — 둘이
 * 갈라지면 강행률(04 §5 발견 5)이 실제와 달라진다.
 */
export async function createLetter(
  input: CreateLetterInput,
): Promise<CreatedLetter> {
  const { draft } = input;
  const id = newId();
  const manageToken = randomToken();

  // 잠금은 이 해시 하나로 성립한다 (05-api §1). 변형은 응답 뒤에 붙는다.
  const answer =
    draft.mode === "locked" && draft.answer !== undefined
      ? answerHmac(id, draft.answer)
      : null;

  await withTransaction(async (client) => {
    await client.query(
      `insert into letters (
         id, mode, relationship, body,
         hint, question, answer_hmac, answer_variant_hmacs,
         risk_level, risk_flags,
         classifier_state,
         status,
         manage_token_hash, author_fp_hash
       ) values (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10::jsonb,
         $11,
         'published',
         $12, $13
       )`,
      [
        id,
        draft.mode,
        draft.relationship,
        draft.body,
        draft.hint ?? null,
        draft.question ?? null,
        answer,
        // 응답 뒤에 채운다 (아래 `fillAnswerVariants`).
        [],
        input.risk,
        JSON.stringify(input.flags),
        input.classifierState,
        manageTokenHash(manageToken),
        input.fpHash,
      ],
    );

    if (input.filterEventId === undefined) {
      await client.query(
        `insert into filter_events (risk_level, flags, mode, outcome)
         values ($1, $2::jsonb, $3, 'published')`,
        [input.risk, JSON.stringify(input.flags), draft.mode],
      );
    } else {
      // 1차 판정 행을 올린다. 이미 published면 아무것도 하지 않는다 —
      // 같은 토큰으로 두 번 제출해도 강행이 두 번 세어지지 않는다.
      await client.query(
        `update filter_events set outcome = 'published'
          where id = $1 and outcome = 'warned'`,
        [input.filterEventId],
      );
    }
  });

  // 편지가 커밋된 뒤에 예약한다. 트랜잭션이 굴러떨어지면 채울 행 자체가 없다.
  if (answer !== null && draft.answer !== undefined) {
    const plain = draft.answer;
    scheduleAfterResponse("answer_variants", () =>
      fillAnswerVariants(id, plain, answer),
    );
  }

  return { id, manageToken };
}
