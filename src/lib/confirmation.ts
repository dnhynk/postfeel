// `confirmation` 토큰 — 인터스티셜을 거친 재제출이 등급을 다시 매기지 않고 통과하게
// 하는 서명 토큰 (05-api §1).
//
// 판정은 서버만 할 수 있는데 인터스티셜은 제출 **전에** 떠야 한다. 순진하게 만들면
// 분류기가 편지 하나당 두 번 돈다. 그래서 1차 판정 결과를 서명해 클라이언트에 맡기고,
// 재제출 때 서명만 검증한다.
//
// 서명 키는 `confirmation_key`다 (D-017). 교체하면 미사용 토큰만 무효가 되고 해당
// 편지가 재분류 1회를 더 할 뿐이다 — 수명이 10분이라 영향이 짧다.

import { constantTimeEqual, hmacSha256, sha256 } from "./crypto";
import { requireEnv } from "./env";
import type { Flag, LetterDraft } from "./safety/types";

/** 05-api §1. 발급 후 10분. */
export const TTL_MS = 10 * 60 * 1000;

export interface ConfirmationPayload {
  contentHash: string;
  /** `high`에는 발급하지 않으므로 medium 하나뿐이다 (05-api §1 · 안전 테스트 3). */
  risk: "medium";
  /** 분류기 응답 그대로. 재제출은 재판정하지 않으므로 `letters.risk_flags`의 유일한 출처다. */
  flags: Flag[];
  /** 1차 판정이 남긴 `filter_events` 행. 재제출이 오면 `warned` → `published`로 올린다. */
  filterEventId: number;
  /** epoch ms. */
  exp: number;
}

/** 발급자가 정하는 것만 받는다. `risk`와 `exp`는 여기서 고정한다. */
export type ConfirmationInput = Omit<ConfirmationPayload, "risk" | "exp">;

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "content_changed";

export type VerifyResult =
  | { ok: true; payload: ConfirmationPayload }
  | { ok: false; reason: VerifyFailure };

/**
 * 편지 내용의 지문.
 *
 * **단순 문자열 연결을 쓰지 않는다.** `body + hint + question`은 필드 경계가 없어서,
 * 걸린 표현을 본문 끝에서 단서 앞으로 한 글자씩 옮기면 **내용이 달라져도 해시가 같다.**
 * 그러면 confirmation 하나로 다른 편지를 통과시킬 수 있다 (05-api §1). 배열을
 * 직렬화해 경계를 고정한다.
 *
 * **`answer`가 들어간다** (D-021 · 안전 테스트 4). 빠뜨리면 경고를 본 뒤 답만
 * 갈아끼운 편지가 같은 토큰으로 통과한다. 답은 등급 판정 대상이 아니지만 표기 변형
 * 생성의 입력이라, 1차 판정 때의 답과 실제로 저장되는 답이 다르면 안 된다.
 */
export function contentHash(draft: LetterDraft): string {
  const material = JSON.stringify([
    draft.body,
    draft.hint ?? null,
    draft.question ?? null,
    draft.answer ?? null,
  ]);
  return sha256(material).toString("hex");
}

function sign(payloadPart: string): string {
  return hmacSha256(requireEnv("CONFIRMATION_KEY"), payloadPart).toString(
    "base64url",
  );
}

export function issue(payload: ConfirmationInput, now = Date.now()): string {
  const full: ConfirmationPayload = {
    ...payload,
    risk: "medium",
    exp: now + TTL_MS,
  };
  const part = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return `${part}.${sign(part)}`;
}

/**
 * 서명 · 만료 · 내용 일치를 전부 확인한다.
 *
 * 내용이 달라졌으면 토큰을 거절한다. 그러면 부르는 쪽이 **다시 분류한다** — 사용자가
 * 경고를 보고 고친 편지는 고친 내용으로 판정받고, 토큰으로 필터를 우회할 수는 없다.
 */
export function verify(
  token: string,
  draft: LetterDraft,
  now = Date.now(),
): VerifyResult {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const part = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // 서명부터 본다. 서명이 붙지 않은 페이로드는 읽을 가치가 없다.
  if (
    !constantTimeEqual(
      Buffer.from(signature, "base64url"),
      Buffer.from(sign(part), "base64url"),
    )
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    ) as ConfirmationPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.contentHash !== "string" ||
    payload.risk !== "medium" ||
    !Array.isArray(payload.flags) ||
    typeof payload.filterEventId !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (now >= payload.exp) return { ok: false, reason: "expired" };

  // 서명이 확인된 뒤라 이 비교에는 비밀이 없다. 상수 시간일 필요가 없다.
  if (payload.contentHash !== contentHash(draft)) {
    return { ok: false, reason: "content_changed" };
  }

  return { ok: true, payload };
}
