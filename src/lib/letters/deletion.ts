// ─────────────────────────────────────────────────────────────
// 이 파일이 따로 존재하는 이유 — L-007 격리 지점
// ─────────────────────────────────────────────────────────────
//
// [L-007](../../../docs/00-decisions.md) — "미성년 관련 성적 콘텐츠 삭제 후 데이터
// 처리"는 **2026-08-16에 답이 왔다** (00 「M0 답」 · D-027 · D-028).
//
//   · 작성자 삭제 · 권리침해 삭제 결정 → **완전 파기 + tombstone** (D-027) ← 아래 구현됨
//   · 신고로 내린 것              → 최대 30일 암호화 격리 후 종결 (D-028) ← **미구현**
//
// 답이 오기 전에 삭제·비공개 SQL이 표면마다 흩어졌다면 답이 온 날 12개 파일을 찾아
// 고쳐야 했고 그중 하나를 빠뜨리면 그게 곧 사고였다. **그래서 편지가 사라지는 모든
// 경로를 이 파일 하나에 모았다.** 실제로 D-027 반영은 마이그레이션 1개(`0003`) +
// 이 파일 1개로 끝났다. **D-028도 같은 자리로 온다** — 격리 전이를 다른 파일에 두지 않는다.
//
// ── 규약 ─────────────────────────────────────────────────────
// **이 파일 밖에서 `letters`의 `status`·`deleted_at`을 직접 UPDATE하지 않는다.**
// 복귀 전이(신고 `dismiss` · 이의 제기 `restore` → `published` + `auto_hide_exempt`)는
// 아래 `restoreToPublishedTx`가 맡는다. 없는 전이가 또 필요해지면 자기 파일에서 UPDATE
// 하지 말고 **여기에 함수를 더한다.**
//
// 상태 기계는 04 §3이고, 상태별 표면 응답은 05-api §2다.
//
// ── `...Tx` 접미사 ───────────────────────────────────────────
// 운영자 판정은 편지 상태 + 판정 행(`reports`·`appeals`) + `admin_actions`를 함께 바꾼다
// (05-api §4). 셋이 갈라지면 큐에 결론 없는 항목이 남으므로 한 트랜잭션이어야 하는데,
// 판정 행 SQL은 편지 상태가 아니라서 이 파일의 것이 아니다. 그래서 트랜잭션 클라이언트를
// 받는 변형을 둔다 — **편지 UPDATE는 여전히 이 파일에만 있고**, 나머지는 부르는 쪽에
// 있으면서 원자성이 유지된다.

import type { PoolClient } from "pg";
import { query, withTransaction } from "../db";
import { seal, unseal } from "../crypto";
import { env, requireEnv } from "../env";

/**
 * 작성자 삭제 — **완전 파기다** (D-027 · 04 §3).
 *
 * `status = 'deleted_by_author'`, `deleted_at = now()`, 그리고 **본문·단서·질문·답
 * 해시·변형 해시를 전부 지운다.** 남는 것은 `manage_token_hash` · 상태 · 시각뿐이다
 * (tombstone). 왜 행을 통째로 지우지 않는지는 `migrations/0003`의 주석에 있다.
 *
 * **`author_contacts` 행은 함께 지운다** (아래 `deleteByAuthorTx`).
 *
 * 이미 지워진 편지에는 아무것도 하지 않고 `false`를 돌려준다 — 관리 화면이 410을
 * 돌려줄 수 있게 (05-api §2).
 *
 * 비공개 상태(`hidden_auto`·`hidden_admin`)에서도 지울 수 있다. 관리 화면은 그
 * 상태에서도 열려 있고(05-api §2), 작성자가 자기 편지를 지우는 길을 막을 이유가 없다.
 */
export async function deleteByAuthor(letterId: string): Promise<boolean> {
  return withTransaction((client) => deleteByAuthorTx(client, letterId));
}

