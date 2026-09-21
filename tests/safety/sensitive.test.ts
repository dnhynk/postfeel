// D-033 — 식별 가능한 제3자의 민감정보는 게시 전에 차단한다.
//
// **모델을 부르지 않는다.** 재는 것은 판정 규칙이지 분류기의 탐지력이 아니다. 탐지력은
// eval/(평가셋)이 재고, 그쪽은 D-029로 모델이 바뀌면 다시 재야 한다. 여기서 고정하는
// 것은 **"층 2가 민감정보를 봤다고 말했을 때 우리가 무엇을 하는가"**이고, 그 답은
// 모델이 무엇이든 같아야 한다.
//
// 그래서 두 층위로 잰다.
//   · `grade()`에 분류기 응답을 직접 넣어 규칙 자체를 본다 (7범주 · 칸 · 판단 불가)
//   · 같은 규칙이 HTTP 표면에서도 유지되는지 본다 — 모듈 모킹은 classifier.test.ts와
//     같은 방식이다
//
// **이 규칙이 다른 규칙들과 다른 점**: D-016은 칸을 보고 등급을 가르는데, 여기는 칸도
// 보지 않고 모델이 준 `risk`도 보지 않는다. 민감정보 플래그가 있으면 그것으로 끝이다.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifierOutcome, Layer1Result } from "@/lib/safety/types";

const stub = vi.hoisted(() => ({
  layer1: { risk: "low", flags: [] } as Layer1Result,
  classifier: { state: "ok", risk: "low", flags: [] } as ClassifierOutcome,
}));

vi.mock("@/lib/safety/layer1", () => ({
  runLayer1: () => stub.layer1,
}));

vi.mock("@/lib/safety/classifier", () => ({
  classify: async () => stub.classifier,
  generateAnswerVariants: async () => [],
}));

import { POST } from "@/app/api/letters/route";
import { query } from "@/lib/db";
import { grade } from "@/lib/safety/grade";
import { SENSITIVE_KINDS } from "@/lib/safety/types";
import type { Flag, FlagField } from "@/lib/safety/types";

const clean: Layer1Result = { risk: "low", flags: [] };

/** 층 2가 "민감정보를 봤다"고 말한 응답. **등급은 일부러 `low`로 준다** — 판정이 모델의
 *  risk 값이 아니라 플래그에 걸려 있어야 한다. */
function sawSensitive(
  kind: (typeof SENSITIVE_KINDS)[number],
  field: FlagField = "body",
): ClassifierOutcome {
  return { state: "ok", risk: "low", flags: [{ kind, field }] };
}

function post(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/letters", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vitest",
      "x-forwarded-for": "198.51.100.30",
    },
    // `ageConfirmed`는 D-032(안전 테스트 29)가 요구하는 값이다. 그 규칙이 없던 시절의
    // 라우트는 모르는 키를 무시하므로 어느 쪽에서도 이 요청은 형식으로 막히지 않는다.
    body: JSON.stringify({ ageConfirmed: true, ...payload }),
  });
}

/** 제3자의 건강 이야기를 담은 편지 — 실제 판정은 위 스텁이 준다. 문장은 지어낸 것이다. */
const LETTER = {
  mode: "open",
  relationship: "friend",
  body: "네가 그 겨울에 오래 앓았다는 걸 나만 알고 있었지. 그때 더 묻지 못한 게 남는다.",
} as const;

const PLAIN_LETTER = {
  mode: "open",
  relationship: "friend",
  body: "그때 하지 못한 말을 여기 남긴다. 잘 지내고 있으면 좋겠어.",
} as const;

async function letters(): Promise<Array<{ risk_level: string; status: string }>> {
  const { rows } = await query<{ risk_level: string; status: string }>(
    "select risk_level, status from letters",
  );
  return rows;
}

async function filterEvents(): Promise<
  Array<{ outcome: string; risk_level: string }>
> {
  const { rows } = await query<{ outcome: string; risk_level: string }>(
    "select outcome, risk_level from filter_events order by id",
  );
  return rows;
}

beforeEach(async () => {
  stub.layer1 = { risk: "low", flags: [] };
  stub.classifier = { state: "ok", risk: "low", flags: [] };
  await query("delete from letters");
  await query("delete from filter_events");
  await query("delete from events");
});

