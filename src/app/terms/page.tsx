// `/terms` — 이용약관 (03 「화면 목록」).
//
// ══════════════════════════════════════════════════════════════
//  ⚠ 법률 검토 전 초안이다.
//
//  **2026-08-16 · L-001 · L-002 · L-006 · L-007의 답이 왔다** (00 「M0 답」 · D-027~D-034).
//  L-002(§2 최소 연령)는 코드와 함께 갱신했다. 나머지는 아직이다 — 답이 요구하는 동작이
//  구현되기 전이기 때문이다. 이 문서는 여전히 **지금 코드가 실제로 하는 일만** 적고 있다.
//
//  **화면 문구를 코드보다 먼저 고치지 않는다.** 남은 항목도 같다 — 동작이 바뀌는 커밋에서
//  같이 고친다. 먼저 고치면 그 순간 이 문서가 거짓이 된다.
//
//  **M7에서 코드와 함께 바뀌는 곳** (08 M7-6):
//    · §3 금지 목록 .... 식별 가능한 제3자의 민감정보 (D-033)
//    · 삭제 문구 ....... "삭제"는 실제 완전 파기일 때만 쓴다 (D-027).
//                        임시 차단 · 법정 보존과 말을 구분한다
//    · 신설 ............ 면책 · 준거법 · 관할 · 분쟁 해결 · 변경 고지 절차 · 시행일
//
//  **화면에는 "초안입니다"라고 쓰지 않는다.** 이용자에게 보이는 약관이 스스로를 초안이라
//  부르면 그것대로 신뢰를 깎고, 초안이라는 사실은 이용자가 할 수 있는 일을 바꾸지 않는다.
//  경고는 여기(소스)와 PR 본문에 남긴다.
//
//  **모르는 것을 채우지 않는다.** 면책 범위 · 준거법 · 관할 · 분쟁 해결 · 시행일은 전부
//  L-001의 답이 필요한 항목이라 여기에 없다. 지어낸 조항 하나가 없는 조항보다 나쁘다.
// ══════════════════════════════════════════════════════════════
//
// 아래 문장은 전부 근거가 있다:
//   · 최소 연령 만 14세 — D-032 (작성·이메일 등록에서 확인하고 서버가 검증한다.
//     열람에는 붙지 않는다). 체크박스 문구는 03 흐름 1-6과 같다
//   · 무기한 보관 · 자동 파기 없음 — D-024 · 04 §3 「만료 상태가 없다」
//   · 삭제 경로 3종 — 04 §3 · 07 §5
//   · 작성자 미검증 — 02 S-3 (피드에도 같은 문장이 항상 떠 있다)
//   · 신고 1건 즉시 비공개 · 이의 제기 — 02 §4 · 04 §5 발견 2
//   · 금지 행위 목록 — 04 §2 `reports.reason`의 실제 값 7종

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "이용약관",
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">이용약관</h1>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">1. 이 서비스는 무엇인가</h2>
        <p className="mt-2 text-gray-700">
          PostFeel은 보내지 못한 말을 공개된 벽에 남겨두는 서비스입니다. 계정이
          없고, 로그인하지 않습니다. 편지는 누구나 읽을 수 있는 &lsquo;열린
          편지&rsquo;와, 단서와 질문의 답을 맞힌 사람만 열 수 있는 &lsquo;잠긴
          편지&rsquo; 두 가지입니다.
        </p>
        <p className="mt-2 text-gray-700">
          이 서비스는 특정한 사람에게 편지를 전달하지 않습니다. 우리는 어떤
          경우에도 이 서비스를 쓰지 않는 사람에게 먼저 연락하지 않습니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">2. 최소 연령</h2>
        <p className="mt-2 text-gray-700">
          만 14세 이상만 이용할 수 있습니다.
        </p>
        <p className="mt-2 text-gray-700">
          편지를 남길 때와 이메일 주소를 남길 때, 만 14세 이상이라는 확인에 직접
          체크해야 합니다. <strong>체크하지 않으면 편지를 남길 수 없고 주소도
          저장하지 않습니다.</strong> 편지를 읽기만 할 때는 아무것도 묻지 않습니다.
        </p>
        <p className="mt-2 text-gray-700">
          계정이 없어 나이를 대조할 수단이 없으므로, 이 확인은 스스로 적는 값이고
          법정대리인의 동의를 대신하지 않습니다. 만 14세 미만이 쓴 편지라는 사실을
          알게 되면 그 편지와 등록된 이메일 주소, 접속 정보에서 만든 식별값을
          지웁니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">3. 쓰면 안 되는 것</h2>
        <p className="mt-2 text-gray-700">
          아래는 신고 대상이고, 확인되면 편지를 비공개 처리합니다.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-700">
          <li>다른 사람의 신상 정보(이름 · 연락처 · 주소 · 직장 등) 노출</li>
          <li>특정인을 알아볼 수 있게 지목해 비난하거나 괴롭히는 글</li>
          <li>다른 사람을 사칭하는 글</li>
          <li>
            성적인 내용. 특히 미성년자와 관련된 성적 표현은 신고 여부와 관계없이
            즉시 차단합니다
          </li>
          <li>자해 · 자살을 부추기는 글</li>
          <li>광고 · 스팸</li>
        </ul>
        <p className="mt-2 text-gray-700">
          작성 전에 자동 검사가 한 번 돌고, 위험하다고 판단되면 경고를 띄우거나
          게시를 막습니다. 이 검사는 완전하지 않습니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">4. 작성자를 검증하지 않습니다</h2>
        <p className="mt-2 text-gray-700">
          계정이 없으므로 누가 썼는지 확인할 방법이 없습니다. 편지에 적힌
          내용이 사실인지, 작성자가 스스로 밝힌 사람이 맞는지 우리는 알지
          못합니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">5. 편지는 얼마나 남아 있나</h2>
        <p className="mt-2 text-gray-700">
          <strong>기한 없이 남습니다.</strong> 시간이 지나도 자동으로 사라지지
          않습니다. 편지가 없어지는 길은 셋뿐입니다.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-700">
          <li>작성자가 편지를 만들 때 받은 관리 링크로 직접 삭제</li>
          <li>신고를 받아 운영자가 비공개 또는 삭제</li>
          <li>
            관리 링크를 잃어버린 작성자의{" "}
            <Link href="/delete-request" className="underline">
              삭제 요청
            </Link>
            을 운영자가 대조 후 처리
          </li>
        </ul>
        <p className="mt-2 text-gray-700">
          관리 링크는 편지를 만든 직후 <strong>한 번만</strong> 보여드립니다.
          다시 발급할 수 없습니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">6. 신고와 이의 제기</h2>
        <p className="mt-2 text-gray-700">
          신고가 한 건 들어오면 사람이 확인하기 전에 먼저 비공개로 내립니다.
          판단은 그다음에 합니다. 잘못 내려간 편지는 관리 링크에서 이의를 제기할
          수 있고, 받아들여지면 다시 공개됩니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">7. 서비스 중단</h2>
        <p className="mt-2 text-gray-700">
          안전 문제가 생기면 편지 읽기나 쓰기를 일시적으로 전부 멈출 수
          있습니다. 그동안에도 작성자는 자기 편지를 삭제할 수 있습니다.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">8. 개인정보</h2>
        <p className="mt-2 text-gray-700">
          무엇을 수집하고 무엇을 저장하지 않는지는{" "}
          <Link href="/privacy" className="underline">
            개인정보처리방침
          </Link>
          에 있습니다.
        </p>
      </section>

      {/* 확정됨 (2026-08-16) — 면책 범위 · 준거법 · 관할 · 분쟁 해결 · 약관 변경 고지
          절차 · 시행일을 채운다 (08 M7-6). M0 답이 개별 조문까지 주지는 않았으므로,
          채울 때 00 「M0 답」의 법률상 의무/정책 구분을 그대로 따른다. 지어내지 않는다. */}
    </main>
  );
}
