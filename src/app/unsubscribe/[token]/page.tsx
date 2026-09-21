// `/unsubscribe/:token` — 알림 해지 결과 (03 화면 목록 · 09 §1).
//
// ── 확인 화면이 없다 ────────────────────────────────────────
// 09 §1: "로그인 없이 클릭 1회로 `author_contacts` 행 삭제 + 주소 해시를 억제 목록에
// 기록. 확인 화면 없음." 그래서 이 페이지는 **열리는 순간 해지가 끝나 있고 결과만
// 보여준다.** 이 화면을 보는 사람 중에는 우리 서비스를 쓴 적 없는, 누군가 자기 주소를
// 잘못 적어서 메일을 받은 사람이 있다 — 그 사람에게 "정말 끄시겠습니까?"를 한 번 더
// 묻는 것은 요청한 적 없는 메일에 대해 절차를 요구하는 것이다.
//
// **서버 컴포넌트가 직접 처리한다.** 클라이언트에서 fetch로 부르면 자바스크립트가
// 꺼져 있거나 메일 클라이언트의 내장 브라우저가 막을 때 해지가 안 된다. 해지는 실패하면
// 안 되는 경로다.
//
// **감수하는 위험**: 링크를 여는 행위가 곧 해지라, 메일 클라이언트나 보안 스캐너가 링크를
// 미리 열면 사용자가 누르지 않아도 해지된다. 09 §1이 "클릭 1회 · 확인 화면 없음"을 명시적으로
// 택했고(잘못 받은 사람의 부담을 0으로 만드는 것이 우선), 그 대가로 이 오작동을 감수한다.
//
// **noindex.** 랜덤 토큰이라 크롤러가 도달할 경로는 없지만, 도달하면 그 접근이 곧 해지다.

import type { Metadata } from "next";
import { isEmailKind } from "@/lib/notify/email";
import { unsubscribeByToken } from "@/lib/notify/suppression";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "알림 해지",
  robots: { index: false },
};

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  // 09 §5 `email_unsubscribed { kind }` — 어느 메일의 링크로 껐는가. 링크에 없거나 모르는
  // 값이면 null로 넘긴다. 추측해서 채우면 지표가 거짓이 된다.
  const { k } = await searchParams;
  const kind = isEmailKind(k) ? k : null;

  const result = await unsubscribeByToken(token, kind);

  return (
    <main className="mx-auto max-w-md p-6">
      {result === "unsubscribed" ? (
        <>
          <h1 className="text-lg font-semibold">알림을 껐습니다.</h1>
          <p className="mt-4">이 주소로는 더 이상 메일을 보내지 않습니다.</p>
          <p className="mt-2 text-sm text-neutral-600">
            편지를 쓴 적이 없는데 메일을 받으셨다면, 누군가 이 주소를 잘못 적은
            것입니다. 이 주소가 다시 등록되지 않도록 기록해 두었습니다 — 주소
            자체는 저장하지 않고 대조용 해시만 남깁니다.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-semibold">이미 해지된 링크입니다.</h1>
          <p className="mt-4">
            이 링크로는 더 해지할 것이 없습니다. 이미 해지되었거나 더 이상 유효하지
            않은 링크입니다.
          </p>
        </>
      )}
    </main>
  );
}
