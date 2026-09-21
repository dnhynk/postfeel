"use client";

// 전역 킬 스위치 둘 (02 §5 · 07 §3 · 05-api §4).
//
// **1클릭 + 확인 다이얼로그 1회.** 02 §5가 못박은 조작 비용이다. 자는 동안 뭔가 터졌을 때
// 사고 조사와 노출 차단을 분리하는 장치라, 여기서 단계를 더 두면 장치가 무의미해진다.
//
// 두 스위치의 차이를 화면에 적는다 (07 §3). 새벽에 여는 화면이 문서를 다시 열게 만들면
// 안 된다:
//
//   > **자리를 비울 때는 읽기가 아니라 작성을 끈다.**

import { useState } from "react";

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

type SwitchKey = "publicReadEnabled" | "writingEnabled";

interface Props {
  publicReadEnabled: boolean;
  writingEnabled: boolean;
}

export function KillSwitches({ publicReadEnabled, writingEnabled }: Props) {
  const [state, setState] = useState<Props>({
    publicReadEnabled,
    writingEnabled,
  });
  const [confirming, setConfirming] = useState<SwitchKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(key: SwitchKey, next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      if (response.ok) {
        setState((await response.json()) as Props);
        setConfirming(null);
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
    <section className="mt-8">
      <h2 className="text-base font-semibold">킬 스위치</h2>
      <p className="mt-1 text-sm text-neutral-600">
        자리를 비울 때는 읽기가 아니라 <strong>작성</strong>을 끕니다. 공개 읽기를
        끄면 피드뿐 아니라 이미 공유된 링크까지 전부 죽습니다.
      </p>

      {error ? <p className="mt-4 text-sm">{error}</p> : null}

      <Switch
        label="작성"
        description="스팸 폭주 · 필터 오작동 · 자리를 비울 때 (07 §3)"
        enabled={state.writingEnabled}
        confirming={confirming === "writingEnabled"}
        busy={busy}
        onAsk={() => {
          setError(null);
          setConfirming("writingEnabled");
        }}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void apply("writingEnabled", !state.writingEnabled)}
      />

      <Switch
        label="공개 읽기"
        description="문제 콘텐츠가 여러 건이라 개별 처리로 못 따라갈 때 (07 §3)"
        enabled={state.publicReadEnabled}
        confirming={confirming === "publicReadEnabled"}
        busy={busy}
        onAsk={() => {
          setError(null);
          setConfirming("publicReadEnabled");
        }}
        onCancel={() => setConfirming(null)}
        onConfirm={() =>
          void apply("publicReadEnabled", !state.publicReadEnabled)
        }
      />

      <p className="mt-4 text-sm text-neutral-600">
        어느 쪽을 꺼도 관리 화면(<code>/manage/:token</code>)은 계속 열립니다 —
        사고 대응 중에도 작성자는 자기 편지를 지울 수 있어야 합니다.
      </p>
    </section>
  );
}

function Switch({
  label,
  description,
  enabled,
  confirming,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  label: string;
  description: string;
  enabled: boolean;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 rounded border border-neutral-300 p-4">
      <p className="text-sm">
        <strong>{label}</strong> — 지금 {enabled ? "켜져 있습니다" : "꺼져 있습니다"}
      </p>
      <p className="mt-1 text-sm text-neutral-600">{description}</p>

      {confirming ? (
        <div className="mt-3">
          <p className="text-sm">
            {label}을(를) {enabled ? "끌까요" : "켤까요"}?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={onConfirm}
            >
              {enabled ? "끕니다" : "켭니다"}
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={onCancel}
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={`${BUTTON} mt-3`} onClick={onAsk}>
          {enabled ? "끄기" : "켜기"}
        </button>
      )}
    </div>
  );
}

const BUTTON =
  "rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50";
