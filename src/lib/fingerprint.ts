// 레이트리밋 식별자 `fp_hash` (05-api §5).
//
//   fp_hash = HMAC-SHA256(fp_key, normalize(ip) + '|' + user_agent)
//
// **이 경로는 해시만 남긴다.** User-Agent 원문은 어디에도 저장하지 않고, 원본 IP는
// 법정 접속기록(D-030 · `audit.access_log`)에만 있다 — 그쪽과 이 값을 잇는 키는 없다.
//
// 키는 `answer_key`가 아니라 `fp_key`다 — 언제든 교체할 수 있고 카운트가 한 번
// 리셋될 뿐이다 (D-017).
//
// ── normalize(ip) 확정 ──────────────────────────────────────
// 04 「미해결」이 "구현 시 고정하면 된다"고 남긴 항목을 여기서 고정한다.
//
// **어느 헤더를 믿는가** — 우선순위: x-vercel-forwarded-for → x-forwarded-for →
// x-real-ip, 셋 다 없으면 '0.0.0.0'(로컬 개발).
//   · Vercel은 `x-forwarded-for`를 **덮어쓰고** 외부에서 넣은 값을 전달하지 않는다.
//     명시된 목적이 IP 스푸핑 방지다. 그래서 이 헤더를 믿을 수 있다.
//   · `x-vercel-forwarded-for`는 같은 값이되 **Vercel 위에 프록시를 얹었을 때 덮이지
//     않는다.** 그래서 먼저 본다.
//   · 근거: https://vercel.com/docs/headers/request-headers
//   · 값에 쉼표가 있으면 첫 번째 항목을 쓴다. 위 이유로 정상 경로에서는 단일 값이다.
//
// **IPv6는 상위 64비트만 쓴다** — RFC 4291 §2.5.4가 /64를 인터페이스 식별자 경계로
// 정했고, 단말 하나가 그 안에서 주소를 자주 바꾼다(임시 주소·프라이버시 확장).
// 전체 주소를 쓰면 같은 사람이 매번 다른 fp가 되어 레이트리밋이 무력해진다.
// IPv4는 전체 주소를 그대로 쓴다.
//
// 05-api §5의 "한국 모바일 캐리어 NAT 때문에 다수 사용자가 IP를 공유한다"는
// **임계값 문제이지 정규화 문제가 아니다.** 임계값은 ratelimit.ts에 있다.

import { isIPv4, isIPv6 } from "node:net";
import { hmacSha256 } from "./crypto";
import { env } from "./env";

/** 헤더가 하나도 없을 때(로컬 개발). 실제 배포에서는 Vercel이 항상 채운다. */
export const UNKNOWN_IP = "0.0.0.0";

/** 우선순위대로. 앞의 것이 이긴다. */
const IP_HEADERS = [
  "x-vercel-forwarded-for",
  "x-forwarded-for",
  "x-real-ip",
] as const;

/** 요청 헤더에서 클라이언트 IP를 고른다. */
export function clientIp(headers: Headers): string {
  for (const name of IP_HEADERS) {
    const raw = headers.get(name);
    if (!raw) continue;
    // 쉼표 목록이면 첫 번째가 원 클라이언트다.
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return UNKNOWN_IP;
}

/**
 * `normalize(ip)` — 위 주석의 규칙.
 *
 * IP로 파싱되지 않는 값은 소문자·공백 정리만 하고 그대로 돌려준다. Vercel이 헤더를
 * 덮어쓰므로 배포 경로에서는 여기 닿지 않는다. 이때 '0.0.0.0'으로 접지 않는 이유는
 * 파싱 실패한 값들이 전부 한 버킷에 모이면 정상 사용자가 남의 카운트에 걸리기
 * 때문이다.
 */
export function normalizeIp(raw: string): string {
  // 대괄호(`[::1]`)와 존 인덱스(`%eth0`)를 떼고 소문자로 맞춘다.
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return ip;

  const groups = ipv6Groups(ip);
  if (!groups) return ip;

  // IPv4-mapped(::ffff:a.b.c.d)는 IPv4로 되돌린다. 그대로 /64로 자르면 모든
  // 매핑 주소가 `0000:0000:0000:0000::` 한 버킷에 모여 레이트리밋이 무너진다.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const a = groups[6]!;
    const b = groups[7]!;
    return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
  }

  // 상위 4그룹 = 64비트. canonical하게 0을 채워 편 뒤 자른다.
  return (
    groups
      .slice(0, 4)
      .map((g) => g.toString(16).padStart(4, "0"))
      .join(":") + "::"
  );
}

/** 검증된 IPv6 문자열을 8개 그룹(각 16비트)으로 편다. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip;

  // 임베디드 IPv4(`::ffff:1.2.3.4`)를 두 개의 16비트 그룹으로 바꾼다.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${(
      (c << 8) |
      d
    ).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let parts: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    parts = head;
  } else {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    parts = [...head, ...Array<string>(fill).fill("0"), ...rest];
  }

  const groups = parts.map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g))) {
    return null;
  }
  return groups;
}

/** 05-api §5의 산출식. */
export function fpHash(ip: string, userAgent: string): Buffer {
  return hmacSha256(env.FP_KEY, `${normalizeIp(ip)}|${userAgent}`);
}

/** 요청 헤더 하나로 fp_hash까지. 각 표면이 실제로 부르는 함수다. */
export function fingerprint(headers: Headers): Buffer {
  return fpHash(clientIp(headers), headers.get("user-agent") ?? "");
}
