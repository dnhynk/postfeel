"use client";

// `/admin/queue` 화면 (05-api §4 · 07 §1 · §2).
//
// 네 종류를 한 화면에 세로로 쌓는다: 미판정 신고 · 자동 비공개 건 · 이의 제기 ·
// 삭제 요청. 07 §1의 예산이 **하루 2회 15분, 건당 1분**이라 화면이 지켜야 할 것은 하나다
// — 판정에 필요한 것을 여기서 전부 보여주고 다른 문서를 열게 하지 않는다. 판정표는
// 화면 아래 `VerdictTable`에 있다.
//
// ── 조치 버튼을 초안 옆에 두지 않는다 ───────────────────────
// 07 §2: 큐는 **후보 행과 근거만** 보여주고 판정은 사람이 한다. 분류기 초안 바로 옆에
// 버튼을 두면 운영자는 승인 버튼만 누르는 사람이 되고, D-012가 사전 검토를 기각한
// 근거(사후에는 사람이 판단한다)가 조용히 무너진다. 그래서 초안은 **카드 위쪽의 근거
// 블록**에 있고 조치는 본문을 지나 **카드 아래쪽**에 있다.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type {
  QueueAppeal,
  QueueDeletionRequest,
  QueueLetter,
  QueueReport,
  QueueView,
} from "@/lib/admin/queue";
import { REPORT_REASON_LABELS } from "@/lib/reports/reasons";
import { VerdictTable } from "./VerdictTable";

const NETWORK_ERROR = "연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";

type Screen =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; view: QueueView };

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? NETWORK_ERROR;
  } catch {
    return NETWORK_ERROR;
  }
}

async function fetchQueue(): Promise<Screen> {
  try {
    const response = await fetch("/api/admin/queue", { cache: "no-store" });
    if (!response.ok) {
      return { kind: "failed", message: await messageOf(response) };
    }
    return { kind: "ready", view: (await response.json()) as QueueView };
  } catch {
    return { kind: "failed", message: NETWORK_ERROR };
  }
}

