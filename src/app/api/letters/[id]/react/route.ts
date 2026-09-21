// `POST /api/letters/:id/react` — 05-api §2 「나머지」 · 04 §2 `reactions`.
//
// ── 중복은 애플리케이션이 세지 않는다 ────────────────────────
// `reactions`의 PK가 `(letter_id, kind, fp_hash)`라(04 §2) 같은 사람이 같은 편지에 같은
// 반응을 두 번 남기는 것을 **스키마가 막는다.** 여기서 "이미 눌렀나"를 다시 조회하면
// 두 벌의 판정이 생기고, 동시 요청에서 둘이 갈린다. `on conflict do nothing` 하나로 끝난다.
//
// ── 레이트리밋을 붙이지 않는다 ───────────────────────────────
// 05-api §5의 대상 표에 이 경로가 없기 때문만이 아니다. **PK 제약 자체가 이미 상한이다** —
// 한 fp가 한 편지에 만들 수 있는 행은 kind 4종이 전부라 최대 4개다. 레이트리밋이 막으려는
// "무한 반복 삽입"이 구조적으로 불가능하므로, 05 §5의 "없는 걸 만들기 전에 있는 걸 센다"를
// 넘어 **셀 필요조차 없다.** 나중에 여기에 카운터를 붙이고 싶어질 자리라 적어 둔다.
//
// ── 킬 스위치도 보지 않는다 ──────────────────────────────────
// 05-api §6의 표대로 `public_read_enabled`는 읽기 표면을, `writing_enabled`는 편지 작성만
// 막는다. 대신 **`status='published'`가 아니면 404**는 반드시 지킨다 — 비공개 편지에
// 반응이 붙는 것을 막는 유일한 장치가 그 검사다. 403이 아니라 404인 이유는 403이 편지의
// 존재를 확인해주기 때문이다 (05-api §2 「상태별 표면 응답」).
//
// 등급 `medium` 편지는 반응을 받는다. 링크 접근은 허용이고 피드 노출만 제외다 (04 §3).
//
// ── 왜 204가 아니라 200 + 개수인가 (D-007) ───────────────────
// 05-api §2에 응답 형태가 없어 코디네이터 승인을 받아 정했다. 204로 두면 화면이 개수를
// 낙관적으로 +1 해야 하는데, **중복 반응은 PK가 막아 실제 행이 생기지 않는다.** 그러면
// 화면에만 존재하는 개수가 남고, 그건 D-007이 금지한 "존재하지 않는 신호"다. 하필 이
// 숫자는 사용자가 "이 편지가 얼마나 공감받았나"로 읽는 값이다. 방금 DB에서 센 값을 그대로
// 돌려주면 화면의 숫자가 항상 진짜 값이다. 문서 쪽 보강은 05-api §2의 같은 줄이다.

import { z } from "zod";
import { REACTION_KINDS, type ReactionCounts } from "@/components/reactions/kinds";
import { query } from "@/lib/db";
import { invalidRequest, notFound } from "@/lib/errors";
import { fingerprint } from "@/lib/fingerprint";

interface Context {
  params: Promise<{ id: string }>;
}

const schema = z.object({
  kind: z.enum(REACTION_KINDS),
});

/** 반응을 받을 수 있는 편지인가. 본문은 읽지 않는다 — 판정에 필요 없다. */
async function isPublished(letterId: string): Promise<boolean> {
  const { rowCount } = await query(
    // D-035 — 판정이 끝난 편지만 읽힌다. `classifier_state`가 'ok'가 아니면 보류 중이다.
    "select 1 from letters where id = $1 and status = 'published' and classifier_state = 'ok'",
    [letterId],
  );
  return (rowCount ?? 0) > 0;
}

/** 편지 하나의 kind별 개수. 0인 kind는 행이 없으므로 키도 없다. */
async function countReactions(letterId: string): Promise<ReactionCounts> {
  const { rows } = await query<{ kind: string; count: number }>(
    `select kind, count(*)::int as count
       from reactions
      where letter_id = $1
      group by kind`,
    [letterId],
  );
  const counts: ReactionCounts = {};
  for (const row of rows) counts[row.kind] = row.count;
  return counts;
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest("반응을 선택해 주세요.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return invalidRequest("반응을 선택해 주세요.");

  if (!(await isPublished(id))) return notFound();

  await query(
    `insert into reactions (letter_id, kind, fp_hash)
     values ($1, $2, $3)
     on conflict (letter_id, kind, fp_hash) do nothing`,
    [id, parsed.data.kind, fingerprint(request.headers)],
  );

  return Response.json({ reactions: await countReactions(id) });
}