/**
 * 같은 삭제를 부르는 쪽의 트랜잭션 안에서. **관리 링크 분실 삭제 요청**이 쓴다 (07 §5).
 *
 * 그 경로도 결국 **작성자 본인의 삭제**다 — 관리 링크를 잃어버렸을 뿐이고, 운영자는
 * 본문 대조를 대신해줄 뿐이다. 그래서 `hidden_admin`이 아니라 여기로 온다. 상태가
 * `deleted_by_author`여야 나중에 작성자가 관리 링크를 찾았을 때 410("이미 지웠다")을
 * 보고, "운영자가 내렸다 · 이의 제기 가능"으로 잘못 읽지 않는다 (05-api §2 표).
 *
 * ── 이메일도 같은 트랜잭션에서 지운다 ────────────────────────
 * `author_contacts.letter_id`에 `on delete cascade`가 걸려 있지만 행이 tombstone으로 남아
 * cascade가 돌지 않는다. 그래서 여기서 명시적으로 지운다.
 *
 * 지우는 이유: 그 주소가 존재하는 목적은 **이 편지에 관한 알림 4종**뿐이고(09 §2),
 * 작성자가 편지를 지우면 넷 다 발생할 수 없다 — 목적이 사라진다. D-005가 "알림 시점에만
 * 수집"으로 최소수집을 못박았고 04 §1-3이 "개인정보 삭제 = 이 테이블 한 행 삭제"라고
 * 정의했으니, 목적이 끝난 행을 남기는 쪽이 그 원칙과 어긋난다. 07 §5의 "편지 자체는
 * 별개"는 반대 방향(이메일을 지워도 편지는 남는다)을 말한 문장이다.
 *
 * **`email_suppressions`에는 넣지 않는다.** 억제 목록은 "이 주소는 거부했다"는 기록이고
 * (09 §1), 편지 삭제는 거부가 아니다. 넣으면 나중에 같은 사람이 새 편지에 같은 주소를
 * 등록하려 할 때 막힌다.
 *
 * **`hidden_auto`·`hidden_admin`에서는 지우지 않는다** — 그 전이는 아래 `autoHide` ·
 * `hideByAdmin`이고 이 함수를 거치지 않는다. 되돌릴 수 있는 상태이고(이의 제기 ·
 * `restoreToPublishedTx`), 3번 메일이 바로 그 비공개를 알리는 메일이다. 거기서 주소를
 * 지우면 작성자가 자기 편지가 내려간 걸 영영 모른다.
 *
 * 한 트랜잭션인 이유: 편지는 지워졌는데 주소만 남는 중간 상태가 생기면 안 된다.
 */
export async function deleteByAuthorTx(
  client: PoolClient,
  letterId: string,
): Promise<boolean> {
  // 상태 전이와 파기를 **한 문장으로** 한다. 나눠 쓰면 "지웠다고 적혔는데 본문이 남은"
  // 중간 상태가 생기고, 그 상태를 `deleted_is_purged` 제약이 거부해 트랜잭션이 죽는다.
  // 제약이 코드를 강제하는 쪽이 맞다 — 순서를 기억에 맡기지 않는다 (migrations/0003).
  const { rowCount } = await client.query(
    `update letters
        set status = 'deleted_by_author',
            deleted_at = now(),
            status_changed_at = now(),
            body = null,
            hint = null,
            question = null,
            answer_hmac = null,
            answer_variant_hmacs = '{}'
      where id = $1 and status <> 'deleted_by_author'`,
    [letterId],
  );
  if ((rowCount ?? 0) === 0) return false;

  await client.query("delete from author_contacts where letter_id = $1", [
    letterId,
  ]);
  return true;
}

/**
 * 운영자 조치 — `hidden_admin`으로 내린다 (04 §3).
 *
 * 모든 운영자 호출은 `admin_actions`에 기록한다 (05-api §4). 상태 변경과 기록이
 * 갈라지면 안 되므로 한 트랜잭션이다.
 */
export async function hideByAdmin(
  letterId: string,
  note: string | null,
): Promise<boolean> {
  return withTransaction(async (client) => {
    if (!(await hideByAdminTx(client, letterId))) return false;

    await client.query(
      `insert into admin_actions (action, target_id, note)
       values ('hide_letter', $1, $2)`,
      [letterId, note],
    );
    return true;
  });
}

/**
 * 같은 전이를 부르는 쪽의 트랜잭션 안에서. 신고 `uphold`가 쓴다 — 편지를 내리는 것과
 * `reports.status`를 `upheld`로 바꾸는 것이 갈라지면 큐에 결론 없는 항목이 남는다.
 *
 * `admin_actions` 기록은 여기서 하지 않는다. 부르는 쪽이 자기 `action` 이름으로 같은
 * 트랜잭션에 남긴다.
 */
