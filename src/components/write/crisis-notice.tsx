"use client";

// 위기 상담 안내 (D-026 · 03 §1-6-1 · 02 S-4).
//
// **별도 페이지를 만들지 않고 차단 화면 안에** 띄운다 — 이미 그 화면에 있는 사람을
// 다른 데로 보내지 않는다. 그래서 이 컴포넌트는 blocked-screen.tsx 안에서만 쓰인다.
//
// **기관·연락처·운영시간이 비어 있으면 아무것도 렌더하지 않는다.** 이 안전장치는
// 값이 채워진 뒤에도 그대로다 — 나중에 출처가 낡아 값을 빼야 할 일이 생기면
// src/lib/crisis.ts의 배열을 비우는 것만으로 안내가 사라진다. 검증되지 않은 번호를
// 띄우는 건 안내를 안 하는 것보다 나쁘다(D-026).
//
// 값은 src/lib/crisis.ts에 있고 **지금은 두 건이 채워져 있다** — 출처는
// 보건복지상담센터(https://www.129.go.kr/109, 확인일 2026-08-14)이고 근거와 확인일은
// 그 파일 상단에 있다. 그래서 `self_harm` 차단 화면에서 이 블록이 실제로 렌더된다.
//
// 우리는 안내만 한다. 상담 채널을 사칭하지 않고, 대신 연락하지 않는다 (D-001).

import { CRISIS_CONTACTS } from "@/lib/crisis";

export function CrisisNotice() {
  if (CRISIS_CONTACTS.length === 0) return null;

  return (
    <section className="mt-6 rounded-md border border-neutral-300 p-4">
      {/* 03 §1-6-1 그대로 */}
      <p className="text-neutral-900">
        지금 많이 힘드시다면 이야기할 수 있는 곳이 있습니다.
      </p>
      <ul className="mt-3 grid gap-2">
        {CRISIS_CONTACTS.map((contact) => (
          <li
            key={`${contact.name}-${contact.phone}`}
            className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
          >
            <span className="font-medium">{contact.name}</span>
            <span>{contact.phone}</span>
            <span className="text-neutral-600">{contact.hours}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
