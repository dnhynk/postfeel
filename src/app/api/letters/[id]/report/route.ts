// `POST /api/letters/:id/report` (05-api §2 「나머지」 · 02 §4 · D-025).
//
// ── 이 표면의 규칙 하나 ─────────────────────────────────────
//   > **신고 1건이 들어오면 사람 판단 없이 즉시 비공개 처리한다. 판정은 그 다음에 한다.**
//   > (02 §4)
//
// 1인 운영에서 "신고 접수 → 운영자 확인 → 조치"는 반드시 지연되고, 지연되는 동안
// 콘텐츠는 계속 노출된다. 순서를 뒤집어 **비공개를 기본값**으로 만든다. 되돌릴 수 있는
// 조치라 오작동 비용이 낮다 (S-8).
//
// ── 킬 스위치를 보지 않는다 ─────────────────────────────────
// 05-api §6의 표에 이 경로가 없다. `public_read_enabled = false`로 읽기를 끈 상태에서도
// 신고는 접수돼야 한다 — 사고 대응 중에 들어오는 신고가 가장 중요한 신고다.

import { z } from "zod";
import { ensureSession, withSession } from "@/lib/analytics/session";
import { invalidRequest, notFound, rateLimited } from "@/lib/errors";
import { record } from "@/lib/events";
import { fingerprint } from "@/lib/fingerprint";
import {
  autoHideAndQuarantine,
  autoHideUnlessExempt,
} from "@/lib/letters/deletion";
import { notifyAutoHidden } from "@/lib/notify/email";
import { scheduleAfterResponse } from "@/lib/notify/schedule";
import { notifySevereReport } from "@/lib/notify/telegram";
import {
  findReportTarget,
  insertReport,
  reportRetryAfterSeconds,
} from "@/lib/reports/create";
import { fillReportDraft } from "@/lib/reports/draft";
import { REPORT_REASONS, isSevereReason } from "@/lib/reports/reasons";
import { countReportsByReporter, exceeded, LIMITS } from "@/lib/ratelimit";

interface Context {
  params: Promise<{ id: string }>;
}

