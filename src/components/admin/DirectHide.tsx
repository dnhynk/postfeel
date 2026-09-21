"use client";

// 편지 하나를 신고 없이 즉시 비공개 (05-api §4 `POST /api/admin/letters/:id/hide`).
//
// 07 §4 긴급 대응의 1번 단계다 — "해당 편지 즉시 비공개 (1분)". 신고 큐를 거치지 않으므로
// 편지 ID를 직접 넣는다. 큐에서 온 게 아니라 텔레그램 알림이나 외부 문의로 ID를 들고
// 오는 경로라 입력이 ID 하나다.

import { useState } from "react";

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

export function DirectHide() {
  const [letterId, setLetterId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/letters/${encodeURIComponent(letterId.trim())}/hide`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
        },
      );
      if (response.status === 204) {
        setMessage(`${letterId.trim()} — 비공개로 내렸습니다.`);
        setLetterId("");
        setNote("");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setMessage(body?.error?.message ?? NETWORK_ERROR);
    } catch {
      setMessage(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">편지 직접 비공개</h2>
      <p className="mt-1 text-sm text-neutral-600">
        07 §4 긴급 대응 1번. 편지는 <code>hidden_admin</code>이 되고 작성자는 관리
        화면에서 이의를 제기할 수 있습니다.
      </p>

      <label htmlFor="hide-letter-id" className="mt-3 block text-sm">
        편지 ID
      </label>
      <input
        id="hide-letter-id"
        className={FIELD}
        value={letterId}
        onChange={(event) => setLetterId(event.target.value)}
      />
      <label htmlFor="hide-note" className="mt-2 block text-sm">
        판정 이유 한 줄
      </label>
      <input
        id="hide-note"
        className={FIELD}
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      {message ? <p className="mt-3 text-sm">{message}</p> : null}

      <button
        type="button"
        className="mt-3 rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50"
        disabled={busy || letterId.trim().length === 0}
        onClick={() => void submit()}
      >
        비공개로 내리기
      </button>
    </section>
  );
}

const FIELD = "mt-1 w-full rounded border border-neutral-400 p-2 text-sm";
