// 분류기 테스트용 스텁. **HTTP 레이어에 둔다.**
//
// classifier.ts를 통째로 mock 하면 우리가 실제로 확인해야 하는 것 — Responses API 응답을
// 우리가 제대로 읽는가, 거부를 장애와 구분하는가 — 이 통째로 빠진다. 그래서 스텁은
// `fetch`에 두고 openai SDK는 진짜를 쓴다.
//
// 응답 형태의 출처: https://developers.openai.com/api/docs/guides/structured-outputs
// (거부는 `output[].content[]`의 `type: 'refusal'` 항목)
//
// **CI에서 실제 API를 부르지 않는다.** `.env.test`의 `OPENAI_API_KEY`는 비어 있고,
// 테스트는 `vi.stubEnv`로 가짜 키를 넣은 뒤 이 스텁이 모든 요청을 받는다.

import { vi } from "vitest";

export interface OpenAiUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: { cached_tokens: number };
}

const DEFAULT_USAGE: OpenAiUsage = {
  input_tokens: 1_000,
  output_tokens: 50,
  input_tokens_details: { cached_tokens: 0 },
};

function envelope(
  output: unknown[],
  status: string,
  usage: OpenAiUsage,
): unknown {
  return {
    id: "resp_stub",
    object: "response",
    created_at: 1_700_000_000,
    model: "gpt-5.6-luna",
    status,
    output,
    usage,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 스키마대로 온 정상 응답. `payload`가 그대로 `output_text`가 된다. */
export function structured(
  payload: unknown,
  usage: OpenAiUsage = DEFAULT_USAGE,
): Response {
  return json(
    envelope(
      [
        {
          id: "msg_stub",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(payload),
              annotations: [],
            },
          ],
        },
      ],
      "completed",
      usage,
    ),
  );
}

/** 모델 거부. 스키마 대신 `refusal` 항목이 온다 (D-020 · 05-api §1). */
export function refusal(
  message = "죄송하지만 도와드릴 수 없습니다.",
  usage: OpenAiUsage = DEFAULT_USAGE,
): Response {
  return json(
    envelope(
      [
        {
          id: "msg_stub",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: message }],
        },
      ],
      "completed",
      usage,
    ),
  );
}

/**
 * `max_output_tokens`에 걸려 잘린 응답 (추론 가이드).
 *
 * 인자를 받지 않는다 — `stubFetch([incomplete])`처럼 핸들러 자리에 그대로 넘길 수 있게.
 */
export function incomplete(): Response {
  return json(envelope([], "incomplete", DEFAULT_USAGE));
}

/**
 * SDK가 타임아웃으로 인식하는 오류.
 *
 * `internal/errors.mjs`의 `isAbortError`가 `name === 'AbortError'`를 보고
 * `APIConnectionTimeoutError`로 바꾼다. 실제 3초를 기다리지 않고 그 분기를 태운다.
 */
export function abortError(): never {
  throw Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });
}

/** 연결 자체가 실패한 경우. undici가 내는 형태와 같다. */
export function networkError(): never {
  throw new TypeError("fetch failed");
}

/**
 * 응답하지 않고 abort 신호만 기다리는 핸들러.
 *
 * SDK가 `timeout` 뒤에 controller를 abort 하는 것이 **실제로** 동작하는지 본다. 위
 * `abortError`가 매핑만 확인하는 것과 달리 이건 시계를 실제로 쓴다. 핸들러 자리에 그대로
 * 넣을 수 있어 `stubFetch([networkError, hang])`처럼 회차마다 다른 실패를 조합할 수 있다.
 */
export function hang(
  _body: Record<string, unknown>,
  signal?: AbortSignal | null,
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(
        Object.assign(new Error("The operation was aborted."), {
          name: "AbortError",
        }),
      );
    });
  });
}

/**
 * `ms`를 쓰고 나서 연결 오류를 내는 핸들러.
 *
 * **타임아웃보다 짧은 `ms`를 준다.** 총 예산이 남은 시간만큼 다음 회차를 자르는지 보려면
 * "느리지만 타임아웃은 아닌 실패"가 필요하다.
 */
export function slowNetworkError(ms: number): FetchHandler {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    throw new TypeError("fetch failed");
  };
}

/**
 * 응답을 돌려주거나 던진다. 즉시 끝나지 않아도 되므로 Promise도 받는다 — `hang`처럼
 * 시계를 쓰는 핸들러가 여기 들어온다.
 */
export type FetchHandler = (
  body: Record<string, unknown>,
  signal?: AbortSignal | null,
) => Response | Promise<Response>;

export interface FetchStub {
  /** 실제로 나간 요청 본문들. 호출 횟수가 곧 `calls.length`다. */
  calls: Record<string, unknown>[];
}

/**
 * `fetch`를 스텁으로 갈아끼운다.
 *
 * 핸들러는 호출 순서대로 쓰이고, 다 쓰면 **마지막 핸들러가 반복된다** — 재시도가 같은
 * 실패를 다시 받는 상황이 기본값이라는 뜻이다.
 */
export function stubFetch(handlers: FetchHandler[]): FetchStub {
  const stub: FetchStub = { calls: [] };
  let index = 0;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    stub.calls.push(
      JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
    );
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    if (!handler) throw new Error("핸들러가 없다.");
    return handler(stub.calls[stub.calls.length - 1]!, init.signal);
  });
  return stub;
}

/** 모든 회차가 매달리는 `fetch`. `stubFetch([hang])`과 같다. */
export function stubHangingFetch(): FetchStub {
  return stubFetch([hang]);
}
