"use client";

// `/manage/:token` 화면 (03 §1-7).
//
// 삭제뿐 아니라 **현재 상태를 보여주는 화면**이다. 편지가 비공개 상태여도 열리고, 이게
// 이의 제기의 유일한 경로다 (05-api §2 · 04 §5 발견 2).
//
// 상태(200/410/404)는 전부 `GET /api/manage/:token`이 정한다 — 이 컴포넌트는 그 응답을
// 렌더할 뿐이다. 서버 컴포넌트로 렌더하지 않는 이유는 두 가지다: 페이지는 410을 표현할
// 수 없고, 계측(`manage_view`)이 붙을 자리도 API 쪽이다.

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ManageView } from "@/lib/letters/manage";

type Screen =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "deleted" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; view: ManageView };

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

/** 05-api §6: `message`는 사용자에게 그대로 보여줄 한국어다. 화면이 다시 쓰지 않는다. */
async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? NETWORK_ERROR;
  } catch {
    return NETWORK_ERROR;
  }
}

/** 상태를 읽어 화면 하나를 돌려준다. setState를 하지 않아 effect에서도 부를 수 있다. */
async function fetchScreen(endpoint: string): Promise<Screen> {
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (response.status === 404) return { kind: "missing" };
    if (response.status === 410) return { kind: "deleted" };
    if (!response.ok) {
      return { kind: "failed", message: await messageOf(response) };
    }
    return { kind: "ready", view: (await response.json()) as ManageView };
  } catch {
    return { kind: "failed", message: NETWORK_ERROR };
  }
}

