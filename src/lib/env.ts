// 환경변수 검증. 값이 빠진 채로 부팅해서 런타임에 터지는 대신 여기서 죽는다.
//
// 목록의 근거: D-017 시크릿 4종 · 05-api §4(운영자 비밀번호) · D-019(Resend·텔레그램)
// · D-020(OpenAI) · D-022(도메인).
//
// 필수 / 선택을 가르는 기준은 마일스톤이다. M1에 필요한 값만 필수이고, M2 이후에
// 쓰기 시작하는 값은 선택으로 둔다. 지금 전부 필수로 걸면 M1 단계의 CI·로컬 개발이
// 아직 존재하지 않는 기능의 키를 요구하게 된다. 대신 그 값을 실제로 쓰는 코드가
// requireEnv()로 그 자리에서 필수 검사를 한다 — 검사를 없애는 게 아니라 옮기는 것이다.

import { z } from "zod";

const schema = z.object({
  // ── M1부터 필요 ──────────────────────────────────────
  DATABASE_URL: z.string().min(1),
  /** D-017 · 교체 불가. 바꾸면 이미 게시된 잠긴 편지가 전부 영구히 안 열린다 */
  ANSWER_KEY: z.string().min(1),
  /** D-017 · 교체 가능. 바꿔도 레이트리밋 카운트가 한 번 리셋될 뿐이다 */
  FP_KEY: z.string().min(1),
  /** D-022 · https://postfeel.kr */
  NEXT_PUBLIC_SITE_URL: z.url(),

  // ── M2 이후 (쓰는 코드에서 requireEnv로 검사) ─────────
  /** D-017 · confirmation 토큰 서명 (M2) */
  CONFIRMATION_KEY: z.string().min(1).optional(),
  /** D-017 · 운영자 세션 쿠키 서명 (M2) */
  ADMIN_SESSION_KEY: z.string().min(1).optional(),
  /** 05-api §4 · 키가 아니라 운영자 로그인 비밀번호 (M2) */
  ADMIN_PASSWORD: z.string().min(1).optional(),
  /** D-020 · 층 2 분류기 (M2) */
  OPENAI_API_KEY: z.string().min(1).optional(),
  /** 05-api §1 재분류 잡 · 크론 워크플로가 Authorization 헤더로 실어 보낸다 (M2) */
  CRON_SECRET: z.string().min(1).optional(),
  /** D-019 · 사용자 메일 (M4) */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** D-019 · 운영자 알림 (M2) */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  /**
   * D-030 · 법정 접속기록의 원본 IP 봉인 키 (M7).
   *
   * **교체하면 그 이전 기록을 복호할 수 없다.** `answer_key`와 같은 종류의 위험이고
   * (D-017), 그래서 교체 가능한 키들과 나란히 두지 않는다. 보관 의무가 걸린 3개월치를
   * 못 읽게 되는 것은 보관하지 않은 것과 같다.
   *
   * 값이 없으면 접속기록을 남기지 않는다 — 아래 `requireEnv`가 아니라 호출부가
   * 판단한다 (src/lib/access-log.ts). 로컬 개발과 CI가 이 키 없이 돌아야 하기 때문이다.
   */
  ACCESS_LOG_KEY: z.string().min(1).optional(),
  /**
   * D-028 · 격리된 편지 본문의 봉인 키 (M7).
   *
   * **`ACCESS_LOG_KEY`와 반드시 다른 값이어야 한다.** 같은 키를 쓰면 격리 본문을 여는
   * 코드가 접속기록도 열 수 있게 되고, D-030이 "앱은 접속기록을 조회할 수 없다"로
   * 세운 경계가 사라진다. 키 분리가 그 경계다 (crypto.ts `seal` 주석).
   *
   * 교체하면 격리 중인 본문을 복원할 수 없다 — 판정도 복원도 불가능해진다.
   */
  QUARANTINE_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

/** `KEY=` 처럼 비워둔 값은 "설정하지 않음"으로 본다. */
function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

// process.env를 통째로 넘기지 않는다. NEXT_PUBLIC_* 은 빌드 시 리터럴 참조만
// 인라인되므로, 여기서 키를 하나씩 적어야 클라이언트 번들에서도 값이 살아 있다.
const raw = {
  DATABASE_URL: blankToUndefined(process.env.DATABASE_URL),
  ANSWER_KEY: blankToUndefined(process.env.ANSWER_KEY),
  FP_KEY: blankToUndefined(process.env.FP_KEY),
  NEXT_PUBLIC_SITE_URL: blankToUndefined(process.env.NEXT_PUBLIC_SITE_URL),
  CONFIRMATION_KEY: blankToUndefined(process.env.CONFIRMATION_KEY),
  ADMIN_SESSION_KEY: blankToUndefined(process.env.ADMIN_SESSION_KEY),
  ADMIN_PASSWORD: blankToUndefined(process.env.ADMIN_PASSWORD),
  OPENAI_API_KEY: blankToUndefined(process.env.OPENAI_API_KEY),
  CRON_SECRET: blankToUndefined(process.env.CRON_SECRET),
  RESEND_API_KEY: blankToUndefined(process.env.RESEND_API_KEY),
  TELEGRAM_BOT_TOKEN: blankToUndefined(process.env.TELEGRAM_BOT_TOKEN),
  TELEGRAM_CHAT_ID: blankToUndefined(process.env.TELEGRAM_CHAT_ID),
  ACCESS_LOG_KEY: blankToUndefined(process.env.ACCESS_LOG_KEY),
  QUARANTINE_KEY: blankToUndefined(process.env.QUARANTINE_KEY),
};

const parsed = schema.safeParse(raw);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  · ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`환경변수 검증 실패. .env.example을 참고한다.\n${detail}`);
}

export const env: Env = parsed.data;

type OptionalEnvKey = {
  [K in keyof Env]-?: undefined extends Env[K] ? K : never;
}[keyof Env];

/**
 * M2 이후에만 필요한 값을 실제로 쓰는 자리에서 필수로 만든다.
 *
 * 스키마에서 optional로 두는 것과 "없어도 된다"는 다르다. 예를 들어 ADMIN_PASSWORD가
 * 없는 채로 /api/admin/login이 살아 있으면 인증이 통째로 무의미해질 수 있다.
 * 그 판단은 그 코드가 한다 — 여기서는 자리를 만들어 둘 뿐이다.
 */
export function requireEnv(key: OptionalEnvKey): string {
  const value = env[key];
  if (value === undefined) {
    throw new Error(`환경변수 ${key}가 필요한 코드가 실행됐지만 값이 없다.`);
  }
  return value;
}
