// src/lib/safety/classifier.ts — draftReportVerdict() (07-operations §2)
//
// **판정은 사람이 한다.** 이 함수는 07 §2 판정표의 후보 행·근거·신뢰도까지만 낸다.
// 조치를 돌려주지 않고, 어디에 저장할지도 정하지 않는다 (큐 화면은 운영 표면의 일이다).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { spendDayKey } from "@/lib/safety/budget";
import { abortError, refusal, structured, stubFetch } from "./fake-openai";
import { loadClassifier } from "./load";

const letter = {
  body: "그 사람 번호를 아직 못 지웠다. 3반이었고 늘 창가에 앉았다.",
  hint: "2019년 신촌",
};

let draftReportVerdict: typeof import("@/lib/safety/classifier").draftReportVerdict;

beforeEach(async () => {
  ({ draftReportVerdict } = await loadClassifier());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await query("delete from app_settings where key like 'classifier_spend:%'");
});

describe("신고 큐 초안", () => {
  it("판정표의 행·근거·신뢰도를 돌려준다", async () => {
    stubFetch([
      () =>
        structured({
          row: "doxx",
          rationale: "본문에 학급과 좌석이 있어 소속 특정이 가능하다.",
          confidence: "medium",
        }),
    ]);

    expect(await draftReportVerdict(letter, "doxx")).toEqual({
      row: "doxx",
      rationale: "본문에 학급과 좌석이 있어 소속 특정이 가능하다.",
      confidence: "medium",
    });
  });

  it("판정표 밖의 행은 받지 않는다", async () => {
    stubFetch([
      () =>
        structured({ row: "delete_now", rationale: "삭제", confidence: "high" }),
    ]);
    expect(await draftReportVerdict(letter, "other")).toBeNull();
  });

  it("제출 경로가 아니라 지연이 무관하다 — 4초 걸려도 결과를 받는다", async () => {
    // 07 §2: 신고 처리는 제출 경로가 아니다. 등급 판정의 3초를 여기 그대로 적용하면
    // 초안이 자주 비어 운영자가 편지를 처음부터 읽게 된다.
    //
    // 스텁이 abort 신호를 실제로 지킨다 — 타임아웃이 3초였다면 여기서 잘려 null이 된다.
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                structured({
                  row: "targeting",
                  rationale: "제3자가 알아볼 수 있고 부정적이다.",
                  confidence: "low",
                }),
              ),
            4_000,
          );
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(
              Object.assign(new Error("The operation was aborted."), {
                name: "AbortError",
              }),
            );
          });
        }),
    );

    expect(await draftReportVerdict(letter, "targeting")).toEqual({
      row: "targeting",
      rationale: "제3자가 알아볼 수 있고 부정적이다.",
      confidence: "low",
    });
  });

  it("실패하면 null이다 — 초안이 없어도 신고 처리는 멈추지 않는다", async () => {
    stubFetch([abortError]);
    expect(await draftReportVerdict(letter, "targeting")).toBeNull();
  });

  it("거부해도 null이다 — 조치로 바뀌지 않는다", async () => {
    stubFetch([() => refusal()]);
    expect(await draftReportVerdict(letter, "sexual")).toBeNull();
  });

  it("상한의 85%에 닿으면 호출하지 않는다 — 등급 판정보다 먼저 꺼진다", async () => {
    await query(
      "insert into app_settings (key, value) values ($1, to_jsonb(4.3::numeric))",
      [`classifier_spend:${spendDayKey(new Date())}`],
    );
    const stub = stubFetch([
      () => structured({ row: "other", rationale: "-", confidence: "low" }),
    ]);
    expect(await draftReportVerdict(letter, "other")).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});
