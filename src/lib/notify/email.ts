// 사용자 메일 — Resend (09 §2 · D-019).
//
// ── 이 파일이 지키는 규칙 넷 ────────────────────────────────
//
// 1. **본문을 담지 않는다.** 이 파일은 편지 본문을 조회하지 않고, 템플릿도 본문을 받지
//    않는다 (templates/index.ts). 안전 테스트 #20.
// 2. **해지 링크가 모든 메일에 붙는다.** 본문을 만드는 길이 templates/layout.ts의
//    `mail()` 하나뿐이고 그 함수는 해지 URL을 필수 인자로 받는다 (09 §1).
// 3. **발송은 비동기다.** 부르는 쪽은 `void`로 던져두고 응답을 먼저 돌려준다. 메일이 안
//    나가도 사용자 흐름이 막히지 않는다 — 이메일은 D-005에서 부가 기능으로 정의됐다.
//    그래서 이 파일의 `notify*` 함수는 **던지지 않는다.** 던지면 `void` 호출자에게
//    처리되지 않은 거부가 된다.
// 4. **편지당 1회는 DB가 지킨다.** 2번·4번 메일의 빈도는 코드의 조건문이 아니라
//    `author_contacts.first_unlock_notified_at`·`recipient_yes_notified_at`을 조건에 건
//    UPDATE 한 방이 정한다 (아래 「선점」). 안전 테스트 #19 · #24.
//
// ── 선점(claim)한 뒤에 보낸다 ───────────────────────────────
// "보내고 나서 표시"로 만들면 두 요청이 동시에 들어올 때 둘 다 보낸다. 잠긴 편지는
// 제3자도 열고(09 §2), 인기 있는 편지 하나가 작성자 메일함을 도배하는 것이 이 순서
// 하나로 갈린다. 반대로 표시한 뒤 발송이 실패하면 그 편지의 알림은 영영 안 나가는데,
// 09 §2가 이미 "재시도 1회, 그래도 실패하면 로그만 남기고 포기"로 정한 쪽이다.

import { query } from "../db";
import { env } from "../env";
import { record } from "../events";
import {
  autoHiddenMail,
  firstUnlockMail,
  manageLinkMail,
  recipientYesMail,
} from "./templates";

/** 09 §5의 `kind`. 계측 props가 이 값이고, 해지 링크도 이 값을 실어 나른다. */
export const EMAIL_KINDS = [
  "manage_link",
  "first_unlock",
  "auto_hidden",
  "recipient_yes",
] as const;

export type EmailKind = (typeof EMAIL_KINDS)[number];

export function isEmailKind(value: unknown): value is EmailKind {
  return (
    typeof value === "string" &&
    (EMAIL_KINDS as readonly string[]).includes(value)
  );
}

/**
 * 발신 주소. 도메인은 D-022로 확정된 `postfeel.kr`이고 **로컬파트는 가설값이다** —
 * 문서에 없다.
 *
 * **회신 불가 주소(`no-reply@`)를 쓰지 않는다.** 09 §1이 상정한 상황이 "요청한 적 없는
 * 사람이 메일을 받는 것"인데, 그 사람이 회신조차 못 하면 남는 경로가 해지 링크뿐이다.
 * 해지는 발송을 멈출 뿐 "이게 뭐냐"는 물음에는 답하지 못한다. 회신함을 실제로 누가
 * 보는가는 도메인·Resend 설정 시점에 정한다.
 */
export const MAIL_FROM = "PostFeel <notify@postfeel.kr>";

/**
 * 외부 호출 타임아웃. **가설값이다** — 문서에 없다 (telegram.ts와 같은 값).
 *
 * 발송은 사용자 응답 밖에서 도는 비동기 작업이라 사용자를 기다리게 하지 않지만,
 * 무기한 매달리면 서버리스 인스턴스가 그만큼 살아 있는다.
 */
const TIMEOUT_MS = 5_000;

/** 09 §2 「실패하면」 — 재시도 1회. 총 2회 시도한다. */
const ATTEMPTS = 2;

/**
 * 서버가 혼자 관측한 이벤트의 `session_id` (telegram.ts의 같은 상수와 같은 이유).
 *
 * 발송은 요청 밖에서 돈다 — 쿠키도 세션도 없다. 사용자 세션인 척하는 랜덤값을 만들면
 * 세션 수가 부풀고, 그건 없는 신호를 만드는 것과 같다 (D-007).
 */
