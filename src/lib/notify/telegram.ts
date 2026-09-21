// 운영자 알림 — 텔레그램 봇 (09 §3 · D-019).
//
// 심각 카테고리 신고(신상 · 미성년 · 자해)가 접수되면 즉시 발송한다. 트리거 집합은
// `src/lib/reports/reasons.ts`의 `SEVERE_REPORT_REASONS` 하나뿐이다 — 자동 비공개가
// exempt를 뚫는 집합과 **같은 상수**를 읽는다 (D-025).
//
// 이메일이 아니라 봇을 쓰는 이유: 이건 **새벽에 깨워야 하는 알림**이다 (07 §1). 메일은
// 조용히 쌓이고 아침에 읽힌다. 일반 신고는 알리지 않는다 — 알림을 늘리면 심각 알림이
// 묻힌다 (09 §3).
//
// ── 메시지에 편지 본문을 넣지 않는다 ────────────────────────
// 텔레그램은 서드파티 클라우드에 남고, 심각 카테고리 신고의 본문은 남기면 안 되는 것일
// 가능성이 가장 높은 콘텐츠다 (L-007). 판정은 `/admin`에서 한다.
//
// ── 편지 ID도 사유도 넣지 않는다 (D-034 6) ──────────────────
// 텔레그램 발송은 **개인정보의 국외 이전**이다. 편지 ID는 공개 URL의 일부라(04 §1-1)
// 알림을 보는 쪽이 편지를 그대로 열 수 있고, 사유 문구(`신상 노출`·`성적 내용`)는 그
// 편지에 무엇이 적혀 있는지를 말한다. 둘 다 국외로 나가지 않게 한다.
//
// 대신 나가는 것은 **무작위 사건 번호**(`reports.incident_id` · migrations/0007)와
// **고정형 위험 등급** 둘뿐이다. 사건 번호는 신고 행에 함께 저장돼 있어 운영자가
// `/admin/queue`에서 대조한다 — 그 대조가 성립해야 알림이 일할 수 있는 알림이 된다.
//
// **그래서 메시지를 만드는 함수가 받는 값이 사건 번호 하나뿐이다.** 본문도 편지 ID도
// 사유도 담고 싶어도 담을 수 없게 만드는 것이 주석보다 강한 방어다. 안전 테스트 #21이
// 이걸 고정한다.

import { query } from "../db";
import { env } from "../env";
import { record } from "../events";
import type { SevereReportReason } from "../reports/reasons";

/**
 * 알림 한 건. **밖으로 나가는 값은 여기 없다** — 신고 행 번호와 계측용 사유뿐이다.
 *
 * `reason`은 `admin_alert_sent { reason }`(06 §3 · 09 §5)에만 쓴다. 이건 우리 DB에
 * 남는 이벤트라 D-034의 국외 이전과 무관하다. 메시지 쪽으로는 전달되지 않는다.
 */
export interface SevereReportAlert {
  reason: SevereReportReason;
  reportId: number;
}

/**
 * D-034의 「고정형 위험 등급」. **값이 하나뿐인 것이 정상이다.**
 *
 * 이 알림은 심각 카테고리(`doxx`·`sexual`·`selfharm`)에서만 나가므로 등급은 언제나
 * 같다. 셋을 서로 다른 등급으로 나누면 등급이 사유의 다른 이름이 되고, D-034가 막으려던
 * 이전이 이름만 바꿔 그대로 일어난다.
 */
export const SEVERE_ALERT_RISK_LEVEL = "심각";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/**
 * 외부 호출 타임아웃. **가설값이다** — 문서에 없다.
 *
 * 알림은 신고 접수 응답 밖에서 도는 비동기 작업이라 사용자를 기다리게 하지 않지만,
 * 무기한 매달리면 서버리스 인스턴스가 그만큼 살아 있는다.
 */
const TIMEOUT_MS = 5_000;

/**
 * 서버에서 발생한 이벤트의 `session_id`.
 *
 * 06 §2의 `session_id`는 **익명 랜덤 쿠키**인데 이 이벤트에는 요청도 쿠키도 없다
 * (신고 접수 뒤 서버가 혼자 보낸다). 사용자 세션인 척하는 랜덤값을 만들면 세션 수가
 * 부풀고, 그건 없는 신호를 만드는 것과 같다 (D-007). 고정값 하나로 "사용자가 아니다"를
 * 드러낸다.
 */
const SERVER_SESSION = "server";