export async function hideByAdminTx(
  client: PoolClient,
  letterId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update letters
        set status = 'hidden_admin',
            status_changed_at = now()
      where id = $1 and status <> 'deleted_by_author'`,
    [letterId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 관리 링크 분실 시의 삭제 요청 접수 (04 §5 발견 3 · 07 §5).
 *
 * **편지 상태를 바꾸지 않는다.** 본인 확인은 본문 일부 대조이고 그 대조는 운영자가
 * 사람으로 한다 (07 §5). 자동으로 편지를 찾아 지우면 본문 일부만 아는 사람이 남의
 * 편지를 지울 수 있게 된다. 그래서 `letter_id`는 비워 두고 접수만 한다 — 운영자가
 * 큐에서 대조한 뒤 채운다.
 *
 * 그럼에도 이 파일에 두는 이유: `body_excerpt`는 편지 본문의 조각이라 **본문이 남는
 * 또 하나의 자리**이고, L-007의 답이 "완전 삭제"면 여기도 함께 처리해야 한다. 편지가
 * 사라지는 경로를 한 파일에서 보게 하는 게 이 파일의 목적이다.
 */
export async function insertDeletionRequest(
  bodyExcerpt: string,
  contact: string | null,
): Promise<void> {
  await query(
    "insert into deletion_requests (body_excerpt, contact) values ($1, $2)",
    [bodyExcerpt, contact],
  );
}

/**
 * 신고 1건에 의한 자동 비공개 — `hidden_auto` (02 §4 · 04 §3).
 *
 * **상태 전이만 한다.** `auto_hide_exempt`를 볼지 말지는 부르는 쪽이 정한다 —
 * 일반 신고는 exempt가 막고, 심각 카테고리(`doxx`·`sexual`·`selfharm`)는 exempt를
 * 뚫는다 (D-025 · 04 §3). 그 판정에는 신고 사유가 필요한데 그건 신고 표면이 가진
 * 값이다. 여기서 신고 테이블을 읽기 시작하면 이 파일이 신고 로직을 갖게 된다.
 */
export async function autoHide(letterId: string): Promise<boolean> {
  const { rowCount } = await query(
    `update letters
        set status = 'hidden_auto',
            status_changed_at = now()
      where id = $1 and status = 'published'`,
    [letterId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 같은 자동 비공개인데 **`auto_hide_exempt`가 막는다** — 일반 신고 넷
 * (`targeting`·`impersonation`·`spam`·`other`)이 쓴다 (04 §3 · D-025).
 *
 * 사유를 여기서 보지 않는 것은 위 `autoHide`와 같다. 어느 함수를 부를지는 신고 표면이
 * 사유로 정하고, 이 파일은 **exempt를 볼 것인가**만 안다. 조건을 SQL에 두는 이유는
 * 읽고-판단하고-쓰는 사이에 exempt가 바뀌는 창을 없애기 위해서다.
 */
export async function autoHideUnlessExempt(letterId: string): Promise<boolean> {
  const { rowCount } = await query(
    `update letters
        set status = 'hidden_auto',
            status_changed_at = now()
      where id = $1 and status = 'published' and auto_hide_exempt = false`,
    [letterId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 복귀 — `published` + `auto_hide_exempt = true` (04 §3 · 05-api §4 · 07 §2 원칙 2).
 *
 * 신고 `dismiss`와 이의 제기 `restore`가 같은 전이를 쓴다. 한 번 사람이 들여다보고
 * 되살린 편지가 같은 신고로 또 내려가면 이의 제기가 무의미해진다 (S-8).
 *
 * **이미 `published`인 편지에도 exempt를 세운다.** exempt 편지에 들어온 일반 신고는
 * 편지를 내리지 않고 큐에만 쌓이는데(D-025), 그 신고를 `dismiss`할 때 여기 오기 때문이다.
 * 그때 상태는 바뀌지 않았으므로 `status_changed_at`도 건드리지 않는다 — 바뀌지 않은
 * 것을 바뀌었다고 적지 않는다.
 *
 * `deleted_by_author`는 대상이 아니다. 작성자가 지운 편지를 운영자 판정이 되살리는 길은
 * 04 §3의 상태 기계에 없다.
 */
export async function restoreToPublishedTx(
  client: PoolClient,
  letterId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update letters
        set status = 'published',
            auto_hide_exempt = true,
            status_changed_at = case
              when status = 'published' then status_changed_at else now()
            end
      where id = $1
        and status in ('published', 'hidden_auto', 'hidden_admin')`,
    [letterId],
  );
  return (rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────
// 격리 — D-028 (migrations/0005)
// ─────────────────────────────────────────────────────────────
//
// **심각 카테고리 신고로 자동 비공개된 편지만** 여기 온다. 대상 범위의 근거는
// 마이그레이션 주석에 있다.
//
// 이동이지 복사가 아니다. `letters`의 본문 계열을 비우고 `quarantine.letter_content`에
// 봉인해 넣는다. 절반만 하면 `quarantined_is_moved` 제약이 거부한다.

/** 격리된 본문. `letters`에서 빠져나온 그대로이고, 복원하면 이 값이 되돌아간다. */
export interface QuarantinedContent {
  body: string;
  hint: string | null;
  question: string | null;
  /** base64. bytea를 JSON에 담기 위한 표현이고 값 자체는 HMAC 그대로다. */
  answerHmac: string | null;
  answerVariantHmacs: string[];
}

interface ContentRow {
  body: string;
  hint: string | null;
  question: string | null;
  answer_hmac: Buffer | null;
  answer_variant_hmacs: Buffer[];
}

function quarantineKey(): string {
  return requireEnv("QUARANTINE_KEY");
}

/**
 * 본문을 격리로 옮긴다. 이미 격리 중이면 아무것도 하지 않고 `false`.
 *
 * 부르는 쪽의 트랜잭션 안에서 돈다 — 신고 접수·자동 비공개·격리가 갈라지면 "내려갔는데
 * 본문은 그대로인" 중간 상태가 남는다. 그게 정확히 D-028이 없애려는 상태다.
 */
export async function quarantineTx(
  client: PoolClient,
  letterId: string,
): Promise<boolean> {
  const { rows } = await client.query<ContentRow>(
    `select body, hint, question, answer_hmac, answer_variant_hmacs
       from letters
      where id = $1 and quarantined_at is null and body is not null
      for update`,
    [letterId],
  );
  const row = rows[0];
  if (!row) return false;

  const content: QuarantinedContent = {
    body: row.body,
    hint: row.hint,
    question: row.question,
    answerHmac: row.answer_hmac ? row.answer_hmac.toString("base64") : null,
    answerVariantHmacs: row.answer_variant_hmacs.map((buffer) =>
      buffer.toString("base64"),
    ),
  };
  const sealed = seal(quarantineKey(), JSON.stringify(content));

  await client.query(
    `insert into quarantine.letter_content
       (letter_id, content_ciphertext, content_iv, content_tag)
     values ($1, $2, $3, $4)`,
    [letterId, sealed.ciphertext, sealed.iv, sealed.tag],
  );

  // 옮긴 뒤에 비운다. 순서가 반대면 봉인에 실패했을 때 본문이 사라진다.
  await client.query(
    `update letters
        set quarantined_at = now(),
            body = null,
            hint = null,
            question = null,
            answer_hmac = null,
            answer_variant_hmacs = '{}'
      where id = $1`,
    [letterId],
  );
  return true;
}

/**
 * 심각 카테고리 신고의 자동 비공개 — **비공개와 격리를 한 트랜잭션에서** (D-025 · D-028).
 *
 * `autoHide`와 갈라 두지 않는 이유: 둘 사이에 실패하면 "내려갔는데 본문은 `letters`에
 * 그대로"가 되고, 그게 정확히 D-028이 없애려는 상태다.
 *
 * ── 키가 없으면 격리를 건너뛴다 ──────────────────────────────
 * **비공개는 반드시 성공해야 한다.** S-5의 "무조건 차단"이 격리보다 우선한다 —
 * `QUARANTINE_KEY`가 없다고 신고 접수가 실패하면 심각 콘텐츠가 그대로 떠 있게 된다.
 * 격리 실패는 D-028 이전 상태(본문이 `letters`에 남음)일 뿐 유실이 아니다.
 *
 * 대신 조용히 넘어가지 않는다. 배포 환경에서 키가 비면 격리가 통째로 안 도는 것이라
 * 출시 게이트가 따로 확인한다.
 */
export async function autoHideAndQuarantine(letterId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `update letters
          set status = 'hidden_auto',
              status_changed_at = now()
        where id = $1 and status = 'published'`,
      [letterId],
    );
    if ((rowCount ?? 0) === 0) return false;

    if (env.QUARANTINE_KEY === undefined) {
      console.error(
        "[quarantine] QUARANTINE_KEY가 없어 격리를 건너뛴다. 비공개는 적용됐다.",
      );
      return true;
    }
    await quarantineTx(client, letterId);
    return true;
  });
}

