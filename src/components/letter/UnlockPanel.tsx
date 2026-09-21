"use client";

// B 모드 잠금 화면의 **움직이는 부분** — 03 흐름 2.
//
//   입력 → 제출 → (오답: 남은 시도 갱신 / 정답: 본문 → 수신자 응답 → 이어가기)
//
// 정적인 부분(🔒 · 단서 · 관계·시각 · 질문)은 `LockScreen`이 그대로 넘겨준다. 여기가
// 클라이언트 컴포넌트인 이유는 **해제 직후 화면이 클라이언트 상태여야 하기 때문**이다:
// `unlockId`는 HttpOnly 쿠키로만 내려가므로(05-api §2) 새로고침하면 스크립트가 그 값을
// 잃고, 그러면 `POST /api/unlocks/:unlockId/response`를 부를 수 없다. 그 응답이
// **북극성 지표의 유일한 수집 지점**이다 (01 「북극성 지표」).
//
// ── 이 화면이 지키는 규칙 ────────────────────────────────────
//
// 1. **오답에 대해 아무 말도 하지 않는다** (S-6). 서버 응답에 message가 없고, 여기서도
//    문구를 만들지 않는다. 바뀌는 것은 "남은 시도 N번" 숫자뿐이다 — 03 흐름 2가
//    보여주기로 한 유일한 값이고, 브루트포서에게는 이미 알려진 정보다.
// 2. **본문을 먼저 보여주고 다 읽은 뒤에 묻는다** (03 흐름 2). 질문은 본문 아래에 있다.
//    읽기 전에 띄우면 방해가 되고 응답도 부정확해진다.
// 3. **`<form>`으로 감싸지 않는다.** action 없는 form은 GET으로 제출돼 답이 URL·브라우저
//    기록·서버 로그에 실린다 (P2가 남긴 주석 · S-6). JS가 아직 안 붙은 상태에서도
//    그렇게 되면 안 되므로 form 자체를 두지 않는다.

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { track } from "@/lib/analytics/client";
import type { LockedLetterResponse } from "@/lib/letters/read";
import type { RecipientResponse } from "@/lib/unlock/unlocks";

/** 03 흐름 2의 버튼 문구 그대로. 순서도 문서 그대로다. */
const RESPONSE_CHOICES: ReadonlyArray<{
  value: RecipientResponse;
  label: string;
}> = [
  { value: "yes", label: "나에게 온 것 같아요" },
  { value: "no", label: "아닌 것 같아요" },
  { value: "unknown", label: "모르겠어요" },
];

/**
 * 전송 자체가 실패했을 때만 쓰는 문구. **가설값이다 — 문서에 없다.**
 *
 * 서버가 응답을 준 경우에는 그 응답의 `error.message`를 그대로 보여준다(05-api §6:
 * "사용자에게 그대로 보여줄 한국어"). 여기 문구가 필요한 경우는 응답 자체가 오지 않은
 * 때뿐이다. 아무것도 띄우지 않으면 버튼을 눌러도 화면이 그대로라 사용자가 자기 답이
 * 틀렸다고 읽는다 — 그게 S-6이 막으려는 것보다 나쁜 오해다.
 */
const TRANSPORT_ERROR = "잠시 후 다시 시도해 주세요.";

interface Unlocked {
  body: string;
  unlockId: string;
}

