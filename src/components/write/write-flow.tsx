"use client";

// `/write` — 단일 페이지 다단계 (03 §1-1 ~ §1-6, 화면 목록).
//
// 라우트가 바뀌지 않는다. 뒤로 가기가 브라우저 히스토리를 타면 쓰던 글이 사라지는
// 사고가 나기 쉬워서, 단계는 이 컴포넌트의 상태로만 움직인다.
//
// 검사는 **제출 시 1회**다. 타이핑 중에는 `/api/letters`를 부르지 않는다 (03 §1-2).
//
// 상태 구성: 저장된 초안(useStoredDraft)이 바닥이고 이번 세션의 편집(edits)이 그
// 위에 얹힌다. 초안을 state로 "복사"하지 않는 이유는 draft.ts 주석에 있다.

import { useCallback, useEffect, useState } from "react";
import { track } from "@/lib/analytics/client";
import type { Flag, LetterMode, Relationship } from "@/lib/safety/types";
import { BlockedScreen } from "./blocked-screen";
import { BodyStep } from "./body-step";
import { DoneScreen } from "./done-screen";
import {
  EMPTY_DRAFT,
  type StoredDraft,
  clearDraft,
  saveDraft,
  useStoredDraft,
} from "./draft";
import { Interstitial } from "./interstitial";
import { LockedStep } from "./locked-step";
import { ModeStep } from "./mode-step";
import { RelationshipStep } from "./relationship-step";
import { ReviewStep } from "./review-step";

type Step = "relationship" | "body" | "mode" | "locked" | "review";

type Screen =
  | { kind: "form" }
  | {
      kind: "interstitial";
      flags: Flag[];
      notice?: string;
      confirmation: string;
    }
  | { kind: "blocked"; flags: Flag[] }
  // `letterId`·`mode`는 완료 화면의 공유 카드가 쓴다 (03 흐름 3). 이 컴포넌트가 이미
  // 갖고 있는 값을 내려보내는 것뿐이고, 편지 ID는 DoneScreen 밖으로 나가지 않는다
  // (06-analytics §2 — 계측 props에 편지 ID를 담지 않는다).
  | { kind: "done"; manageToken: string; letterId: string; mode: LetterMode };

/** 05-api §1 · §6의 응답들. */
type CreateResponse =
  | { status: "created"; id: string; manageToken: string }
  | { status: "blocked"; risk: "high"; flags: Flag[] }
  | {
      status: "needs_confirmation";
      risk: "medium";
      flags: Flag[];
      confirmation: string;
      notice?: string;
    }
  | { error: { code: string; message: string; retryAfter?: number } };

/** `write_start.entry` (06 §3). 어디서 들어왔는지는 referrer로만 알 수 있다. */
function entryPoint(): "feed" | "letter" | "direct" {
  try {
    const referrer = document.referrer;
    if (!referrer) return "direct";
    const url = new URL(referrer);
    if (url.origin !== window.location.origin) return "direct";
    if (url.pathname === "/") return "feed";
    if (url.pathname.startsWith("/m/")) return "letter";
    return "direct";
  } catch {
    return "direct";
  }
}

/** 03 실패 상태 표 — 레이트리밋에 걸리면 대기 시간을 명시한다. */
function waitLine(retryAfter: number | undefined): string {
  if (retryAfter === undefined || retryAfter <= 0) return "";
  const minutes = Math.ceil(retryAfter / 60);
  return ` 약 ${minutes}분 뒤에 다시 쓸 수 있습니다.`;
}

