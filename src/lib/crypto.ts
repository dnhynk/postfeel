// 해시·HMAC·랜덤 토큰. 여기 있는 함수만 쓰고 각 표면에서 node:crypto를 직접 부르지
// 않는다 — 상수 시간 비교를 빠뜨린 자리가 하나라도 생기면 그 자리가 곧 구멍이다.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * 32바이트 랜덤 → base64url.
 *
 * 관리 토큰(D-014)과 `author_contacts.unsubscribe_token`(09 §4)이 쓴다. 둘 다
 * **서명 토큰이 아니라** 랜덤 토큰이다 — 유출 시 해당 행 하나만 갈면 폐기된다.
 */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

export function hmacSha256(key: string | Buffer, input: string | Buffer): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

/**
 * 상수 시간 비교.
 *
 * `timingSafeEqual`은 길이가 다르면 **던진다.** 그래서 길이를 먼저 보고 false를
 * 돌려주는 구현이 흔한데, 그러면 "길이가 같은가"가 분기로 새어나간다. 양쪽을 먼저
 * sha256으로 눌러 32바이트 고정 길이로 만든 뒤 비교하면 그 분기 자체가 사라진다.
 *
 * 남는 누출은 sha256 계산 시간이 **입력 길이**에 비례한다는 것뿐이고, 내용에는
 * 의존하지 않는다. 이 함수의 실제 사용처(HMAC 32바이트끼리 비교)에서는 길이가 항상
 * 같아 그마저도 상수다.
 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

// ── 관리 토큰 조회에는 상수 시간 비교를 쓰지 않는다 ─────────
//
// 05-api §3: 검증은 `sha256(token)`으로 `letters.manage_token_hash`(unique index)를
// 조회한다. **원문 비교가 일어나지 않으므로** 비교할 대상이 없고, 인덱스 조회 시간은
// 토큰 값에 의존하지 않는다. 여기에 constantTimeEqual을 끼워 넣으면 방어가 아니라
// "여기도 비교가 있다"는 오해만 남는다.
//
// 상수 시간 비교가 실제로 필요한 곳은 사용자가 입력한 값을 저장된 값과 맞춰보는
// 자리다 — 열쇠 답(answer.ts)과 confirmation 토큰 서명(confirmation.ts).

/** 관리 토큰 → DB에 저장되는 해시 (D-014 · 05-api §3). 원문은 저장하지 않는다. */
export function manageTokenHash(token: string): Buffer {
  return sha256(token);
}

/** AES-256-GCM 한 건. 셋을 함께 저장해야 복호할 수 있다. */
export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * AES-256-GCM 봉인 — [D-030](../../docs/00-decisions.md)의 법정 접속기록에서 **원본 IP**에만 쓴다.
 *
 * ── 왜 해시가 아니라 암호화인가 ──────────────────────────────
 * 이 값은 다른 곳과 목적이 정반대다. `fp_hash`는 **되돌릴 수 없어야** 하고(05-api §5),
 * 접속기록의 IP는 적법한 요청이 왔을 때 **되돌릴 수 있어야** 한다. 해시로 남기면
 * 보관 의무를 이행한 것이 되지 않는다.
 *
 * ── 접속기록은 이 앱에서 복호되지 않는다 ─────────────────────
 * 아래 `unseal`이 있지만 **접속기록에는 닿지 않는다.** 이유가 둘이다.
 *   · 키가 다르다 — 접속기록은 `ACCESS_LOG_KEY`, 격리 본문은 `QUARANTINE_KEY`
 *   · 앱에 `audit.access_log`를 읽는 경로가 없다 (안전 테스트 26)
 *
 * 07 §6이 "공문이나 영장을 확인하기 전에는 어떤 데이터도 제공하지 않는다"고 정했으므로,
 * 접속기록 복호는 **그때 운영자가 하는 일**이지 앱이 상시 갖고 있을 능력이 아니다.
 * 키를 나눈 것이 그 경계다 — 한 키를 쓰면 격리 본문을 여는 코드가 접속기록도 열 수 있다.
 *
 * 키는 임의 문자열을 받아 sha256으로 32바이트를 만든다 — 다른 키들과 같은 취급이다.
 */
export function seal(key: string | Buffer, plaintext: string): SealedValue {
  const iv = randomBytes(12); // GCM 권장 96비트
  const cipher = createCipheriv("aes-256-gcm", sha256(key), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/**
 * `seal`의 역. **격리 본문([D-028](../../docs/00-decisions.md))에만 쓴다.**
 *
 * 운영자가 판정하려면 본문을 읽어야 하므로 여기는 복호가 필수다. 접속기록과 다른
 * 점이고, 그래서 **키를 나눴다** — `QUARANTINE_KEY`로는 `ACCESS_LOG_KEY`로 봉인한
 * 것을 열 수 없다.
 *
 * 인증 태그가 맞지 않으면 **던진다.** GCM이 위변조를 잡는 지점이라 조용히 빈 값을
 * 돌려주면 안 된다 — 격리된 본문이 바뀌었다는 것은 그 자체가 사건이다.
 */
export function unseal(key: string | Buffer, sealed: SealedValue): string {
  const decipher = createDecipheriv("aes-256-gcm", sha256(key), sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