export function UnlockPanel({
  letter,
  children,
}: {
  letter: LockedLetterResponse;
  /** 잠금 화면의 정적인 부분. 해제되면 본문으로 교체된다. */
  children: ReactNode;
}) {
  const [answer, setAnswer] = useState("");
  const [attemptsRemaining, setAttemptsRemaining] = useState(
    letter.attemptsRemaining,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [response, setResponse] = useState<RecipientResponse | null>(null);

  const exhausted = attemptsRemaining === 0;

  async function submit(): Promise<void> {
    if (submitting || exhausted || answer.trim() === "") return;
    setSubmitting(true);
    setError(null);

    try {
      const result = await fetch(`/api/letters/${letter.id}/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      const data: unknown = await result.json();
      apply(data);
    } catch {
      setError(TRANSPORT_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  function apply(data: unknown): void {
    const payload = data as {
      status?: string;
      body?: string;
      unlockId?: string;
      attemptsRemaining?: number;
      error?: { message?: string };
    };

    // `unlock_attempt` · `unlock_success`는 **여기서 보내지 않는다.** 둘 다 서버
    // 이벤트다(analytics/events.ts) — 시도 번호와 성공 여부를 클라이언트가 보낼 수 있으면
    // 위조할 수 있고, 위조 가능한 숫자는 주간 리뷰에서 아무 의미가 없다. 기록하는 자리는
    // `POST /api/letters/:id/unlock`이고, 거기가 `attemptNo`의 유일한 진실이다.
    if (payload.status === "unlocked" && payload.unlockId) {
      setUnlocked({ body: payload.body ?? "", unlockId: payload.unlockId });
      return;
    }
    if (payload.status === "wrong") {
      // 문구를 붙이지 않는다. 숫자만 바뀐다 (S-6).
      setAttemptsRemaining(payload.attemptsRemaining ?? 0);
      setAnswer("");
      return;
    }
    if (payload.status === "rate_limited") {
      // 시도가 남아 있는데 막힌 경우(letter·fp 전역 한도)도 여기로 온다. 화면에서는
      // 둘을 구분하지 않는다 — 지금 더 시도할 수 없다는 사실은 같다.
      setAttemptsRemaining(0);
      return;
    }
    setError(payload.error?.message ?? TRANSPORT_ERROR);
  }

  function choose(value: RecipientResponse): void {
    if (!unlocked || response) return;
    // 화면을 먼저 넘긴다. 기록이 실패해도 사용자를 버튼 앞에 세워두지 않는다 —
    // 다시 누를 수 있는 화면이 아니라 이미 답한 화면이다.
    setResponse(value);
    // `recipient_response`도 서버 이벤트다 — 아래 요청을 받은
    // `POST /api/unlocks/:unlockId/response`가 **실제로 기록됐을 때만** 남긴다. 여기서
    // 보내면 이미 응답한 건에 다시 눌러도 이벤트가 쌓여 주간 지표 #4의 분모가 부푼다.
    void fetch(`/api/unlocks/${unlocked.unlockId}/response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: value }),
    }).catch(() => {
      // 지표 한 건이 빠지는 것보다 화면이 멈추는 쪽이 나쁘다.
    });
  }

  // `unlock_view { relationship }` (06 §3) — 잠금 화면을 실제로 본 건. 열람 퍼널(06 §4)의
  // 두 번째 칸이다. 이 패널은 미해제 잠긴 편지에서만 렌더되므로 마운트가 곧 그 사건이다.
  // 편지 ID는 담지 않는다 (06 §2).
  const viewSent = useRef(false);
  useEffect(() => {
    if (viewSent.current) return;
    viewSent.current = true;
    track("unlock_view", { relationship: letter.relationship });
  }, [letter.relationship]);

  if (unlocked) {
    return (
      <article className="rounded-lg border border-gray-200 p-6">
        <p className="whitespace-pre-wrap break-words text-lg leading-relaxed text-gray-900">
          {unlocked.body}
        </p>

        <hr className="my-6 border-gray-200" />

        {response === null ? (
          <div>
            <p className="text-gray-900">이 편지, 당신에게 온 것 같나요?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {RESPONSE_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => choose(choice.value)}
                  className="rounded-md border border-gray-900 px-4 py-2 text-sm text-gray-900"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <AfterResponse response={response} />
        )}
      </article>
    );
  }

  return (
    <article className="rounded-lg border border-gray-200 p-6">
      {children}

      <div className="mt-3 flex gap-2">
        <label htmlFor="answer" className="sr-only">
          답
        </label>
        <input
          id="answer"
          name="answer"
          type="text"
          autoComplete="off"
          value={answer}
          disabled={exhausted || submitting}
          onChange={(event) => setAnswer(event.target.value)}
          // 엔터로도 제출한다. form이 아니므로 기본 동작이 없다.
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 disabled:bg-gray-100"
        />
        <button
          type="button"
          disabled={exhausted || submitting}
          onClick={() => void submit()}
          className="rounded-md border border-gray-900 px-4 py-2 text-sm text-gray-900 disabled:border-gray-300 disabled:text-gray-400"
        >
          열어보기
        </button>
      </div>

      {/* 오답에는 문구가 없다. 여기 나오는 것은 전송·서버 오류뿐이다 (05-api §6). */}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-gray-500">
          {error}
        </p>
      )}

      <p className="mt-2 text-right text-sm text-gray-500">
        남은 시도 {attemptsRemaining}번
      </p>
    </article>
  );
}