export function WriteFlow() {
  const stored = useStoredDraft();
  const [edits, setEdits] = useState<Partial<StoredDraft>>({});
  const draft: StoredDraft = { ...EMPTY_DRAFT, ...stored, ...edits };

  // 답은 초안에 저장되지 않으므로 이번 세션 상태로만 산다 (draft.ts).
  const [answer, setAnswer] = useState("");

  // D-032 — 작성 시점의 만 14세 확인. **초안에 저장하지 않는다**: 확인은 지금 이 편지를
  // 남기겠다는 행위이지 복원할 입력값이 아니고, localStorage에 남겨두면 예전에 한 번 켠
  // 체크가 다음 작성의 확인을 대신하게 된다.
  const [ageConfirmed, setAgeConfirmed] = useState(false);

  // 아직 아무 단계도 고르지 않았으면 초안이 시작 지점을 정한다 — 쓰던 글이 있으면
  // 이미 고른 관계를 다시 묻지 않는다.
  const [chosenStep, setChosenStep] = useState<Step | null>(null);
  const step: Step =
    chosenStep ??
    (draft.relationship !== undefined && draft.body !== ""
      ? "body"
      : "relationship");

  const [screen, setScreen] = useState<Screen>({ kind: "form" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    track("write_start", { entry: entryPoint() });
  }, []);

  /** 편집 하나가 곧 자동 저장이다 (03 §1-2). 별도 타이머를 두지 않는다. */
  const patch = useCallback(
    (change: Partial<StoredDraft>) => {
      saveDraft({ ...EMPTY_DRAFT, ...stored, ...edits, ...change });
      setEdits((previous) => ({ ...previous, ...change }));
    },
    [stored, edits],
  );

  const { mode, relationship, body, hint, question } = draft;

  const submit = useCallback(
    async (confirmation?: string) => {
      // 강행(인터스티셜)도 이 함수를 지나므로 확인은 여기 한 곳에서 본다. 화면의 이
      // 차단은 편의이고 방어는 서버다 — 이 컴포넌트를 우회해도 생성되지 않는다.
      if (!ageConfirmed) {
        setScreen({ kind: "form" });
        setChosenStep("review");
        setError("만 14세 이상임을 확인해 주세요.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const response = await fetch("/api/letters", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            relationship,
            body,
            ...(mode === "locked" ? { hint, question, answer } : {}),
            ageConfirmed: true,
            ...(confirmation === undefined ? {} : { confirmation }),
          }),
        });

        let data: CreateResponse | null = null;
        try {
          data = (await response.json()) as CreateResponse;
        } catch {
          data = null;
        }

        if (data !== null && "status" in data) {
          if (data.status === "created") {
            clearDraft();
            // review 단계에 도달한 시점에 mode는 이미 정해져 있고, 서버도 mode 없는
            // 요청을 400으로 막는다 — `created`는 mode가 있는 제출의 응답이다.
            setScreen({
              kind: "done",
              manageToken: data.manageToken,
              letterId: data.id,
              mode: mode as LetterMode,
            });
            return;
          }
          if (data.status === "blocked") {
            // 본문은 서버로 가지 않았다. 로컬 초안은 그대로 둔다 (03 실패 상태 표).
            setScreen({ kind: "blocked", flags: data.flags ?? [] });
            return;
          }
          if (data.status === "needs_confirmation") {
            track("filter_warned", { risk: data.risk, flags: data.flags ?? [] });
            setScreen({
              kind: "interstitial",
              flags: data.flags ?? [],
              ...(data.notice === undefined ? {} : { notice: data.notice }),
              confirmation: data.confirmation,
            });
            return;
          }
        }

        // 05-api §6의 오류 형태. message는 그대로 보여줄 한국어다.
        setScreen({ kind: "form" });
        setChosenStep("review");
        setError(
          data !== null && "error" in data
            ? `${data.error.message}${waitLine(data.error.retryAfter)}`
            : "편지를 남기지 못했습니다. 잠시 후 다시 시도해 주세요.",
        );
      } catch {
        // 네트워크 오류 — 로컬 초안 유지, 재시도 (03 실패 상태 표).
        setScreen({ kind: "form" });
        setChosenStep("review");
        setError(
          "연결이 끊겼습니다. 쓰던 글은 그대로 있으니 다시 시도해 주세요.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [mode, relationship, body, hint, question, answer, ageConfirmed],
  );

  const backToForm = () => {
    setScreen({ kind: "form" });
    setChosenStep("body");
  };

  if (screen.kind === "done") {
    return (
      <DoneScreen
        manageToken={screen.manageToken}
        letterId={screen.letterId}
        mode={screen.mode}
      />
    );
  }

  if (screen.kind === "blocked") {
    return <BlockedScreen flags={screen.flags} onRevise={backToForm} />;
  }

  if (screen.kind === "interstitial") {
    const { confirmation, flags, notice } = screen;
    return (
      <Interstitial
        flags={flags}
        {...(notice === undefined ? {} : { notice })}
        submitting={submitting}
        onRevise={backToForm}
        onForce={() => void submit(confirmation)}
      />
    );
  }

  if (step === "relationship") {
    return (
      <RelationshipStep
        onSelect={(value: Relationship) => {
          patch({ relationship: value });
          track("write_relationship_selected", { relationship: value });
          setChosenStep("body");
        }}
      />
    );
  }

  if (step === "body") {
    return (
      <BodyStep
        value={body}
        onChange={(value) => patch({ body: value })}
        onBack={() => setChosenStep("relationship")}
        onNext={() => {
          track("write_body_done", { length: body.length });
          setChosenStep("mode");
        }}
      />
    );
  }

  if (step === "mode") {
    return (
      <ModeStep
        onBack={() => setChosenStep("body")}
        onSelect={(value: LetterMode) => {
          patch({ mode: value });
          track("write_mode_selected", { mode: value });
          setChosenStep(value === "locked" ? "locked" : "review");
        }}
      />
    );
  }

  if (step === "locked") {
    return (
      <LockedStep
        hint={hint}
        question={question}
        answer={answer}
        onChange={(change) => {
          // 답만 초안에 저장하지 않는다 (draft.ts).
          if (change.answer !== undefined) setAnswer(change.answer);
          const saved: Partial<StoredDraft> = {};
          if (change.hint !== undefined) saved.hint = change.hint;
          if (change.question !== undefined) saved.question = change.question;
          if (Object.keys(saved).length > 0) patch(saved);
        }}
        onBack={() => setChosenStep("mode")}
        onNext={() => setChosenStep("review")}
      />
    );
  }

  return (
    <>
      {/* D-032 — 편지를 남기는 시점의 만 14세 확인. 열람·피드에는 붙이지 않는다.
          체크박스는 법정대리인 동의를 대체하지 않는다 — 만 14세 미만을 받지 않는다는
          표명이고, 그래서 동의 절차 대신 확인 하나만 둔다. */}
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={ageConfirmed}
          onChange={(event) => setAgeConfirmed(event.target.checked)}
          disabled={submitting}
        />
        만 14세 이상입니다
      </label>

      <ReviewStep
        submitting={submitting}
        error={error}
        onBack={() => setChosenStep(mode === "locked" ? "locked" : "mode")}
        onSubmit={() => {
          if (mode !== undefined) track("write_submit_attempt", { mode });
          void submit();
        }}
      />
    </>
  );
}