export function QueueScreen() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchQueue().then((next) => {
      if (!cancelled) setScreen(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 판정 한 건. 성공하면 큐를 다시 읽는다 — 화면이 자기 상태를 추측하지 않는다. */
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 204) {
        setScreen(await fetchQueue());
        return;
      }
      setError(await messageOf(response));
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  if (screen.kind === "loading") {
    return <Frame>불러오는 중입니다.</Frame>;
  }
  if (screen.kind === "failed") {
    return (
      <Frame>
        <p>{screen.message}</p>
        <button
          type="button"
          className={BUTTON}
          onClick={() => void fetchQueue().then(setScreen)}
        >
          다시 시도
        </button>
      </Frame>
    );
  }

  const { view } = screen;

  return (
    <Frame>
      <h1 className="text-lg font-semibold">운영자 큐</h1>
      <p className="mt-1 text-sm text-neutral-600">
        미판정 신고 {view.reports.length} · 자동 비공개 {view.autoHidden.length} ·
        이의 제기 {view.appeals.length} · 삭제 요청 {view.deletionRequests.length}
      </p>
      {view.truncated ? (
        <p className="mt-1 text-sm">
          목록이 100건에서 잘렸습니다. 남은 건은 처리 후 다시 열면 보입니다.
        </p>
      ) : null}

      {/* D-031 — 시한을 넘긴 격리. 파기 잡이 이의 제기가 열린 건을 건너뛰므로 여기 남는다.
          **맨 위에 둔다.** 넘긴 상태 자체가 위반으로 읽힐 수 있어 다른 무엇보다 먼저
          보여야 하고, 비어 있는 것이 정상이라 평소에는 아무것도 그리지 않는다. */}
      {view.overdue.length > 0 ? (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800">
            격리 30일 초과 {view.overdue.length}건 — 이의 제기가 열려 있어 파기를
            멈췄습니다
          </p>
          <p className="mt-1 text-sm text-red-700">
            아래 이의 제기를 먼저 판정하세요. 판정하면 다음 파기 회차에 종결됩니다.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-red-700">
            {view.overdue.map((item) => (
              <li key={item.letterId}>
                <code>{item.letterId}</code> · 격리 {formatTime(item.quarantinedAt)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="mt-4 text-sm">{error}</p> : null}

      <Section title={`미판정 신고 (${view.reports.length})`}>
        {view.reports.map((report) => (
          <ReportCard
            key={report.id}
            report={report}
            busy={busy}
            onResolve={(action, note) =>
              void act(`/api/admin/reports/${report.id}/resolve`, {
                action,
                ...(note ? { note } : {}),
              })
            }
          />
        ))}
      </Section>

      <Section title={`자동 비공개 건 (${view.autoHidden.length})`}>
        {/* 조치는 위 신고 항목에서 한다. 여기 남아 있는데 위에 대응하는 신고가 없다면
            접수 중에 뭔가 어긋난 것이라, 그걸 보이게 하는 것이 이 목록의 쓸모다. */}
        <p className="text-sm text-neutral-600">
          지금 <code>hidden_auto</code>인 편지입니다. 판정은 위의 신고 항목에서 합니다.
        </p>
        {view.autoHidden.map((letter) => (
          <div key={letter.id} className={CARD}>
            <LetterBlock letter={letter} />
          </div>
        ))}
      </Section>

      <Section title={`이의 제기 (${view.appeals.length})`}>
        {view.appeals.map((appeal) => (
          <AppealCard
            key={appeal.id}
            appeal={appeal}
            busy={busy}
            onResolve={(action, note) =>
              void act(`/api/admin/appeals/${appeal.id}/resolve`, {
                action,
                ...(note ? { note } : {}),
              })
            }
          />
        ))}
      </Section>

      <Section title={`삭제 요청 (${view.deletionRequests.length})`}>
        {/* 07 §5. 다른 판정과 방향이 반대라 화면에 그대로 적는다. */}
        <p className="text-sm text-neutral-600">
          본문 발췌를 편지와 대조합니다. <strong>일치하면 삭제. 애매하면 삭제</strong>
          (편지를 지키는 것보다 삭제가 안전).
        </p>
        {view.deletionRequests.map((request) => (
          <DeletionRequestCard
            key={request.id}
            request={request}
            busy={busy}
            onResolve={(letterId, note) =>
              void act(`/api/admin/deletion-requests/${request.id}/resolve`, {
                letterId,
                ...(note ? { note } : {}),
              })
            }
          />
        ))}
      </Section>

      <VerdictTable />
    </Frame>
  );
}

/**
 * 신고 한 건. **export 하는 이유는 테스트다** — 07 §2의 "초안 옆에 조치 버튼을 두지
 * 않는다"는 주석으로는 지킬 수 없어서, 렌더 결과에서 초안 · 본문 · 조치의 순서를
 * 고정한다 (`tests/ui/queue-draft.test.ts`).
 */
export function ReportCard({
  report,
  busy,
  onResolve,
}: {
  report: QueueReport;
  busy: boolean;
  onResolve: (action: "uphold" | "dismiss", note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <div className={CARD}>
      <p className="text-sm">
        <strong>{REPORT_REASON_LABELS[report.reason]}</strong> · 신고 #{report.id} ·{" "}
        {formatTime(report.createdAt)}
      </p>
      {/* D-034 6 — 텔레그램 알림에는 편지 ID도 사유도 없고 이 사건 번호만 있다.
          새벽에 알림을 받은 운영자가 대조하는 값이라 카드 맨 위에 그대로 둔다. */}
      <p className="text-sm text-neutral-600">
        사건 <code>{report.incidentId}</code>
      </p>

      {/* 근거 블록. 조치 버튼은 여기 없다 (07 §2). */}
      <div className="mt-2 rounded border border-neutral-300 bg-neutral-50 p-3 text-sm">
        <p className="font-semibold">분류기 초안 (근거)</p>
        <p className="mt-1 text-neutral-700">
          {report.draft ?? "아직 없습니다. 판정은 아래 본문을 직접 읽고 합니다."}
        </p>
      </div>

      <LetterBlock letter={report.letter} />

      <div className="mt-3 border-t border-neutral-200 pt-3">
        <label htmlFor={`note-report-${report.id}`} className="block text-sm">
          판정 이유 한 줄 (07 §2 원칙 3)
        </label>
        <input
          id={`note-report-${report.id}`}
          className={FIELD}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => onResolve("uphold", note.trim())}
          >
            위반 — 비공개 유지 (uphold)
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => onResolve("dismiss", note.trim())}
          >
            문제없음 — 복구 (dismiss)
          </button>
        </div>
      </div>
    </div>
  );
}

function AppealCard({
  appeal,
  busy,
  onResolve,
}: {
  appeal: QueueAppeal;
  busy: boolean;
  onResolve: (action: "restore" | "reject", note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <div className={CARD}>
      <p className="text-sm">
        <strong>이의 제기 #{appeal.id}</strong> · {formatTime(appeal.createdAt)}
      </p>
      <p className="mt-2 text-sm text-neutral-700">
        {appeal.message ?? "설명 없이 접수됐습니다."}
      </p>

      <LetterBlock letter={appeal.letter} />

      <div className="mt-3 border-t border-neutral-200 pt-3">
        <label htmlFor={`note-appeal-${appeal.id}`} className="block text-sm">
          판정 이유 한 줄
        </label>
        <input
          id={`note-appeal-${appeal.id}`}
          className={FIELD}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => onResolve("restore", note.trim())}
          >
            인용 — 되살림 (restore)
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => onResolve("reject", note.trim())}
          >
            반려 (reject)
          </button>
        </div>
      </div>
    </div>
  );
}

function DeletionRequestCard({
  request,
  busy,
  onResolve,
}: {
  request: QueueDeletionRequest;
  busy: boolean;
  onResolve: (letterId: string, note: string) => void;
}) {
  const [letterId, setLetterId] = useState("");
  const [note, setNote] = useState("");

  return (
    <div className={CARD}>
      <p className="text-sm">
        <strong>삭제 요청 #{request.id}</strong> · {formatTime(request.createdAt)}
      </p>
      <p className="mt-2 text-sm text-neutral-700">{request.bodyExcerpt}</p>
      <p className="mt-1 text-sm text-neutral-600">
        회신처: {request.contact ?? "없음"}
      </p>

      <div className="mt-3 border-t border-neutral-200 pt-3">
        <label htmlFor={`letter-${request.id}`} className="block text-sm">
          대조한 편지 ID
        </label>
        <input
          id={`letter-${request.id}`}
          className={FIELD}
          value={letterId}
          onChange={(event) => setLetterId(event.target.value)}
        />
        <label htmlFor={`note-deletion-${request.id}`} className="mt-2 block text-sm">
          처리 이유 한 줄
        </label>
        <input
          id={`note-deletion-${request.id}`}
          className={FIELD}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button"
          className={`${BUTTON} mt-2`}
          disabled={busy || letterId.trim().length === 0}
          onClick={() => onResolve(letterId.trim(), note.trim())}
        >
          이 편지를 삭제하고 처리 완료
        </button>
      </div>
    </div>
  );
}

/** 판정에 필요한 편지 값. 07 §2 판정표가 묻는 것에 답할 수 있어야 한다. */
function LetterBlock({ letter }: { letter: QueueLetter }) {
  return (
    <div className="mt-3">
      <p className="text-sm text-neutral-600">
        {letter.id} · {letter.mode} · {letter.relationship} · 등급{" "}
        {letter.riskLevel} · 상태 {letter.status} · 신고 {letter.reportCount}건
        {letter.autoHideExempt ? " · auto_hide_exempt" : ""} ·{" "}
        {formatTime(letter.createdAt)}
      </p>
      {letter.quarantinedAt !== null ? (
        // D-028 — 격리 중이다. 시한이 걸린 상태라는 사실을 판정 화면이 말해야 한다.
        // 본문은 격리 영역에서 복호해 채운 것이고 `letters`에는 없다.
        <p className="mt-2 text-sm text-amber-700">
          격리됨 · {formatTime(letter.quarantinedAt)}부터 30일 안에 종결해야 합니다
        </p>
      ) : null}
      {letter.body === null ? (
        <p className="mt-2 text-sm text-neutral-500">
          {letter.quarantinedAt === null
            ? // 작성자가 먼저 지웠다 (D-027). 원문은 파기됐고 되돌릴 수 없다.
              "작성자가 삭제한 편지입니다. 본문은 파기되어 남아 있지 않습니다."
            : // 격리돼 있는데 열지 못했다 = 키가 없다. 판정할 수 없으므로 조용히
              // 비워 두지 않는다 — 빈 본문을 보고 "문제없음"을 누르면 안 된다.
              "격리된 본문을 열지 못했습니다. QUARANTINE_KEY를 확인하기 전에는 판정하지 마세요."}
        </p>
      ) : (
        <p className="mt-2 text-sm whitespace-pre-wrap">{letter.body}</p>
      )}
      {letter.hint ? (
        <p className="mt-2 text-sm text-neutral-700">단서: {letter.hint}</p>
      ) : null}
      {letter.question ? (
        <p className="mt-1 text-sm text-neutral-700">질문: {letter.question}</p>
      ) : null}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-3xl p-6">{children}</main>;
}

/** 큐는 "얼마나 오래 기다렸는가"만 보면 된다. 로케일에 기대지 않게 ISO를 짧게 자른다. */
function formatTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

const CARD = "mt-3 rounded border border-neutral-300 p-4";
const BUTTON =
  "rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50";
const FIELD = "mt-1 w-full rounded border border-neutral-400 p-2 text-sm";
