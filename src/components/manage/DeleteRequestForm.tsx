"use client";

// `/delete-request` 화면 (03 화면 목록 · 04 §5 발견 3 · 07 §5).
//
// 관리 링크를 잃어버렸을 때의 삭제 경로다. 여기서 편지를 찾아 보여주지 않는다 —
// 본인 확인은 운영자가 본문 일부를 대조해서 한다. 화면이 "이 편지 맞나요?"를 띄우는
// 순간, 본문 일부만 아는 사람이 남의 편지를 확인하는 도구가 된다.

import type { FormEvent } from "react";
import { useState } from "react";

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

export function DeleteRequestForm() {
  const [bodyExcerpt, setBodyExcerpt] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/deletion-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bodyExcerpt: bodyExcerpt.trim(),
          ...(contact.trim() ? { contact: contact.trim() } : {}),
        }),
      });
      if (response.status === 204) {
        setDone(true);
        return;
      }
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
      <main className="mx-auto max-w-md p-6">
        <p>삭제 요청을 접수했습니다.</p>
        <p className="mt-2 text-sm text-neutral-600">
          운영자가 본문을 대조한 뒤 처리합니다. 연락처를 남기셨다면 처리 후
          회신드립니다.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-lg font-semibold">삭제 요청</h1>
      <p className="mt-2 text-sm text-neutral-600">
        관리 링크를 잃어버렸다면 여기로 요청해 주세요. 편지 본문의 일부를 적어
        주시면 운영자가 대조한 뒤 삭제합니다. 사람이 직접 확인하기 때문에 시간이
        걸립니다.
      </p>

      <form className="mt-6" onSubmit={(event) => void submit(event)}>
        <label htmlFor="body-excerpt" className="block text-sm">
          편지 본문의 일부
        </label>
        <textarea
          id="body-excerpt"
          className={FIELD}
          rows={4}
          maxLength={500}
          required
          value={bodyExcerpt}
          onChange={(event) => setBodyExcerpt(event.target.value)}
        />

        <label htmlFor="contact" className="mt-4 block text-sm">
          회신받을 연락처 (선택)
        </label>
        <input
          id="contact"
          className={FIELD}
          maxLength={200}
          value={contact}
          onChange={(event) => setContact(event.target.value)}
        />

        {error ? <p className="mt-4 text-sm">{error}</p> : null}

        <button
          type="submit"
          className="mt-6 rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50"
          disabled={busy || bodyExcerpt.trim().length === 0}
        >
          삭제 요청 보내기
        </button>
      </form>
    </main>
  );
}

const FIELD = "mt-1 w-full rounded border border-neutral-400 p-2 text-sm";