/**
 * 격리된 본문을 읽는다 — **운영자 판정에만.**
 *
 * 판정하려면 본문을 봐야 한다(07 §2). 접속기록과 달리 여기는 복호가 목적이고, 그래서
 * 키가 다르다 (`QUARANTINE_KEY` · crypto.ts `seal` 주석).
 */
export async function readQuarantinedContent(
  letterId: string,
): Promise<QuarantinedContent | null> {
  const { rows } = await query<{
    content_ciphertext: Buffer;
    content_iv: Buffer;
    content_tag: Buffer;
  }>(
    `select content_ciphertext, content_iv, content_tag
       from quarantine.letter_content where letter_id = $1`,
    [letterId],
  );
  const row = rows[0];
  if (!row) return null;

  return JSON.parse(
    unseal(quarantineKey(), {
      ciphertext: row.content_ciphertext,
      iv: row.content_iv,
      tag: row.content_tag,
    }),
  ) as QuarantinedContent;
}

/**
 * 종결 ② 복원 — 본문을 `letters`로 되돌리고 격리 행을 지운다.
 *
 * 상태 전이는 하지 않는다. 그건 `restoreToPublishedTx`의 몫이고, 부르는 쪽이 둘을
 * 같은 트랜잭션에서 부른다 — 본문만 돌아오고 상태가 안 바뀌면 피드에 안 뜨는 편지가
 * 되고, 반대면 본문 없는 published가 된다.
 */
