"use client";

// 03 §1-4. **v0에서 문구가 가장 중요한 화면이다.**
//
// D-011로 단서를 자유 텍스트로 열어놨기 때문에, 여기 문구가 S-1(저격) 발생률을 직접
// 결정한다. 그래서 아래 문자열은 전부 03 §1-4에서 **글자 그대로** 옮겼다. 더 나아
// 보이는 문구로 바꾸지 않는다.
//
//   · `둘만 아는 순간을 하나 적어주세요`  ← "이 사람만 알아볼 수 있는 단서"가 아니다.
//     전자는 인물을 가리키게 하고 후자는 사건을 가리키게 한다. 결과물이 다르다
//   · `(모두에게 보입니다)` / `(저장되지 않습니다)`  ← 이걸 빼면 사용자가 비공개라고
//     착각하고 식별정보를 쓴다
//   · `이름 · 학교 · 회사 · 연락처는 쓸 수 없습니다.`  ← 실제로 단서의 학교·회사는
//     차단이다 (D-016). 문구와 동작이 같아야 한다

import { MAX_ANSWER, MAX_HINT, MAX_QUESTION } from "./limits";
import { FIELD_NOTE, INPUT, PRIMARY, SECONDARY } from "./ui";

function FieldLabel({ label, note }: { label: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="font-medium">{label}</span>
      <span className={FIELD_NOTE}>{note}</span>
    </div>
  );
}

export function LockedStep({
  hint,
  question,
  answer,
  onChange,
  onNext,
  onBack,
}: {
  hint: string;
  question: string;
  answer: string;
  onChange: (patch: { hint?: string; question?: string; answer?: string }) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const ready =
    hint.trim() !== "" &&
    question.trim() !== "" &&
    answer.trim() !== "" &&
    hint.length <= MAX_HINT &&
    question.length <= MAX_QUESTION &&
    answer.length <= MAX_ANSWER;

  return (
    <section className="grid gap-6">
      <div>
        <label className="grid gap-2">
          <FieldLabel
            label="둘만 아는 순간을 하나 적어주세요"
            note="(모두에게 보입니다)"
          />
          <input
            className={INPUT}
            value={hint}
            maxLength={MAX_HINT}
            placeholder="2019년 봄, 처음 우산 같이 쓴 날"
            onChange={(event) => onChange({ hint: event.target.value })}
            autoFocus
          />
        </label>
        <p className="mt-2 text-sm text-neutral-600">
          이름 · 학교 · 회사 · 연락처는 쓸 수 없습니다.
        </p>
      </div>

      <label className="grid gap-2">
        <FieldLabel
          label="그 사람만 답할 수 있는 질문"
          note="(모두에게 보입니다)"
        />
        <input
          className={INPUT}
          value={question}
          maxLength={MAX_QUESTION}
          placeholder="그날 우리가 들어간 카페 이름은?"
          onChange={(event) => onChange({ question: event.target.value })}
        />
      </label>

      <label className="grid gap-2">
        <FieldLabel label="답" note="(저장되지 않습니다)" />
        <input
          className={INPUT}
          value={answer}
          maxLength={MAX_ANSWER}
          onChange={(event) => onChange({ answer: event.target.value })}
        />
      </label>

      <div className="flex gap-2">
        <button type="button" className={SECONDARY} onClick={onBack}>
          뒤로
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={!ready}
          onClick={onNext}
        >
          다음
        </button>
      </div>
    </section>
  );
}
