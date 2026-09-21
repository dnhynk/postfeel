// 판정 전 보류 — D-035 · docs/05-api.md §2 「상태별 표면 응답」
//
// D-033이 "판단이 불가능한 경우에도 게시하지 않는다"고 했는데 민감정보를 볼 수 있는
// 층은 층 2뿐이다. 층 2가 죽은 동안 D-015의 강등 경로로 게시하면 그 범주에 한해
// D-033이 성립하지 않는다.
//
// **`medium`이 피드에서 빠지는 것으로는 부족하다.** 강등된 편지는 피드에만 안 뜨고
// 직접 링크로는 읽히는데, 이 서비스의 유통은 애초에 링크 공유다(D-006). 그래서
// 여기서 재는 것은 피드가 아니라 **직접 경로 전부**다.

import { describe, expect, it } from "vitest";
import { GET as getLetterRoute } from "@/app/api/letters/[id]/route";
import { POST as react } from "@/app/api/letters/[id]/react/route";
import { POST as unlock } from "@/app/api/letters/[id]/unlock/route";
import { GET as manageGet } from "@/app/api/manage/[token]/route";
import type { ManageView } from "@/lib/letters/manage";
import { insertLetter, sha256 } from "../fixtures/letters.ts";

/** 판정이 안 끝난 두 상태. 둘 다 보류다 — `failed`는 자동으로 풀리지도 않는다. */
const UNJUDGED = ["unavailable", "failed"] as const;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const fetchLetter = (id: string) =>
  getLetterRoute(new Request(`http://localhost/api/letters/${id}`), params(id));

const fetchReact = (id: string) =>
  react(
    new Request(`http://localhost/api/letters/${id}/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "same" }),
    }),
    params(id),
  );

const fetchUnlock = (id: string, answer: string) =>
  unlock(
    new Request(`http://localhost/api/letters/${id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    }),
    params(id),
  );

// docs/05-api.md §7 #31 · docs/00-decisions.md D-035
describe("safety#31 · 판정이 끝나지 않은 편지는 어디서도 읽히지 않는다", () => {
  it("직접 조회가 404다 — 두 상태 모두", async () => {
    for (const classifierState of UNJUDGED) {
      const { letter } = await insertLetter({
        classifierState,
        riskLevel: "medium",
      });
      const response = await fetchLetter(letter.id);
      // 403이 아니라 404다. 403은 편지의 존재를 확인해준다 (05-api §2).
      expect(response.status).toBe(404);
    }
  });

  it("피드에 뜨지 않는다", async () => {
    for (const classifierState of UNJUDGED) {
      const { letter } = await insertLetter({
        classifierState,
        riskLevel: "medium",
      });
      const { rows } = await import("@/lib/db").then((db) =>
        db.query<{ id: string }>(
          `select id from letters
            where id = $1 and status = 'published' and risk_level = 'low'`,
          [letter.id],
        ),
      );
      expect(rows).toHaveLength(0);
    }
  });

  it("반응을 달 수 없다", async () => {
    for (const classifierState of UNJUDGED) {
      const { letter } = await insertLetter({ classifierState });
      expect((await fetchReact(letter.id)).status).toBe(404);
    }
  });

  it("잠긴 편지를 열 수 없다 — 답이 맞아도", async () => {
    // 답이 맞는데도 404여야 한다. 여기서 200이 나오면 보류가 열람 경로만 못 막은 것이다.
    for (const classifierState of UNJUDGED) {
      const { letter } = await insertLetter({
        mode: "locked",
        classifierState,
        hint: "우리가 자주 가던 곳",
        question: "그 카페 이름은?",
        answerHmac: sha256("스타벅스"),
      });
      expect((await fetchUnlock(letter.id, "스타벅스")).status).toBe(404);
    }
  });

  it("작성자에게는 보류 중이라고 말한다 — 관리 화면은 열린다", async () => {
    // 말하지 않으면 작성자가 자기 링크를 열어보고 404를 만나 편지가 사라진 줄 안다.
    const { letter, manageToken } = await insertLetter({
      classifierState: "unavailable",
      riskLevel: "medium",
    });

    const response = await manageGet(
      new Request(`http://localhost/api/manage/${manageToken}`),
      { params: Promise.resolve({ token: manageToken }) },
    );
    expect(response.status).toBe(200);
    const view = (await response.json()) as ManageView;
    expect(view.id).toBe(letter.id);
    expect(view.pendingReview).toBe(true);
  });

  it("판정이 끝나면(`ok`) 그때 읽힌다", async () => {
    // 반대 방향 단언. 이게 없으면 "전부 404"가 위 단언을 전부 통과한다.
    const { letter } = await insertLetter({ classifierState: "ok" });
    expect((await fetchLetter(letter.id)).status).toBe(200);
  });
});