const SERVER_SESSION = "server";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * 실제 발송 한 번. 실패하면 **던진다** — 삼키는 것은 `deliver`의 일이다.
 *
 * 설정을 인자로 받는 이유는 telegram.ts와 같다: 설정 해석과 발송을 나눠야 "설정이 없으면
 * 건너뛴다"를 부르는 쪽이 혼자 판단할 수 있고, 발송 자체는 설정과 무관하게 테스트할 수
 * 있다.
 */
export type MailSender = (mail: OutgoingMail) => Promise<void>;

export async function sendViaResend(
  mail: OutgoingMail,
  apiKey: string,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Resend 발송 실패: ${response.status}`);
  }
}

/**
 * 키가 없으면 `null`. 부르는 쪽이 조용히 건너뛴다 — **로컬 개발과 테스트가 정상 경로다**
 * (`.env.test`의 `RESEND_API_KEY`는 비어 있다).
 */
export function resendSender(): MailSender | null {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return null;
  return (mail) => sendViaResend(mail, apiKey);
}

/**
 * 재시도 1회 + 계측 + 삼키기 (09 §2 · §5). **던지지 않는다.**
 *
 * `sender`를 인자로 받는 것은 `ratelimit.ts`의 `SqlRunner`와 같은 이유다 — 주입 지점을
 * 하나 두어 테스트가 "무엇이 나갔는가"를 관측할 수 있게 한다. 실제 발송은 여기가 아니라
 * `resendSender()`가 만든 함수가 한다.
 */
export async function deliver(
  kind: EmailKind,
  mail: OutgoingMail,
  sender: MailSender | null = resendSender(),
): Promise<void> {
  if (!sender) {
    console.warn(`[email] RESEND_API_KEY가 없어 ${kind} 메일을 건너뛴다.`);
    return;
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await sender(mail);
      await recordEmailEvent("email_sent", kind);
      return;
    } catch (error) {
      if (attempt < ATTEMPTS) continue;
      console.error(`[email] ${kind} 메일 발송 실패`, error);
      await recordEmailEvent("email_failed", kind);
    }
  }
}

/** 09 §5. 이메일 주소도 편지 ID도 담지 않는다 (06 §2). 기록 실패는 발송을 되돌리지 않는다. */
async function recordEmailEvent(
  name: "email_sent" | "email_failed",
  kind: EmailKind,
): Promise<void> {
  try {
    await record(name, SERVER_SESSION, { kind });
  } catch (error) {
    console.error(`[email] ${name} 기록 실패`, error);
  }
}

// ── 링크 ───────────────────────────────────────────────────

const site = (): string => env.NEXT_PUBLIC_SITE_URL;

/** 편지 링크 (03 화면 목록). 2번·4번 메일에 들어간다. */
export function letterUrl(letterId: string): string {
  return `${site()}/m/${letterId}`;
}

/** 관리 링크 (D-014 — URL에 편지 ID가 없다). 1번 메일에만 들어간다. */
export function manageUrl(manageToken: string): string {
  return `${site()}/manage/${manageToken}`;
}

/**
 * 해지 링크 (09 §1). **관리 토큰이 아니라 `unsubscribe_token`이다** — 관리 토큰은 편지를
 * 삭제할 수 있어서, 잘못 받은 사람의 손에 삭제 권한을 쥐여주게 된다.
 *
 * `k`는 09 §5의 `email_unsubscribed { kind }`를 채우는 값이다. 어느 메일의 링크로 껐는지가
 * §1의 방어를 읽는 유일한 단서라 링크가 실어 나른다. 편지 ID도 주소도 들어가지 않는다.
 */
export function unsubscribeUrl(token: string, kind: EmailKind): string {
  return `${site()}/unsubscribe/${token}?k=${kind}`;
}

// ── 발송 네 종 ─────────────────────────────────────────────
//
// 넷 다 던지지 않는다. 부르는 쪽이 `void`로 던져두기 때문에(위 규칙 3) 여기서 새는 예외는
// 처리되지 않는 거부가 된다.

interface Contact {
  email: string;
  unsubscribe_token: string;
}

/** 1번 — 등록 직후. 관리 토큰 원문은 이 순간에만 존재한다 (D-014). */
export async function notifyManageLink(
  params: { email: string; unsubscribeToken: string; manageToken: string },
  sender: MailSender | null = resendSender(),
): Promise<void> {
  try {
    await deliver(
      "manage_link",
      {
        to: params.email,
        ...manageLinkMail({
          manageUrl: manageUrl(params.manageToken),
          unsubscribeUrl: unsubscribeUrl(params.unsubscribeToken, "manage_link"),
        }),
      },
      sender,
    );
  } catch (error) {
    console.error("[email] manage_link 처리 실패", error);
  }
}

/**
 * 2번 — 편지가 처음 열렸을 때. **편지당 1회** (09 §2 · 안전 #19).
 *
 * `first_unlock_notified_at is null`을 조건에 건 UPDATE가 선점이다. 두 번째 열람은 0행을
 * 받고 그대로 끝난다 — 이메일을 등록하지 않은 편지도 0행이라 같은 길로 끝난다.
 */
export async function notifyFirstUnlock(
  letterId: string,
  sender: MailSender | null = resendSender(),
): Promise<void> {
  try {
    const { rows } = await query<Contact>(
      `update author_contacts
          set first_unlock_notified_at = now()
        where letter_id = $1
          and first_unlock_notified_at is null
      returning email, unsubscribe_token`,
      [letterId],
    );
    const contact = rows[0];
    if (!contact) return;

    await deliver(
      "first_unlock",
      {
        to: contact.email,
        ...firstUnlockMail({
          letterUrl: letterUrl(letterId),
          unsubscribeUrl: unsubscribeUrl(
            contact.unsubscribe_token,
            "first_unlock",
          ),
        }),
      },
      sender,
    );
  } catch (error) {
    console.error("[email] first_unlock 처리 실패", error);
  }
}

/**
 * 4번 — 연 사람이 `yes`로 답했을 때. **편지당 1회** (D-023 · 안전 #24).
 *
 * 입력이 `unlockId`인 이유: 응답 표면이 가진 값이 그것뿐이고, `unlocks`에서 편지를 찾는
 * 조회를 그 표면에 심는 것보다 여기서 한 번에 하는 편이 낫다. 조건에 `recipient_response
 * = 'yes'`를 함께 걸어 **`no`·`unknown`·무응답이 이 UPDATE를 통과할 길 자체를 없앤다** —
 * 부르는 쪽의 조건문이 언젠가 느슨해져도 메일이 나가지 않는다.
 */
export async function notifyRecipientYes(
  unlockId: string,
  sender: MailSender | null = resendSender(),
): Promise<void> {
  try {
    const { rows } = await query<Contact & { letter_id: string }>(
      `update author_contacts c
          set recipient_yes_notified_at = now()
         from unlocks u
        where u.unlock_id = $1
          and u.letter_id = c.letter_id
          and u.recipient_response = 'yes'
          and c.recipient_yes_notified_at is null
      returning c.email, c.unsubscribe_token, c.letter_id`,
      [unlockId],
    );
    const contact = rows[0];
    if (!contact) return;

    await deliver(
      "recipient_yes",
      {
        to: contact.email,
        ...recipientYesMail({
          letterUrl: letterUrl(contact.letter_id),
          unsubscribeUrl: unsubscribeUrl(
            contact.unsubscribe_token,
            "recipient_yes",
          ),
        }),
      },
      sender,
    );
  } catch (error) {
    console.error("[email] recipient_yes 처리 실패", error);
  }
}

/**
 * 3번 — 신고로 자동 비공개됐을 때. **발생마다** 보낸다 (09 §2).
 *
 * 선점 컬럼이 없다. 편지가 내려갔다가 복귀했다가 다시 내려가는 것은 각각 별개의 사건이고,
 * 작성자가 알아야 하는 것도 매번이다. 그래서 부르는 쪽이 **실제로 상태가 바뀐 경우에만**
 * 부른다 — 이미 내려가 있는 편지에 들어온 두 번째 신고는 자동 비공개가 아니다.
 *
 * 이 메일에는 관리 링크가 없다. 이유는 templates/index.ts의 `autoHiddenMail` 주석에 있다.
 */
export async function notifyAutoHidden(
  letterId: string,
  sender: MailSender | null = resendSender(),
): Promise<void> {
  try {
    const { rows } = await query<Contact>(
      "select email, unsubscribe_token from author_contacts where letter_id = $1",
      [letterId],
    );
    const contact = rows[0];
    if (!contact) return;

    await deliver(
      "auto_hidden",
      {
        to: contact.email,
        ...autoHiddenMail({
          unsubscribeUrl: unsubscribeUrl(
            contact.unsubscribe_token,
            "auto_hidden",
          ),
        }),
      },
      sender,
    );
  } catch (error) {
    console.error("[email] auto_hidden 처리 실패", error);
  }
}
