"use client";

// 고정형 반응 — 04 §2 `reactions` · 05-api §2 `POST /api/letters/:id/react`.
//
// 피드 카드와 편지 페이지가 같은 컴포넌트를 쓴다. 두 벌이 되면 라벨과 개수 표시 규칙이
// 한쪽에서만 바뀐다.
//
// ── 화면에 뜨는 숫자는 항상 서버가 방금 센 값이다 (D-007) ────
// 눌렀을 때 개수를 클라이언트에서 +1 하지 않는다. 같은 사람이 같은 반응을 다시 누르면
// PK 제약이 삽입을 막아 **실제 행이 늘지 않는데**, 화면만 올라가면 그건 존재하지 않는
// 신호다. 그래서 응답이 돌려준 개수로 통째로 교체한다 (라우트 주석 참조).
//
// **0은 표시하지 않는다.** 네 개의 `0`이 나란히 뜨면 그 자체가 점수판으로 읽히고, 반응이
// 없다는 사실을 숫자로 강조하게 된다. 라벨만 보이고 개수는 실제로 있을 때만 붙는다 —
// 어느 쪽도 없는 값을 만들지 않는다.
//
// ── 안 하는 것 ───────────────────────────────────────────────
// · **텍스트 입력이 없다.** 자유 댓글은 v0 제외 항목이다 (01 「제외」)
// · **"이미 눌렀는지"를 새로고침 후 복원하지 않는다.** 그러려면 fp별 반응을 돌려주는
//   표면이 필요한데 05-api에 없다. 없는 엔드포인트를 만들지 않는다. 눌린 표시는 이번
//   화면에서 누른 것에만 붙고, 개수는 언제나 서버 값이라 새로고침해도 진짜 값이다

import { useState } from "react";
import {
  REACTION_KINDS,
  REACTION_LABELS,
  type ReactionCounts,
  type ReactionKind,
} from "./kinds";

/**
 * 전송이 실패했을 때만 쓰는 문구. **가설값 — 문서에 없다.**
 *
 * 아무것도 띄우지 않으면 눌렀는데 숫자가 그대로인 화면이 되고, 사용자는 자기가 이미
 * 눌렀다고 읽는다. UnlockPanel이 같은 이유로 같은 문구를 쓴다.
 */
const TRANSPORT_ERROR = "잠시 후 다시 시도해 주세요.";

export function Reactions({
  letterId,
  initial,
}: {
  letterId: string;
  initial: ReactionCounts;
}) {
  const [counts, setCounts] = useState<ReactionCounts>(initial);
  const [pressed, setPressed] = useState<ReactionKind[]>([]);
  const [pending, setPending] = useState<ReactionKind | null>(null);
  const [failed, setFailed] = useState(false);

  async function react(kind: ReactionKind): Promise<void> {
    if (pending !== null) return;
    setPending(kind);
    setFailed(false);

    try {
      const result = await fetch(`/api/letters/${letterId}/react`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!result.ok) {
        setFailed(true);
        return;
      }
      const data = (await result.json()) as { reactions?: ReactionCounts };
      // 서버가 준 개수로 통째로 교체한다. 여기서 더하지 않는다.
      if (data.reactions) setCounts(data.reactions);
      setPressed((current) =>
        current.includes(kind) ? current : [...current, kind],
      );
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      <ul className="flex flex-wrap gap-2">
        {REACTION_KINDS.map((kind) => {
          const count = counts[kind] ?? 0;
          const isPressed = pressed.includes(kind);
          return (
            <li key={kind}>
              <button
                type="button"
                aria-pressed={isPressed}
                disabled={pending !== null}
                onClick={() => void react(kind)}
                className={`rounded-full border px-3 py-1 text-sm disabled:text-gray-400 ${
                  isPressed
                    ? "border-gray-900 text-gray-900"
                    : "border-gray-300 text-gray-700 hover:border-gray-500"
                }`}
              >
                {REACTION_LABELS[kind]}
                {count > 0 && (
                  <span className="ml-1.5 text-gray-500">{count}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-gray-500">
          {TRANSPORT_ERROR}
        </p>
      )}
    </div>
  );
}
