# PostFeel

A web wall for unsent letters — some open to everyone, some only to the person who recognizes them.

**보내지 못한 말을 남겨두는 벽.** 어떤 편지는 누구나 읽을 수 있고, 어떤 편지는 그 말을
알아볼 사람만 열 수 있다.

> 이 저장소는 공개용 스냅샷이며, 안전 필터의 실서비스 규칙(패턴 · 사전 · 분류기 프롬프트 ·
> 평가셋)과 위협 모델 문서는 제외했다. 해당 파일은 인터페이스만 남기고 예시로 대체했다.

## 문제

기존 메시지는 보내는 순간 도달한다. 그래서 거절 · 민망함 · 관계 악화가 두려운 사람은
아무것도 보내지 못하고 감정을 혼자 보관한다. 반대편 사람은 자신을 향한 말이 존재하는지조차
모른다.

PostFeel은 그 말을 **상대에게 보내지 않고 벽에 남겨두는** 방식으로 이 간극을 다룬다.
비사용자에게는 어떤 알림도 보내지 않는다. 편지가 닿는 유일한 경로는 사람들이 링크를
직접 공유하는 것이다.

## 핵심 기능

- **두 가지 편지** — 누구나 읽는 공개 편지(A), 단서만 보이고 열쇠 질문의 답을 맞혀야
  열리는 잠긴 편지(B). 잠긴 편지는 시도 횟수가 제한된다
- **무계정 작성** — 계정 없이 쓰고, 작성 직후 받는 관리 링크로 삭제를 요청한다
- **공유 카드** — 편지마다 카드 이미지가 만들어진다. 공유가 유일한 배달 수단이다
- **"나에게 온 것 같아요"** — 잠긴 편지를 연 사람이 한 번 응답하면 작성자에게 전달된다
- **반응 · 신고** — 편지에 반응을 남기고, 문제가 있는 편지를 신고한다
- **선택적 이메일 알림** — 이메일은 알림이 필요할 때만 받는다. 작성과 이메일 등록은 만
  14세 이상으로 제한한다
- **운영 도구** — 신고 · 이의제기 · 삭제 요청 처리 큐, 공개 열람과 작성을 각각 멈추는
  킬 스위치
- **위기 안내** — 자해 관련 표현으로 차단될 때 차단 화면에 상담 기관 안내를 함께 보여준다

## 설계 포인트

- **공개된 편지에서 실제 인물을 특정할 수 없어야 한다.** 게시 전에 다층 필터(로컬 규칙 +
  언어 모델 분류기)로 검사하고, 위험도에 따라 게시 · 확인 후 게시(피드 제외) · 차단으로
  나눈다. 필터 규칙은 비공개다
- **판정이 끝나기 전에는 게시하지 않는다.** 분류기가 응답하지 못하면 통과도 차단도 아닌
  보수적 등급으로 내리고, 나중에 다시 분류한다
- **원문을 들고 있지 않는다.** 잠긴 편지의 답과 관리 토큰은 원문이 아니라 HMAC · 해시로만
  저장한다
- **삭제는 완전 파기다.** 상태만 바꾸는 soft delete를 쓰지 않고, 보유기간이 지나면 자동으로
  파기한다
- **존재하지 않는 신호를 만들지 않는다.** "상대가 읽었다"가 아니라 "누군가 열었다"만 말한다
- **서버리스 전제.** 레이트리밋 카운트와 킬 스위치를 프로세스 메모리가 아니라 Postgres에
  둔다

근거는 [결정 로그](./docs/00-decisions.md)에 결정마다 적혀 있다.

## 기술 스택

| | |
|---|---|
| 앱 | Next.js 16 (App Router) · React 19 · TypeScript |
| 스타일 | Tailwind CSS v4 |
| DB | PostgreSQL 16 · `pg` · raw SQL 마이그레이션 (ORM 없음) |
| 검증 | zod |
| 분류기 | OpenAI SDK (층 2 모델은 재선정 중) |
| 발송 | Resend(사용자 이메일) · 텔레그램(운영자 알림) |
| 테스트 | Vitest (테스트 파일마다 격리된 Postgres DB) |
| 배포 계획 | Vercel + Supabase |

## 현재 상태

**출시하지 않았다.**

- v0 기능 코드(M1~M5)와 법률 확인 답을 반영한 단계(M7)까지 구현돼 있다
- 법률 검토는 진행 중이다. 출시 전 필수 항목의 답은 반영했고, 일부 항목은 아직 확인
  전이다([결정 로그](./docs/00-decisions.md) L-003 · L-004)
- 출시를 막는 미결정이 남아 있다 — 층 2 분류기 모델(O-009)과 DB 저장 리전(O-010)
- 남은 일과 출시 게이트 현황은 [문서 인덱스](./docs/README.md)와
  [마일스톤](./docs/08-milestones.md)에 있다

## 로컬 실행

Node 24 이상, npm, Docker가 필요하다.

```bash
# 1. Postgres 16 컨테이너 (포트 54329)
docker run -d --name postfeel-pg \
  -e POSTGRES_USER=postfeel \
  -e POSTGRES_PASSWORD=postfeel \
  -e POSTGRES_DB=postfeel \
  -p 54329:5432 \
  postgres:16

# 2. 환경변수 — DATABASE_URL · ANSWER_KEY · FP_KEY · NEXT_PUBLIC_SITE_URL을 채운다
cp .env.example .env.local

# 3. 설치 · 마이그레이션 · 실행
npm install
npm run db:migrate
npm run dev
```

로컬 `DATABASE_URL`은 `postgresql://postfeel:postfeel@localhost:54329/postfeel`이다.
키는 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`로
만든다. 필수 값이 없으면 `src/lib/env.ts`가 부팅을 멈춘다.

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

테스트는 위 Postgres 서버에 실행마다 임시 DB를 만들어 쓰고 지운다. 외부 API는 호출하지
않는다. 스크립트 전체와 테스트 구조는 [개발 안내](./docs/development.md)에 있다.

## 문서

| 문서 | 내용 |
|---|---|
| [문서 인덱스](./docs/README.md) | 구현 상태, 읽는 순서, 남은 일 |
| [결정 로그](./docs/00-decisions.md) | 되돌리기 어려운 결정과 그 근거 |
| [제품 정의](./docs/01-product.md) | 무엇이고 무엇이 아닌가 |
| [핵심 흐름](./docs/03-flows.md) | 화면, 빈 상태와 실패 상태 |
| [데이터 모델](./docs/04-data-model.md) | 스키마, 상태 기계 |
| [API 명세](./docs/05-api.md) | 엔드포인트, 레이트리밋, 안전 테스트 |
| [계측 명세](./docs/06-analytics.md) | 이벤트, 주간 지표 |
| [운영 런북](./docs/07-operations.md) | 신고 판정, 긴급 대응 |
| [마일스톤](./docs/08-milestones.md) | 개발 순서, 출시 게이트 |
| [발송 명세](./docs/09-notifications.md) | 이메일, 운영자 알림, 해지 |
| [개발 안내](./docs/development.md) | 로컬 실행, 테스트, 배포 준비 |

위협 모델 문서(02)는 비공개다.