/**
 * 응답 뒤 화면 — 03 흐름 2 「"아닌 것 같아요"가 가장 흔한 결과다」.
 *
 * **여기서 나가면 루프가 끊긴다.** 잠긴 편지를 여는 사람 대부분은 의도한 수신자가
 * 아니라서, 이 화면의 성능이 곧 06-analytics의 `post_unlock_continue`·`post_unlock_exit`다.
 *
 * 문구는 `no`에만 붙는다 — 03 흐름 2가 그 경우의 문구만 정했다. 이어가기 버튼 두 개는
 * 응답과 무관하게 보여준다: 두 이벤트의 props가 `{ response }`라 세 값 모두에서 이
 * 화면이 존재한다는 뜻이다 (06-analytics §3).
 */
function AfterResponse({ response }: { response: RecipientResponse }) {
  // 이어갔는가. 이어갔으면 이탈이 아니다 — 둘 다 세면 퍼널 3의 분자와 분모가 겹친다.
  const continued = useRef(false);

  // `post_unlock_exit { response }` (06 §3). **서버가 볼 수 없는 사건이다** — 이어가기를
  // 누르지 않고 나간 것은 요청이 아예 없다는 뜻이라, 관측 지점이 여기밖에 없다.
  //
  // `pagehide`를 쓴다. 이어가기 버튼은 `next/link` 소프트 내비게이션이라 이 이벤트가
  // 돌지 않고(그때는 아래 `leave`가 이미 continue를 보냈다), 탭을 닫거나 뒤로 가거나
  // 주소창으로 떠날 때만 돈다. `track`이 keepalive라 언로드에 잘려나가지 않는다.
  //
  // **한계**: 탭 전환(`visibilitychange`)은 이탈로 세지 않는다. 돌아오는 사람까지 이탈로
  // 세면 이 화면의 성능이 실제보다 나빠 보인다. 브라우저가 `pagehide`를 주지 않는
  // 경우(강제 종료 등)는 누락된다 — 이탈이 실제보다 적게 잡히는 쪽이다.
  useEffect(() => {
    const onHide = () => {
      if (continued.current) return;
      track("post_unlock_exit", { response });
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [response]);

  function leave(target: "feed" | "write"): void {
    continued.current = true;
    track("post_unlock_continue", { response, target });
  }

  return (
    <div>
      {response === "no" && (
        <p className="text-gray-900">
          그럼 이 편지는 아직 주인을 기다리는 중이에요.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href="/"
          onClick={() => leave("feed")}
          className="rounded-md border border-gray-900 px-4 py-2 text-sm text-gray-900"
        >
          다른 편지 보기
        </Link>
        {/* 03 「화면 목록」의 작성 화면. 그 표면은 다른 워커가 만든다. */}
        <Link
          href="/write"
          onClick={() => leave("write")}
          className="rounded-md border border-gray-900 px-4 py-2 text-sm text-gray-900"
        >
          나도 남기기
        </Link>
      </div>
    </div>
  );
}
