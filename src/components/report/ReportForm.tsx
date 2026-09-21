"use client";

// `/report/:id` 화면 (03 화면 목록 · 02 §4).
//
// **2번 이내 조작으로 도달해야 하는 버튼의 끝**이다 (02 §4). 편지 카드의 `신고` 링크가
// 1번, 여기서 사유를 고르고 보내는 것이 나머지다. 그래서 화면에 단계를 더 만들지 않는다
// — 사유 목록 하나와 보내기 버튼 하나뿐이다.
//
// **편지 본문을 다시 보여주지 않는다.** 신고하러 온 사람은 이미 편지를 봤고, 여기서 다시
// 띄우면 편지 ID만 아는 사람이 본문을 읽는 또 하나의 경로가 된다.
//
// 사유 문구는 `src/lib/reports/reasons.ts`의 표(= 02 §4)를 그대로 쓴다.

import type { FormEvent } from "react";
import { useState } from "react";
import {
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  type ReportReason,
} from "@/lib/reports/reasons";

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

export function ReportForm({ letterId }: { letterId: string }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/letters/${encodeURIComponent(letterId)}/report`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      if (response.status === 204) {
        setDone(true);
        return;
      }
      // 05-api §6: `message`는 사용자에게 그대로 보여줄 한국어다.
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
        <p>신고를 접수했습니다.</p>
        {/* 02 §4의 SLA는 24시간이다. 접수 즉시 비공개가 기본 동작이지만 이미 한 번
            판정받은 편지는 그대로 있을 수 있어(D-025) 단정하지 않는다. */}
        <p className="mt-2 text-sm text-neutral-600">
          운영자가 확인해 처리합니다. 보통 하루 안에 끝나고, 확인 전까지 편지가
          비공개로 바뀔 수 있습니다.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-lg font-semibold">이 편지를 신고합니다</h1>
      <p className="mt-2 text-sm text-neutral-600">
        어떤 문제인지 골라 주세요. 접수되면 운영자가 확인합니다.
      </p>

      <form className="mt-6" onSubmit={(event) => void submit(event)}>
        <fieldset>
          <legend className="sr-only">신고 사유</legend>
          {REPORT_REASONS.map((value) => (
            <label key={value} className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="reason"
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
              />
              {REPORT_REASON_LABELS[value]}
            </label>
          ))}
        </fieldset>

        {error ? <p className="mt-4 text-sm">{error}</p> : null}

        <button
          type="submit"
          className="mt-6 rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50"
          disabled={busy || !reason}
        >
          신고하기
        </button>
      </form>
    </main>
  );
}