export function ManageScreen({ token }: { token: string }) {
  const endpoint = `/api/manage/${encodeURIComponent(token)}`;

  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealDone, setAppealDone] = useState(false);
  const [appealMessage, setAppealMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchScreen(endpoint).then((next) => {
      if (!cancelled) setScreen(next);
    });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  async function reload() {
    setScreen(await fetchScreen(endpoint));
  }

  // 삭제는 되돌릴 수 없으므로 확인 1회. **사유는 묻지 않는다** (S-9).
  async function submitDelete() {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      // 410 = 이미 지워진 편지. 사용자에게는 삭제된 결과가 같다.
      if (response.status === 204 || response.status === 410) {
        setConfirmingDelete(false);
        setScreen({ kind: "deleted" });
        return;
      }
      setActionError(await messageOf(response));
    } catch {
      setActionError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function submitAppeal() {
    setBusy(true);
    setActionError(null);
    const message = appealMessage.trim();
    try {
      const response = await fetch(`${endpoint}/appeal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message ? { message } : {}),
      });
      if (response.status === 204) {
        setAppealOpen(false);
        setAppealMessage("");
        setAppealDone(true);
        await reload();
        return;
      }
      setActionError(await messageOf(response));
    } catch {
      setActionError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (screen.kind === "loading") {
    return <Frame>불러오는 중입니다.</Frame>;
  }

  if (screen.kind === "missing") {
    return (
      <Frame>
        <p>편지를 찾을 수 없습니다.</p>
        <p className="mt-2 text-sm text-neutral-600">
          관리 링크가 정확한지 확인해 주세요. 링크를 잃어버렸다면{" "}
          <Link href="/delete-request" className="underline">
            삭제 요청
          </Link>
          을 보낼 수 있습니다.
        </p>
      </Frame>
    );
  }

  if (screen.kind === "deleted") {
    return <Frame>이미 삭제된 편지입니다. 되돌릴 수 없습니다.</Frame>;
  }

  if (screen.kind === "failed") {
    return (
      <Frame>
        <p>{screen.message}</p>
        <button type="button" className={BUTTON} onClick={() => void reload()}>
          다시 시도
        </button>
      </Frame>
    );
  }

  const { view } = screen;

  return (
    <Frame>
      <StatusText view={view} />

      {/* 열람 신호는 **있을 때만** 말한다. `opened`는 잠긴 편지의 해제 기록이라
          공개 편지에서는 늘 false인데, "아직 아무도 열지 않았습니다"를 띄우면 읽힌
          편지에 대고 안 읽혔다고 말하는 셈이다 — 없는 신호를 만드는 것과 같다 (D-007). */}
      {view.opened ? (
        <p className="mt-4 text-sm text-neutral-700">누군가 편지를 열었습니다.</p>
      ) : null}
      {view.recipientSaidYes ? (
        <p className="mt-1 text-sm text-neutral-700">
          {'편지를 연 사람이 "나에게 온 것 같다"고 답했습니다.'}
        </p>
      ) : null}

      {appealDone ? (
        <p className="mt-4 text-sm text-neutral-700">
          이의 제기를 접수했습니다. 검토 결과는 이 화면에서 확인할 수 있습니다.
        </p>
      ) : null}

      {actionError ? (
        <p className="mt-4 text-sm text-neutral-900">{actionError}</p>
      ) : null}

      {confirmingDelete ? (
        <div className="mt-6">
          <p>편지를 삭제할까요?</p>
          {/* 03 §1-5의 문장. 삭제 직전에도 사실이다. */}
          <p className="mt-1 text-sm text-neutral-600">
            이 편지는 지울 수 있지만, 이미 본 사람의 기억은 지울 수 없습니다.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void submitDelete()}
            >
              삭제합니다
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
            >
              취소
            </button>
          </div>
        </div>
      ) : appealOpen ? (
        <div className="mt-6">
          <label htmlFor="appeal-message" className="block text-sm">
            어떤 점이 잘못됐는지 알려주세요. (선택)
          </label>
          <textarea
            id="appeal-message"
            className={FIELD}
            rows={4}
            maxLength={1000}
            value={appealMessage}
            onChange={(event) => setAppealMessage(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void submitAppeal()}
            >
              이의 제기 보내기
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => setAppealOpen(false)}
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex gap-2">
          {/* canAppeal이 false면 버튼 자체를 숨긴다 — 눌러도 안 되는 버튼을 두지 않는다. */}
          {view.canAppeal ? (
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setActionError(null);
                setAppealOpen(true);
              }}
            >
              이의 제기
            </button>
          ) : null}
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              setActionError(null);
              setConfirmingDelete(true);
            }}
          >
            편지 삭제
          </button>
        </div>
      )}
    </Frame>
  );
}

/** 상태 문구. `hidden_auto`는 03 §1-7 그대로다. */
function StatusText({ view }: { view: ManageView }) {
  if (view.statusReason === "reported") {
    return (
      <p>
        이 편지는 신고가 접수되어 현재 비공개 상태입니다.
        <br />
        검토 중이며, 보통 하루 안에 결과를 알려드립니다.
      </p>
    );
  }
  // 운영자가 직접 내린 경우다. 신고를 단정하지 않고, 이미 사람이 판정을 내린 상태라
  // "하루 안에 결과"를 약속하지도 않는다 — 없는 약속은 없는 신호와 같다 (D-007).
  if (view.statusReason === "admin") {
    return (
      <p>
        이 편지는 운영자 검토로 비공개 처리되었습니다.
        <br />
        판단이 잘못됐다고 생각하시면 이의를 제기할 수 있습니다.
      </p>
    );
  }
  // D-035 — 자동 검사가 아직 안 끝났다. **이 편지는 링크로도 안 열린다.** 그 사실을
  // 말하지 않으면 작성자가 자기 링크를 열어보고 404를 만나 편지가 사라진 줄 안다.
  // 신고로 내려간 것과 구분해서 적는다 — 여기엔 잘못한 것이 없다.
  if (view.pendingReview) {
    return (
      <p>
        자동 검사가 아직 끝나지 않아 이 편지는 아직 공개되지 않았습니다.
        <br />
        검사가 끝나면 자동으로 공개됩니다. 그때까지는 링크를 공유해도 열리지 않습니다.
      </p>
    );
  }
  return <p>이 편지는 공개되어 있습니다.</p>;
}

function Frame({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-md p-6">{children}</main>;
}

const BUTTON =
  "rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50";
const FIELD =
  "mt-1 w-full rounded border border-neutral-400 p-2 text-sm";
