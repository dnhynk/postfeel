"use client";

// 운영자 로그인 (05-api §4).
//
// `/admin`과 `/admin/queue`가 인증되지 않았을 때 **큐 대신** 이걸 렌더한다. 리다이렉트가
// 아니라 교체인 이유: 껍데기를 먼저 그리고 나중에 가리는 경로를 만들지 않기 위해서다
// (05-api §4 "API만 막고 페이지를 열어두면 큐 화면 껍데기가 노출된다").
//
// 실패 문구는 서버가 준 것을 그대로 쓴다 — 어느 쪽이 틀렸는지는 서버도 말하지 않는다.

import type { FormEvent } from "react";
import { useState } from "react";

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.status === 204) {
        // 쿠키는 HttpOnly라 클라이언트가 읽지 않는다. 서버 렌더를 다시 받는 게
        // 인증 상태를 반영하는 유일한 방법이다.
        window.location.reload();
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

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-lg font-semibold">운영자 로그인</h1>
      <form className="mt-6" onSubmit={(event) => void submit(event)}>
        <label htmlFor="admin-password" className="block text-sm">
          비밀번호
        </label>
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          className="mt-1 w-full rounded border border-neutral-400 p-2 text-sm"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error ? <p className="mt-4 text-sm">{error}</p> : null}

        <button
          type="submit"
          className="mt-6 rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50"
          disabled={busy || password.length === 0}
        >
          로그인
        </button>
      </form>
    </main>
  );
}
