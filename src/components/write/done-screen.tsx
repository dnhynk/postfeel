"use client";

// 03 §1-6. 완료.
//
// **관리 URL에 편지 ID를 넣지 않는다 — 토큰만으로 식별한다 (D-014).** 토큰이 틀려도
// 어느 편지에 대한 시도인지 노출되지 않는다.
//
// 관리 토큰은 이 화면에서만 볼 수 있다. 재발급이 없다 (05-api §2).

import Link from "next/link";
import type { FormEvent } from "react";
import { useState } from "react";
import { SharePanel } from "@/components/share/SharePanel";
import type { LetterMode } from "@/lib/letters/read";
import { INPUT, PRIMARY, SECONDARY } from "./ui";

export function DoneScreen({
  manageToken,
  letterId,
  mode,
}: {
  manageToken: string;
  letterId: string;
  mode: LetterMode;
}) {
  const [copied, setCopied] = useState(false);

  // D-022의 도메인. 빌드 시 인라인되는 NEXT_PUBLIC 값이고, 없으면 현재 오리진으로
  // 떨어진다 — 링크가 비어 보이는 것보다 낫다.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (typeof window === "undefined" ? "" : window.location.origin);
  const manageUrl = `${origin}/manage/${manageToken}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(manageUrl);
      setCopied(true);
    } catch {
      // 클립보드 권한이 없으면 사용자가 직접 복사한다. 링크는 화면에 그대로 있다.
      setCopied(false);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold">편지를 남겼습니다.</h2>

      {/* 03 §1-6의 `[ 공유 카드 ]`. **여기가 유통의 시작점이다** — D-006에 따라 비사용자에게
          아무 알림도 보내지 않으므로, 작성자가 지금 공유하지 않으면 편지는 피드에서
          누군가 우연히 볼 때까지 아무에게도 안 간다. 그래서 펼친 채로 둔다. */}
      <div className="mt-4">
        <SharePanel
          letterId={letterId}
          mode={mode}
          from="create_done"
          defaultOpen
        />
      </div>

      <p className="mt-6">이 링크로 언제든 편지를 지울 수 있습니다.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-neutral-100 px-3 py-2 text-sm">
          {manageUrl}
        </code>
        <button type="button" className={SECONDARY} onClick={copy}>
          {copied ? "복사됨" : "복사"}
        </button>
      </div>
      <p className="mt-2 text-sm text-neutral-600">
        이 링크는 지금만 볼 수 있습니다. 다시 받을 수 없습니다.
      </p>

      <ContactSection manageToken={manageToken} />

      {/* 03 §1-6 「이메일 없이 넘어가는 게 정상 경로다. 건너뛰기를 눈에 띄게 둔다」 —
          이 화면에서 가장 눈에 띄는 버튼이 건너뛰기(피드로 가기)이고, 등록은 그 옆의
          부차 동작이다. 반대로 두면 이메일이 사실상 필수처럼 읽힌다 (D-005). */}
      <div className="mt-8">
        <Link className={PRIMARY} href="/">
          피드로 가기
        </Link>
      </div>
    </section>
  );
}

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

/**
 * 이메일 등록 (03 §1-6 · D-005 · D-032 · 05-api §3).
 *
 * ── 이메일을 넣을 때만 체크박스가 나온다 ───────────────────
 * "체크박스는 이메일을 넣을 때만 필수다. 이메일을 안 넣으면 체크박스도 없다." 빈 칸에도
 * 띄우면 이 화면이 개인정보와 무관하게 연령을 묻는 것처럼 보인다.
 *
 * **2026-08-16 · 여기가 더는 유일한 지점이 아니다.** [D-032](../../../docs/00-decisions.md)가
 * D-013을 뒤집어 **편지 작성에도** 만 14세 확인을 붙였다. 다만 규칙은 그대로다 —
 * 열람·피드에는 없고, 작성과 개인정보 수집이라는 두 지점에만 붙는다.
 *
 * **미체크면 버튼이 비활성이고, 서버도 거부한다** (05-api §3). 화면의 비활성은 편의이고
 * 방어는 서버다 — 이 컴포넌트를 우회해도 저장되지 않는다.
 *
 * 등록은 편지 ID가 아니라 **방금 받은 관리 토큰으로** 보낸다 (D-006 · 05-api §3).
 */
function ContactSection({ manageToken }: { manageToken: string }) {
  const [email, setEmail] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const hasEmail = email.trim().length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasEmail || !ageConfirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/manage/${encodeURIComponent(manageToken)}/contact`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), ageConfirmed: true }),
        },
      );
      if (response.status === 204) {
        setDone(true);
        return;
      }
      // 05-api §6: `message`는 사용자에게 그대로 보여줄 한국어다. 여기서 코드별 문구를
      // 다시 만들지 않는다 — 그러면 문구가 두 곳에 살게 된다.
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? NETWORK_ERROR);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mt-8 rounded-lg border border-neutral-200 p-4">
        <p>이메일을 등록했습니다.</p>
        <p className="mt-2 text-sm text-neutral-600">
          방금 그 주소로 관리 링크를 보내드렸습니다. 편지가 처음 열리면 알려
          드립니다.
        </p>
      </div>
    );
  }

  return (
    <form className="mt-8" onSubmit={(event) => void submit(event)}>
      <label htmlFor="contact-email" className="block">
        편지가 열리면 알려드릴까요?
      </label>
      <input
        id="contact-email"
        type="email"
        className={`${INPUT} mt-2`}
        placeholder="이메일 (선택)"
        autoComplete="email"
        maxLength={254}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      {hasEmail ? (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ageConfirmed}
            onChange={(event) => setAgeConfirmed(event.target.checked)}
          />
          만 14세 이상입니다
        </label>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-neutral-700" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          className={SECONDARY}
          disabled={!hasEmail || !ageConfirmed || busy}
        >
          등록
        </button>
      </div>
    </form>
  );
}
