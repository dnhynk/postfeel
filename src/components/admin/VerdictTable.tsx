// 07 §2 신고 판정표.
//
// **화면에 둔다.** 07 §1이 하루 2회 15분(건당 1분)을 상한으로 잡았는데 매번 문서를 열면
// 그 예산이 지켜지지 않고, 07 §8이 경고한 대로 "매번 새로 고민하면" 기준이 흔들린다.
//
// 표의 내용은 07 §2 그대로다. 여기서 기준을 새로 쓰지 않는다.

const ROWS: Array<{ reason: string; test: string; action: string }> = [
  {
    reason: "신상 노출",
    test: "연락처 · 주소 · 학교 · 회사 · 실명이 본문이나 단서에 있는가",
    action: "즉시 삭제. 복구 없음",
  },
  {
    reason: "저격 · 비방",
    test: "제3자가 그 사람이 누군지 알아볼 수 있는가 + 부정적 내용인가",
    action: "둘 다면 삭제. 하나만이면 복구",
  },
  {
    reason: "사칭",
    test: "검증 수단이 없다 (무계정)",
    action: "신고 2건 이상이면 삭제. 1건은 보류",
  },
  {
    reason: "성적 내용",
    test: "미성년 관련인가",
    action: "미성년 관련이면 즉시 삭제 + 07 §4. 성인 간이면 노골적일 때만",
  },
  {
    reason: "자해 · 협박",
    test: "압박 도구인가, 실제 위기 신호인가",
    action: "둘 다 삭제. 위기로 보이면 07 §4",
  },
  { reason: "스팸 · 광고", test: "명백", action: "삭제 + fp_hash 차단" },
  { reason: "기타", test: "—", action: "위 항목에 안 걸리면 복구" },
];

export function VerdictTable() {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">판정표 (07 §2)</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left">
              <th className="p-2">신고 사유</th>
              <th className="p-2">판정 기준</th>
              <th className="p-2">조치</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.reason} className="border-b border-neutral-200">
                <td className="p-2 whitespace-nowrap">{row.reason}</td>
                <td className="p-2 text-neutral-700">{row.test}</td>
                <td className="p-2 text-neutral-700">{row.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-neutral-700">
        <li>
          <strong>애매하면 내립니다.</strong> 정상 편지 하나가 몇 시간 가려지는
          비용 &lt; 문제 편지 하나가 몇 시간 떠 있는 비용.
        </li>
        <li>
          복구할 때는 <code>dismiss</code>를 씁니다 — 같은 편지가 반복 신고로 계속
          내려가는 걸 막습니다. 이의 제기를 받아들일 때는 <code>restore</code>이고
          효과는 같습니다.
        </li>
        <li>판정 이유를 한 줄 남깁니다. 다음에 같은 유형이 왔을 때 기준이 흔들리지 않습니다.</li>
      </ol>

      <p className="mt-3 text-sm text-neutral-600">
        심각 카테고리(신상 · 성적 내용 · 자해)는 <code>auto_hide_exempt</code>와
        무관하게 자동 비공개되고 텔레그램으로 알립니다 (D-025).
      </p>
    </section>
  );
}