const schema = z.object({
  reason: z.enum(REPORT_REASONS),
});

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { id } = await context.params;

  // 익명 세션 쿠키. `report_submitted`(06 §3)가 서버 이벤트라 여기서 세운다.
  const session = ensureSession(request.headers);
  const respond = (response: Response) => withSession(response, session);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return respond(invalidRequest("요청 형식이 올바르지 않습니다."));
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return respond(invalidRequest("신고 사유를 선택해 주세요."));
  }
  const { reason } = parsed.data;

  const letter = await findReportTarget(id);
  // 05-api §2: 403이 아니라 404다 — 403은 편지의 존재를 확인해준다.
  if (!letter || letter.status === "deleted_by_author") return respond(notFound());

  // 05-api §5: 신고는 20 / 24시간 (fp). 카운터 테이블 없이 `reports.reporter_fp_hash`로
  // 센다 — 없는 걸 만들기 전에 있는 걸 센다.
  const reporterFpHash = fingerprint(request.headers);
  const recent = await countReportsByReporter(
    reporterFpHash,
    LIMITS.reportPerDay.windowMs,
  );
  if (exceeded(recent, LIMITS.reportPerDay)) {
    return respond(rateLimited(await reportRetryAfterSeconds(reporterFpHash)));
  }

  // 신고 행이 먼저다. 이게 판정의 근거이고 비공개는 거기서 파생된 조치라, 둘 중 하나만
  // 성공한다면 "근거는 있는데 안 내려간 편지"가 낫다 — 그건 큐에 미판정 신고로 뜬다.
  // 반대 순서로 실패하면 이유를 모르는 비공개 편지가 남는다.
  const reportId = await insertReport(letter.id, reason, reporterFpHash);

  // D-025 — 이 분기가 이 표면의 핵심이다.
  //   · 심각 카테고리(`doxx`·`sexual`·`selfharm`)는 `auto_hide_exempt`를 **뚫는다.**
  //     S-5의 "무조건 차단"이 S-8의 반복 신고 방어보다 우선한다
  //   · 나머지 넷은 exempt가 막는다. 신고는 큐에만 쌓인다
  // 집합은 `SEVERE_REPORT_REASONS` 한 곳에 있고 텔레그램 알림도 같은 상수를 읽는다.
  let hidden: boolean;
  if (isSevereReason(reason)) {
    // D-028 — 비공개와 **격리**를 한 트랜잭션에서. 심각 카테고리만 본문을 암호화
    // 영역으로 옮긴다. 일반 신고 넷은 대부분 dismiss되므로 옮기지 않는다.
    hidden = await autoHideAndQuarantine(letter.id);
    // 09 §3. **await 하지 않는다** — 발송 실패가 신고 접수를 막으면 안 된다. 실패는
    // notifySevereReport가 로그로만 남기고 던지지 않는다. 자동 비공개와 같은 분기에
    // 두는 것이 "두 집합이 같다"를 코드로 유지하는 방법이다.
    //
    // **다섯 곳 중 여기가 가장 조용하게 깨진다.** 텔레그램은 심각 신고를 새벽에 알리는
    // 유일한 수단이라(09 §3), 감싸지 않아 실행이 통째로 사라지면 아무 로그도 없이
    // 운영자가 자는 동안 S-5 콘텐츠가 떠 있는다. 근거는 notify/schedule.ts에 있다.
    //
    // **편지 ID를 넘기지 않는다** (D-034 6). 넘기는 것은 신고 행 번호뿐이고, 밖으로
    // 나가는 값은 그 행에 붙어 있는 무작위 사건 번호다 (migrations/0007). 운영자는
    // 그 번호로 `/admin/queue`에서 이 신고를 찾는다.
    scheduleAfterResponse("severe_report", () =>
      notifySevereReport({ reason, reportId }),
    );
  } else {
    hidden = await autoHideUnlessExempt(letter.id);
  }

  // 09 §2 #3 — 이메일을 남긴 작성자에게 "편지가 비공개로 바뀌었습니다". **상태가 실제로
  // 바뀐 경우에만**이다: 이미 내려가 있는 편지의 두 번째 신고나 exempt가 막은 신고는
  // 자동 비공개가 아니라 큐에 쌓이는 신고일 뿐이라 작성자에게 알릴 사건이 없다.
  // 텔레그램과 같은 이유로 await 하지 않는다 (09 §2 발송은 비동기). 감싸는 이유도 같다.
  if (hidden) {
    scheduleAfterResponse("auto_hidden", () => notifyAutoHidden(letter.id));
  }

  // `report_submitted { reason, relationship }` (06 §3). **서버 이벤트다** — 위조되면
  // 주간 지표 #5(신고율)가 거짓이 되고, 그 지표는 위협 모델 §7의 전환 트리거(3% 초과)
  // 판정에 그대로 쓰인다. **편지 ID는 담지 않는다** (06 §2). 신고 행이 이미 들어간 뒤라
  // 기록이 실패해도 접수는 유효하다 — 계측 하나로 신고를 되돌리지 않는다.
  //
  // 자동 비공개 여부(`hidden`)는 담지 않는다. 06 §3의 props 열이 둘뿐이고, 주간 지표
  // #5는 접수된 신고를 세지 내려간 편지를 세지 않는다.
  try {
    await record("report_submitted", session.sessionId, {
      reason,
      relationship: letter.relationship,
    });
  } catch {
    // 신고 접수를 계측 실패로 깨지 않는다.
  }

  // 07 §2 「큐에는 분류기가 붙여둔 초안이 있다」. 분류기가 편지를 한 번 더 읽고 판정표의
  // 어느 행에 걸리는지 · 근거 한 줄 · 신뢰도를 `admin_actions`에 남긴다
  // (`src/lib/reports/draft.ts`). 초안과 최종 판정이 같은 `target_id`(신고 ID)로 묶여야
  // 07 §7 주간 점검 5번의 불일치율을 셀 수 있다.
  //
  // **응답 뒤에 돌린다.** 제출 경로가 아니라 지연이 무관하고(07 §2), 위 두 발송과 같은
  // 이유로 `after()`가 아니면 조용히 유실된다. 초안은 **운영자 보조이지 안전 장치가
  // 아니라서**, 실패해도 여기까지 끝난 신고 접수 · 자동 비공개 · 텔레그램은 그대로다 —
  // `fillReportDraft`가 던지지 않는 것으로 그 성질을 지킨다.
  //
  // 비용 상한은 부르는 쪽에서 보지 않는다. 05-api §1의 끄는 순서(표기 변형 → 큐 초안 →
  // 등급 판정)는 `budget.ts`에 이미 있고, 상한에 닿으면 `draftReportVerdict`가 호출
  // 없이 `null`을 돌려준다.
  scheduleAfterResponse("report_draft", () =>
    fillReportDraft(reportId, letter.id, reason),
  );

  return respond(new Response(null, { status: 204 }));
}