/** 둘 다 있어야 보낸다. 하나라도 없으면 `null` — 부르는 쪽이 조용히 건너뛴다. */
export function telegramConfig(): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/**
 * 09 §3의 예시 그대로. **사건 번호 · 고정형 등급 · `/admin/queue` 링크 셋뿐이다.**
 *
 * ```
 * 🚨 심각 신고
 * 등급: 심각
 * 사건: 4f8a1c...
 * → https://<도메인>/admin/queue
 * ```
 *
 * 인자가 `string` 하나인 것이 D-034의 방어다 — 신고 행도 편지도 받지 않으므로 여기서
 * 사유나 편지 ID를 꺼내 붙일 방법이 없다.
 */
export function severeReportText(incidentId: string): string {
  return [
    "🚨 심각 신고",
    `등급: ${SEVERE_ALERT_RISK_LEVEL}`,
    `사건: ${incidentId}`,
    `→ ${env.NEXT_PUBLIC_SITE_URL}/admin/queue`,
  ].join("\n");
}

/**
 * 신고 행에 저장된 무작위 사건 번호 (migrations/0007). 없으면 `null`.
 *
 * 신고 행 삽입과 같은 트랜잭션에서 DB 기본값으로 만들어지므로, 방금 접수된 신고에
 * 대해서는 언제나 있다. `null`은 신고가 사라졌다는 뜻이다.
 */
async function incidentIdOf(reportId: number): Promise<string | null> {
  const { rows } = await query<{ incident_id: string }>(
    "select incident_id from reports where id = $1",
    [reportId],
  );
  return rows[0]?.incident_id ?? null;
}

/**
 * 실제 발송. 설정을 **인자로 받는다** — 설정 해석(`telegramConfig`)과 발송을 나눠야
 * `notifySevereReport`가 "설정 없으면 건너뛴다"를 혼자 판단할 수 있고, 발송 자체는
 * 설정과 무관하게 테스트할 수 있다.
 *
 * 실패하면 던진다. 삼키는 것은 부르는 쪽의 일이다 (아래).
 */
export async function sendSevereReportAlert(
  incidentId: string,
  config: TelegramConfig,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: severeReportText(incidentId),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`텔레그램 발송 실패: ${response.status}`);
  }
}

/**
 * 신고 표면이 부르는 함수. **던지지 않는다.**
 *
 * 발송 실패가 신고 접수를 막으면 안 된다 (09 §2 「실패하면」과 같은 원칙). 접수는 이미
 * 끝났고 편지도 이미 내려갔다 — 알림이 안 갔다고 그걸 되돌릴 이유가 없다. 실패는
 * 로그로만 남긴다.
 *
 * 토큰·챗 ID가 없으면 **조용히 건너뛰고 경고 로그**. 로컬 개발과 테스트가 정상 경로다.
 */
export async function notifySevereReport(
  alert: SevereReportAlert,
): Promise<void> {
  const config = telegramConfig();
  if (!config) {
    console.warn(
      "[telegram] TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID가 없어 심각 신고 알림을 건너뛴다.",
    );
    return;
  }

  // D-034 — 메시지에 실을 값은 이것 하나다. 못 읽으면 **보내지 않는다**: 사건 번호가
  // 없는 알림은 대조할 수 없고, 대체할 값(편지 ID·사유)은 D-034가 금지한 바로 그 값이다.
  // 여기까지 왔다는 것은 신고 행이 방금 들어갔다는 뜻이라 정상 경로에서는 일어나지 않는다.
  let incidentId: string | null;
  try {
    incidentId = await incidentIdOf(alert.reportId);
  } catch (error) {
    console.error("[telegram] 사건 번호 조회 실패", error);
    return;
  }
  if (incidentId === null) {
    console.error(
      `[telegram] 신고 ${alert.reportId}의 사건 번호가 없어 알림을 보내지 않는다.`,
    );
    return;
  }

  try {
    await sendSevereReportAlert(incidentId, config);
  } catch (error) {
    console.error("[telegram] 심각 신고 알림 발송 실패", error);
    return;
  }

  // 09 §5 · 06 §3. 서버에서 관측되는 이벤트라 여기서 직접 남긴다 (클라이언트 이벤트
  // 경로를 기다릴 이유가 없다). props에 편지 ID는 담지 않는다 (06 §2).
  //
  // try를 나눠 두는 이유: 발송과 기록은 실패 원인이 다르다. 한 블록에 두면 계측 삽입이
  // 실패했을 때 로그가 "발송 실패"라고 말하게 되는데, 새벽에 그 로그를 읽는 사람에게
  // 그건 틀린 정보다.
  try {
    await record("admin_alert_sent", SERVER_SESSION, { reason: alert.reason });
  } catch (error) {
    console.error("[telegram] admin_alert_sent 기록 실패", error);
  }
}
