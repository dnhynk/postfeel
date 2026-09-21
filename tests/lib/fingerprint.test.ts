// src/lib/fingerprint.ts — normalize(ip) 규칙 (05-api §5)

import { describe, expect, it } from "vitest";
import { clientIp, fingerprint, fpHash, normalizeIp } from "@/lib/fingerprint";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("normalizeIp", () => {
  it("IPv4는 전체 주소를 그대로 쓴다", () => {
    expect(normalizeIp("203.0.113.9")).toBe("203.0.113.9");
  });

  it("IPv6는 상위 64비트만 남긴다 (RFC 4291 §2.5.4)", () => {
    expect(normalizeIp("2001:db8:85a3:1:1234:5678:9abc:def0")).toBe(
      "2001:0db8:85a3:0001::",
    );
  });

  it("같은 /64 안에서 인터페이스 식별자가 바뀌어도 같은 값이다", () => {
    // 프라이버시 확장으로 단말이 하위 64비트를 자주 바꾼다. 전체 주소를 쓰면
    // 같은 사람이 매번 다른 fp가 되어 레이트리밋이 무력해진다.
    expect(normalizeIp("2001:db8:85a3:1::1")).toBe(
      normalizeIp("2001:db8:85a3:1:ffff:ffff:ffff:ffff"),
    );
  });

  it("다른 /64면 다른 값이다", () => {
    expect(normalizeIp("2001:db8:85a3:1::1")).not.toBe(
      normalizeIp("2001:db8:85a3:2::1"),
    );
  });

  it("압축 표기를 canonical하게 편다", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:0db8:0000:0000::");
    expect(normalizeIp("::1")).toBe("0000:0000:0000:0000::");
  });

  it("소문자화하고 앞뒤 공백을 지운다", () => {
    expect(normalizeIp("  2001:DB8:85A3:1::1  ")).toBe("2001:0db8:85a3:0001::");
  });

  it("대괄호와 존 인덱스를 뗀다", () => {
    expect(normalizeIp("[2001:db8:85a3:1::1]")).toBe("2001:0db8:85a3:0001::");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0000:0000:0000::");
  });

  it("IPv4-mapped(::ffff:a.b.c.d)는 IPv4로 되돌린다", () => {
    // 그대로 /64로 자르면 모든 매핑 주소가 한 버킷(0000:0000:0000:0000::)에 모인다.
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("IP가 아니면 소문자·공백 정리만 하고 그대로 둔다", () => {
    expect(normalizeIp("  UNKNOWN  ")).toBe("unknown");
  });
});

describe("clientIp — 헤더 우선순위 (Vercel 공식 문서)", () => {
  it("x-vercel-forwarded-for가 가장 먼저다", () => {
    // Vercel 위에 프록시를 얹으면 x-forwarded-for는 덮이고 이 헤더는 남는다.
    expect(
      clientIp(
        headers({
          "x-vercel-forwarded-for": "203.0.113.9",
          "x-forwarded-for": "198.51.100.7",
          "x-real-ip": "192.0.2.5",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("없으면 x-forwarded-for", () => {
    expect(
      clientIp(
        headers({ "x-forwarded-for": "198.51.100.7", "x-real-ip": "192.0.2.5" }),
      ),
    ).toBe("198.51.100.7");
  });

  it("그다음 x-real-ip", () => {
    expect(clientIp(headers({ "x-real-ip": "192.0.2.5" }))).toBe("192.0.2.5");
  });

  it("셋 다 없으면 0.0.0.0 (로컬 개발)", () => {
    expect(clientIp(headers({}))).toBe("0.0.0.0");
  });

  it("쉼표 목록이면 첫 번째 항목을 쓴다", () => {
    expect(
      clientIp(headers({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" })),
    ).toBe("203.0.113.9");
  });
});

describe("fpHash", () => {
  it("IP가 같아도 UA가 다르면 다른 fp다", () => {
    expect(fpHash("203.0.113.9", "A").equals(fpHash("203.0.113.9", "B"))).toBe(
      false,
    );
  });

  it("normalize 후 같은 값이면 같은 fp다", () => {
    expect(
      fpHash("2001:db8:85a3:1::1", "UA").equals(
        fpHash("2001:DB8:85a3:1:aaaa::9", "UA"),
      ),
    ).toBe(true);
  });

  it("fingerprint()는 헤더 하나로 같은 결과를 낸다", () => {
    const h = headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "UA" });
    expect(fingerprint(h).equals(fpHash("203.0.113.9", "UA"))).toBe(true);
  });
});
