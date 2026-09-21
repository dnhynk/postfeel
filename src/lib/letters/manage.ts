// 관리 표면 — `/manage/:token` · `/api/manage/:token` (05-api §3 · §2 「상태별 표면 응답」).
//
// 이 표면이 존재하는 이유: 이메일을 남기지 않은 작성자가 **자기 편지가 내려간 사실을 알
// 수 있는 유일한 경로**이고, 위협 모델 §4가 요구한 **이의 제기 경로**가 여기밖에 없다
// (04 §5 발견 2). 그래서 편지가 비공개 상태여도 이 표면은 열린다.
//
// ── 토큰 규약 (D-014) ────────────────────────────────────────
// 랜덤 32바이트(base64url). 서명 토큰이 아니고 세션도 없다. URL은 `/manage/<token>` —
// **편지 ID를 넣지 않는다.** 토큰이 틀려도 어느 편지에 대한 시도인지 노출되면 안 된다.
// 발급은 작성 표면(POST /api/letters)이 한다. 여기서는 검증만 한다.
//
// ── 상수 시간 비교를 쓰지 않는다 ─────────────────────────────
// 검증은 `sha256(token)`으로 `letters.manage_token_hash`(unique index)를 조회하는 것뿐이다.
// **원문 비교가 일어나지 않으므로 비교할 대상이 없고**, 인덱스 조회 시간은 토큰 값에
// 의존하지 않는다 (05-api §3 · src/lib/crypto.ts 주석). 여기에 constantTimeEqual을 끼워
// 넣으면 방어가 아니라 "여기도 비교가 있다"는 오해만 남는다 — 나중에 누가 "보안상"
// 넣고 싶어질 자리라 미리 적어 둔다.
//
// ── 킬 스위치를 보지 않는다 ──────────────────────────────────
// `public_read_enabled = false`여도 이 표면은 계속 동작한다 (05-api §6 · 07 §3). 사고
// 대응 중에도 작성자는 자기 편지를 지울 수 있어야 한다. 안전 테스트 #15가 고정한다.

import { query } from "../db";
import { manageTokenHash } from "../crypto";

export type LetterStatus =
  | "published"
  | "hidden_auto"
  | "hidden_admin"
  | "deleted_by_author";

/**
 * 왜 비공개인가. **코드값이고 문구가 아니다.**
 *
 * 05-api §6의 "문구 매핑 테이블을 두지 않는다"는 **오류 응답의 `message`** 규칙이다
 * (errors.ts). `statusReason`은 오류 메시지가 아니라 상태 코드값이고, 상태마다 화면
 * 레이아웃이 달라야 해서 문구가 아니라 코드로 내려간다. 두 규칙을 섞지 않는다.
 */
export type StatusReason = "reported" | "admin";

/** 05-api §3의 `GET /api/manage/:token` 응답. */
export interface ManageView {
  id: string;
  status: LetterStatus;
  statusReason?: StatusReason;
  canAppeal: boolean;
  /**
   * 판정이 아직 안 끝나 **보류 중인가** ([D-035](../../../docs/00-decisions.md)).
   *
   * 분류기 장애 중에 만들어진 편지는 판정 전까지 아무 표면에서도 읽히지 않는다.
   * 작성자에게는 그 사실을 말해야 한다 — 안 그러면 "올렸는데 링크가 404"가 된다.
   */
  pendingReview: boolean;
  /** 불리언이다. 몇 명이 열었는지도 언제인지도 주지 않는다 (D-007 · 05-api §3). */
  opened: boolean;
  /** D-023의 응답. 이메일을 남기지 않은 작성자가 이걸 확인할 수 있는 유일한 경로다. */
  recipientSaidYes: boolean;
}

/** 토큰으로 찾은 편지. 응답에 나가지 않는 값(`createdAt`)도 들어 있다. */
export interface ManagedLetter {
  id: string;
  status: LetterStatus;
  createdAt: Date;
  /** `classifier_state <> 'ok'` — 판정 대기 중이라 어디서도 안 읽힌다 (D-035). */
  pendingReview: boolean;
  opened: boolean;
  recipientSaidYes: boolean;
  /** 이의 제기 이력이 있는가. pending·restored·rejected를 가리지 않는다 (아래 canAppeal). */
  hasAppeal: boolean;
}