// docs/00-decisions.md D-033 · docs/02-threat-model.md §2 · src/lib/safety/grade.ts
describe("safety#30 · 식별 가능한 제3자의 민감정보는 게시 전에 차단된다", () => {
  // ── 규칙 (grade.ts) ─────────────────────────────────────

  it.each(SENSITIVE_KINDS)(
    "%s — 분류기가 low라고 해도 high 차단이다",
    (kind) => {
      const decision = grade(clean, sawSensitive(kind));

      expect(decision.action).toBe("block");
      expect(decision.risk).toBe("high");
    },
  );

  it("칸을 가리지 않는다 — 본문이든 단서든 질문이든 high다", () => {
    // D-016(학교·회사)은 본문이면 medium이다. 민감정보는 그 낙차가 없다: `medium`의
    // 실제 처리인 '피드 제외'가 공유 링크로 도는 편지에는 방어가 되지 못한다.
    for (const field of ["body", "hint", "question"] as const) {
      const decision = grade(clean, sawSensitive("sensitive_health", field));
      expect(decision.action, `${field} 칸`).toBe("block");
      expect(decision.risk, `${field} 칸`).toBe("high");
    }
  });

  it("식별 요소가 하나도 안 걸려도 차단이다 — 판단이 불가능하면 게시하지 않는다", () => {
    // 이름·학교·연락처가 함께 왔을 때만 막으면 `너`·`그 사람`으로만 지목한 편지가
    // 전부 빠져나간다. 식별 가능성 판단이 서지 않는 쪽이 오히려 흔하다.
    const decision = grade(clean, sawSensitive("sensitive_crime"));

    expect(decision.flags).toEqual([{ kind: "sensitive_crime", field: "body" }]);
    expect(decision.action).toBe("block");
  });

  it("인터스티셜로 새지 않는다 — `이대로 올리기`가 붙는 등급이 아니다", () => {
    const decision = grade(clean, {
      state: "ok",
      risk: "medium",
      flags: [
        { kind: "place_time_combo", field: "body" },
        { kind: "sensitive_belief", field: "body" },
      ],
      notice: "본문에 다시 볼 표현이 있습니다.",
    });

    // medium이었다면 confirm이고, confirm에는 confirmation 토큰이 붙는다.
    expect(decision.action).not.toBe("confirm");
    expect(decision.action).toBe("block");
    // high는 저장 경로로 가지 않으므로 letters에 쓸 값 자체가 결정에 없다 (04 §2).
    expect("classifierState" in decision).toBe(false);
  });

  it("민감정보가 없으면 기존 판정 그대로다 — 규칙이 다른 등급을 삼키지 않는다", () => {
    const decision = grade(
      clean,
      { state: "ok", risk: "medium", flags: [{ kind: "place_time_combo", field: "body" }] },
    );

    expect(decision.action).toBe("confirm");
    expect(decision.risk).toBe("medium");
  });

  it("층 1이 낸 민감정보 플래그도 같다 — 어느 층이 냈는지로 갈리지 않는다", () => {
    // 층 1에는 아직 이 kind를 낼 규칙이 없다. 나중에 붙는 날 조용히 빠지지 않게 고정한다.
    const layer1: Layer1Result = {
      risk: "low",
      flags: [{ kind: "sensitive_sexlife", field: "hint" } satisfies Flag],
    };

    expect(grade(layer1, { state: "ok", risk: "low", flags: [] }).action).toBe(
      "block",
    );
  });

  // ── 같은 규칙이 HTTP 표면에서도 유지되는가 ────────────────

  it("제출하면 200 blocked이고 letters에 행이 없다 — 원문이 서버에 남지 않는다", async () => {
    stub.classifier = sawSensitive("sensitive_health");

    const response = await POST(post(LETTER));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("blocked");
    expect(body.risk).toBe("high");
    // `이대로 올리기`를 누를 수단 자체가 없다 (02 §3 · 안전 테스트 3).
    expect(body).not.toHaveProperty("confirmation");

    expect(await letters()).toEqual([]);
    expect(await filterEvents()).toEqual([
      { outcome: "blocked", risk_level: "high" },
    ]);
  });

  it("다른 편지에서 받은 confirmation으로도 밀어 넣을 수 없다", async () => {
    // 인터스티셜을 한 번 통과해 토큰을 받아 두고, 그 토큰으로 민감정보 편지를 낸다.
    // 토큰은 그 편지의 내용에 묶여 있으므로(05-api §1 5단계) 재판정 경로로 떨어진다.
    stub.classifier = {
      state: "ok",
      risk: "medium",
      flags: [{ kind: "place_time_combo", field: "body" }],
    };
    const warned = (await (await POST(post(PLAIN_LETTER))).json()) as {
      status: string;
      confirmation: string;
    };
    expect(warned.status).toBe("needs_confirmation");

    stub.classifier = sawSensitive("sensitive_politics");
    const response = await POST(
      post({ ...LETTER, confirmation: warned.confirmation }),
    );

    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, unknown>).status).toBe(
      "blocked",
    );
    expect(await letters()).toEqual([]);
  });
});