export async function releaseQuarantineTx(
  client: PoolClient,
  letterId: string,
): Promise<boolean> {
  const { rows } = await client.query<{
    content_ciphertext: Buffer;
    content_iv: Buffer;
    content_tag: Buffer;
  }>(
    `select content_ciphertext, content_iv, content_tag
       from quarantine.letter_content where letter_id = $1 for update`,
    [letterId],
  );
  const row = rows[0];
  if (!row) return false;

  const content = JSON.parse(
    unseal(quarantineKey(), {
      ciphertext: row.content_ciphertext,
      iv: row.content_iv,
      tag: row.content_tag,
    }),
  ) as QuarantinedContent;

  await client.query(
    `update letters
        set quarantined_at = null,
            body = $2,
            hint = $3,
            question = $4,
            answer_hmac = $5,
            answer_variant_hmacs = $6
      where id = $1`,
    [
      letterId,
      content.body,
      content.hint,
      content.question,
      content.answerHmac ? Buffer.from(content.answerHmac, "base64") : null,
      content.answerVariantHmacs.map((value) => Buffer.from(value, "base64")),
    ],
  );
  await client.query(
    "delete from quarantine.letter_content where letter_id = $1",
    [letterId],
  );
  return true;
}

/**
 * 종결 ① 완전 삭제 — 격리된 본문을 파기한다. 편지 행은 `hidden_*` tombstone으로 남는다.
 *
 * `letters.quarantined_at`은 그대로 둔다. 지우면 `body_present_unless_deleted`가
 * "본문 없는 published/hidden"을 거부해 행이 깨진다. **격리됐었고 파기됐다**는 사실이
 * 그 표식으로 남는 것이 맞기도 하다.
 */
export async function purgeQuarantineTx(
  client: PoolClient,
  letterId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `delete from quarantine.letter_content
      where letter_id = $1 and legal_hold = false`,
    [letterId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 종결 ③ `legal_hold` — 적법한 영장·법원 명령·구체적 보존 요청이 있을 때만.
 *
 * 세우면 30일 시한이 멈춘다 (migrations/0005의 부분 인덱스가 대상에서 뺀다).
 * **운영자가 임의로 세우지 않는다.** 07 §6이 "공문이나 영장을 확인하기 전에는"이라고
 * 정한 것과 같은 문턱이다.
 */
export async function setLegalHold(
  letterId: string,
  held: boolean,
): Promise<boolean> {
  const { rowCount } = await query(
    "update quarantine.letter_content set legal_hold = $2 where letter_id = $1",
    [letterId, held],
  );
  return (rowCount ?? 0) > 0;
}