interface ManagedLetterRow {
  id: string;
  status: LetterStatus;
  created_at: Date;
  pending_review: boolean;
  opened: boolean;
  recipient_said_yes: boolean;
  has_appeal: boolean;
}

/**
 * 관리 토큰으로 편지 하나를 찾는다. 없으면 `null`.
 *
 * 토큰 형식을 미리 검사하지 않는다 — 어떤 문자열이든 sha256은 계산되고 맞는 행이 없으면
 * 그대로 못 찾는다. 형식 검사를 붙이면 "형식은 맞는데 없음"과 "형식부터 틀림"이 응답
 * 시간·코드로 갈라진다.
 *
 * `opened`·`recipientSaidYes`는 개수가 아니라 존재 여부다 (05-api §3). 잠긴 편지는
 * 제3자도 열고, 횟수를 보여주면 작성자가 없는 의미를 읽는다 (D-007).
 */
export async function findByManageToken(
  token: string,
): Promise<ManagedLetter | null> {
  const { rows } = await query<ManagedLetterRow>(
    `select l.id,
            l.status,
            l.created_at,
            (l.classifier_state <> 'ok') as pending_review,
            exists (select 1 from unlocks u where u.letter_id = l.id) as opened,
            exists (select 1 from unlocks u
                     where u.letter_id = l.id
                       and u.recipient_response = 'yes')            as recipient_said_yes,
            exists (select 1 from appeals a where a.letter_id = l.id) as has_appeal
       from letters l
      where l.manage_token_hash = $1`,
    [manageTokenHash(token)],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    pendingReview: row.pending_review,
    opened: row.opened,
    recipientSaidYes: row.recipient_said_yes,
    hasAppeal: row.has_appeal,
  };
}

/** 비공개 상태에만 있다. `published`·`deleted_by_author`에서는 필드 자체가 없다. */
export function statusReasonOf(status: LetterStatus): StatusReason | undefined {
  if (status === "hidden_auto") return "reported";
  if (status === "hidden_admin") return "admin";
  return undefined;
}

/**
 * 이의 제기는 **편지당 1회다. 가설값 — 실측 후 조정한다.**
 *
 * 비공개 상태(`hidden_auto`·`hidden_admin`)에서만 열리고, 이미 이의를 제기한 편지는
 * 결과가 나왔든(`restored`·`rejected`) 아직이든(`pending`) 다시 받지 않는다.
 *
 * 근거: 반려된 이의를 다시 제기해도 새 정보가 없다 — 작성자가 새 근거를 덧붙일 수단이
 * v0에 없다. 무제한 재제기는 운영 큐만 늘리고 판정을 바꾸지 못하는데, 운영 상한은
 * 하루 1시간이다 (07 §1 · §8). 인용된 편지는 `published`로 돌아가므로 애초에 이의 제기
 * 대상이 아니다 (04 §3).
 */
export function canAppeal(letter: ManagedLetter): boolean {
  if (letter.status !== "hidden_auto" && letter.status !== "hidden_admin") {
    return false;
  }
  return !letter.hasAppeal;
}

/** 05-api §3의 응답 형태로 좁힌다. `createdAt`처럼 응답에 없는 값은 여기서 떨어진다. */
export function manageView(letter: ManagedLetter): ManageView {
  const statusReason = statusReasonOf(letter.status);
  return {
    id: letter.id,
    status: letter.status,
    ...(statusReason ? { statusReason } : {}),
    canAppeal: canAppeal(letter),
    pendingReview: letter.pendingReview,
    opened: letter.opened,
    recipientSaidYes: letter.recipientSaidYes,
  };
}

/** 이의 제기 한 건 (04 §2 `appeals` · 04 §5 발견 2). 상태 전이는 운영자가 한다 (05-api §4). */
export async function insertAppeal(
  letterId: string,
  message: string | null,
): Promise<void> {
  await query("insert into appeals (letter_id, message) values ($1, $2)", [
    letterId,
    message,
  ]);
}
