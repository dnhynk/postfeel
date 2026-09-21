// 편지 픽스처. 다른 워커들이 이걸 쓴다.
//
// 컬럼과 기본값은 docs/04-data-model.md §2를 따른다. 여기에 문서에 없는 컬럼을
// 더하지 않는다. 테스트가 스키마보다 넓어지면 스키마 회귀를 못 잡는다.

import { createHash, randomBytes } from "node:crypto";
import { query } from "@/lib/db";

export type LetterMode = "open" | "locked";
export type LetterRelationship =
  | "ex"
  | "friend"
  | "family"
  | "coworker"
  | "other";
export type LetterRiskLevel = "low" | "medium";
export type LetterStatus =
  | "published"
  | "hidden_auto"
  | "hidden_admin"
  | "deleted_by_author";
export type ClassifierState = "ok" | "unavailable" | "failed";

export interface LetterRow {
  id: string;
  mode: LetterMode;
  relationship: LetterRelationship;
  /** tombstone에서는 null이다 (D-027 · migrations/0003). 살아 있는 편지에는 항상 있다. */
  body: string | null;
  hint: string | null;
  question: string | null;
  answer_hmac: Buffer | null;
  answer_variant_hmacs: Buffer[];
  risk_level: LetterRiskLevel;
  risk_flags: unknown;
  classifier_state: ClassifierState;
  classifier_retry_count: number;
  status: LetterStatus;
  auto_hide_exempt: boolean;
  manage_token_hash: Buffer;
  author_fp_hash: Buffer;
  created_at: Date;
  status_changed_at: Date;
  deleted_at: Date | null;
}

export interface LetterOverrides {
  id?: string;
  mode?: LetterMode;
  relationship?: LetterRelationship;
  body?: string;
  hint?: string | null;
  question?: string | null;
  answerHmac?: Buffer | null;
  answerVariantHmacs?: Buffer[];
  riskLevel?: LetterRiskLevel;
  riskFlags?: unknown;
  classifierState?: ClassifierState;
  classifierRetryCount?: number;
  status?: LetterStatus;
  autoHideExempt?: boolean;
  manageToken?: string;
  authorFpHash?: Buffer;
  createdAt?: Date;
  statusChangedAt?: Date;
  deletedAt?: Date | null;
}

export interface InsertedLetter {
  letter: LetterRow;
  /** 원문은 DB에 없다 (D-014). 삽입한 쪽만 알 수 있어 여기서 함께 돌려준다. */
  manageToken: string;
}

/** nanoid(22)와 같은 길이·문자셋의 추측 불가 ID (04 §1-1). */
export function randomLetterId(): string {
  return randomBytes(17).toString("base64url").slice(0, 22);
}

export function randomManageToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** 레이트리밋 식별자 자리. 실제 산출식은 05-api §5. 테스트에서는 값만 있으면 된다. */
export function randomFpHash(): Buffer {
  return randomBytes(32);
}

/**
 * letters에 한 행을 넣는다. 기본값은 "피드에 뜨는 평범한 A 모드 편지"다.
 *
 * locked 편지를 만들려면 hint · question · answerHmac을 함께 넘겨야 한다 —
 * locked_fields 제약이 셋 중 하나라도 비면 삽입을 거부한다.
 *
 * **`status: 'deleted_by_author'`를 넘기면 본문 계열을 비워서 넣는다** (D-027).
 * 파기된 편지에 본문이 남아 있는 상태는 `deleted_is_purged` 제약이 거부하므로
 * 픽스처가 그런 행을 만들 수 없다. 원문을 함께 넘겨도 무시한다 — 여기서 조용히
 * 예외를 허용하면 **테스트만 통과하는 불가능한 상태**가 생기고, 그건 25번이
 * 지키려는 바로 그 성질이다.
 */
export async function insertLetter(
  overrides: LetterOverrides = {},
): Promise<InsertedLetter> {
  const manageToken = overrides.manageToken ?? randomManageToken();
  const mode = overrides.mode ?? "open";
  const now = new Date();
  const purged = (overrides.status ?? "published") === "deleted_by_author";

  const { rows } = await query<LetterRow>(
    `insert into letters (
       id, mode, relationship, body,
       hint, question, answer_hmac, answer_variant_hmacs,
       risk_level, risk_flags,
       classifier_state, classifier_retry_count,
       status, auto_hide_exempt,
       manage_token_hash, author_fp_hash,
       created_at, status_changed_at, deleted_at
     ) values (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10,
       $11, $12,
       $13, $14,
       $15, $16,
       $17, $18, $19
     ) returning *`,
    [
      overrides.id ?? randomLetterId(),
      mode,
      overrides.relationship ?? "friend",
      purged ? null : (overrides.body ?? "테스트 편지 본문."),
      purged ? null : overrides.hint ?? null,
      purged ? null : overrides.question ?? null,
      purged ? null : overrides.answerHmac ?? null,
      purged ? [] : overrides.answerVariantHmacs ?? [],
      overrides.riskLevel ?? "low",
      JSON.stringify(overrides.riskFlags ?? []),
      overrides.classifierState ?? "ok",
      overrides.classifierRetryCount ?? 0,
      overrides.status ?? "published",
      overrides.autoHideExempt ?? false,
      sha256(manageToken),
      overrides.authorFpHash ?? randomFpHash(),
      overrides.createdAt ?? now,
      overrides.statusChangedAt ?? overrides.createdAt ?? now,
      overrides.deletedAt ?? null,
    ],
  );

  const letter = rows[0];
  if (!letter) throw new Error("insertLetter가 행을 돌려받지 못했다.");
  return { letter, manageToken };
}
