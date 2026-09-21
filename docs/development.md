# 개발 안내

로컬 실행 · 테스트 · 배포 준비에 필요한 계약이다. 제품과 정책은 [문서 인덱스](./README.md)에서 시작한다.

## 코드베이스 계약

### `docs/`가 기준이다

컬럼 · 테이블 · 엔드포인트 · 기능은 문서에 있는 것만 만든다. 문서와 다르게 만들어야 할
이유를 발견하면 문서를 먼저 고친다. 문서끼리 어긋나면 [00-decisions.md](./00-decisions.md)가
이긴다.

스키마를 예로 들면, `migrations/*.sql`을 전부 적용한 결과가
[04-data-model.md §2](./04-data-model.md)와 [06-analytics.md §1](./06-analytics.md)의
SQL과 같아야 한다.

**미러는 구조에 대한 것이다** — 테이블 · 컬럼 · 타입 · 제약 · 인덱스. **SQL 주석은
제외한다.** 주석은 정책 설명이라 결정이 바뀌면 따라 바뀌는데, 이미 적용된 마이그레이션은
고치지 않는다(아래 [마이그레이션](#마이그레이션)). 대조는 주석과 공백을 빼고 한다.

### 편지 상태는 한 파일에서만 바꾼다

**`src/lib/letters/deletion.ts` 밖에서 `letters`의 상태와 본문을 직접 UPDATE하지 않는다.**

편지 본문이 사라지거나 옮겨지는 경로 — 완전 파기([D-027](./00-decisions.md)) ·
격리와 복원([D-028](./00-decisions.md)) · 자동 비공개 · 복귀 — 가 전부 이 파일
하나에 있다. 흩어져 있으면 규칙이 바뀐 날 전부 찾아 고쳐야 하고, 하나를 빠뜨리면 그게
사고다. 없는 전이가 필요하면 **그 파일에 함수를 더한다.**

### 안전 회귀 테스트 번호는 고정이다

`tests/safety/`의 `describe` 이름에 들어 있는 `safety#<번호>`가 출시 게이트의
식별자다. 번호별 출처와 파일 배치는
[`tests/safety/README.md`](../tests/safety/README.md)에 있다.

번호를 바꾸거나 다른 파일로 옮기지 않는다. 게이트가 깨지면 번호를 지우지 말고 원인을
고친다. **번호는 늘어날 수 있고 줄어들 수 없다.**

### 스타일

Tailwind v4. 설정 파일이 따로 없고 토큰이 `src/app/globals.css`에 산다. 화면마다
간격·색·타이포를 따로 정하지 않고, 새 토큰이 필요하면 이 파일에 더한다.

현재 정해진 것은 **폰트 스택 하나**뿐이다. 중립 색 스케일과 간격 스케일은 Tailwind v4
기본값을 그대로 쓴다.

## 로컬 개발

### 요구 사항

| | |
|---|---|
| Node | 24 이상 (개발 기준 v24.11.1) |
| 패키지 매니저 | npm |
| Postgres | 16 |

### 1. Postgres 띄우기

```bash
docker run -d --name postfeel-pg \
  -e POSTGRES_USER=postfeel \
  -e POSTGRES_PASSWORD=postfeel \
  -e POSTGRES_DB=postfeel \
  -p 54329:5432 \
  postgres:16
```

포트가 5432가 아니라 **54329**인 것은 이미 돌고 있을 다른 Postgres와 부딪히지 않기
위해서다. 이미 컨테이너를 만들었다면 `docker start postfeel-pg`.

### 2. 환경변수

```bash
cp .env.example .env.local
```

M1에 필요한 값은 넷이다 — `DATABASE_URL` · `ANSWER_KEY` · `FP_KEY` · `NEXT_PUBLIC_SITE_URL`.
나머지는 [M2](./08-milestones.md) 이후에 쓰기 시작하므로 비워 둬도 부팅된다.
필수 값이 없으면 `src/lib/env.ts`가 부팅 시 죽인다.

키 생성:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

> `ANSWER_KEY`는 **교체 불가**다 ([D-017](./00-decisions.md)). 바꾸는 순간 이미
> 게시된 잠긴 편지가 전부 영구히 안 열린다. 로컬 값과 배포 값을 섞지 않는다.

로컬 `DATABASE_URL`:

```
DATABASE_URL=postgresql://postfeel:postfeel@localhost:54329/postfeel
```

### 3. 설치 · 마이그레이션 · 실행

```bash
npm install
npm run db:migrate
npm run dev
```


## 스크립트

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run build` / `start` | 프로덕션 빌드 / 실행 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest (DB 포함) |
| `npm run gate` | 안전 회귀 테스트의 진행 상황 (활성 · 통과 · 미구현) |
| `npm run weekly` | [주간 리뷰 7개 지표](./06-analytics.md)를 순서대로 출력. DB만 있으면 된다 |
| `npm run eval` | [분류기 평가셋](./08-milestones.md) 실행 — 재현율 · 오탐율을 층별로 집계. **실제 API 호출이 발생한다** (`OPENAI_API_KEY` + DB 필요, [`eval/README.md`](../eval/README.md)) |
| `npm run db:migrate` | 아직 적용되지 않은 마이그레이션만 적용. 재실행해도 안전하다 |
| `npm run db:reset` | 로컬 DB를 드롭하고 다시 만든 뒤 전부 적용 |

`db:reset`은 `DATABASE_URL`이 가리키는 DB를 **드롭한다.** 호스트가 localhost가 아니면
거부한다 — 이 명령의 실패 모드는 되돌릴 수 없다.

`.env` / `.env.local`은 `db:migrate`·`db:reset`이 직접 읽는다(Node `--env-file-if-exists`).
이미 셸에 있는 환경변수가 파일보다 우선한다.


## 마이그레이션

`migrations/*.sql`을 파일명 순서로 한 번씩만 적용하고, 적용 기록을 `schema_migrations`에
남긴다. 한 파일은 한 트랜잭션이다 — 통째로 성공하거나 통째로 없던 일이 된다.

ORM도 마이그레이션 프레임워크도 쓰지 않는다. [D-018](./00-decisions.md)이
"마이그레이션은 raw SQL 파일"로 못박았다.

새 마이그레이션은 `0002_...sql`처럼 번호를 이어 붙인다. **이미 머지된 파일은 고치지
않는다** — 이미 적용된 DB에는 다시 돌지 않으므로 고쳐도 반영되지 않는다.


## 테스트

```bash
npm test
```

### 왜 이렇게 만들었나

여러 테스트 실행이 **같은 Postgres를 향해 동시에** 돌 수 있다. 공유 DB를 쓰면 서로의
행이 보여서 그때부터 전부 flaky해진다. 그래서:

- **실행마다** 마이그레이션이 적용된 템플릿 DB `postfeel_tmpl_<실행ID>`를 하나 만든다
- **테스트 파일마다** 그 템플릿을 복제해 `postfeel_test_<실행ID>_<랜덤>`을 쓴다
- 파일이 끝나면 자기 DB를 드롭하고, 실행이 끝나면 남은 것까지 정리한다
- `DATABASE_URL`이 없으면 위 도커 URL로 폴백한다

템플릿을 실행마다 새로 만드는 이유는 **템플릿에 접속이 하나라도 살아 있으면
`CREATE DATABASE ... TEMPLATE`이 실패하기 때문**이다(`55006 source database is being
accessed by other users`). 실행들이 템플릿을 공유하면 A 실행의 마이그레이션 접속이 B
실행의 DB 생성을 깨뜨린다. 같은 템플릿에서 **동시에 복제**하는 것 자체는 충돌하지 않는다
— 8개 동시 복제로 확인했다.

### 픽스처

`tests/fixtures/letters.ts`의 `insertLetter(overrides)`를 쓴다. 기본값은 "피드에 뜨는
평범한 A 모드 편지"이고, 관리 토큰 원문은 DB에 없으므로([D-014](./00-decisions.md))
삽입 결과와 함께 돌려준다.

```ts
const { letter, manageToken } = await insertLetter({ relationship: "ex" });
```

`locked` 편지는 `hint` · `question` · `answerHmac`을 함께 넘겨야 한다. 셋 중 하나라도
비면 `locked_fields` 제약이 삽입을 거부한다.

### 안전 회귀 테스트 (`tests/safety/`)

기능 테스트가 아니라 **배포를 막는 테스트**다. 전부 통과가 출시 게이트다 — 번호의 출처와
고정 규칙은 위 [「안전 회귀 테스트 번호는 고정이다」](#안전-회귀-테스트-번호는-고정이다).
공개 저장소에서는 안전 필터의 규칙 자산을 예시로 바꿨으므로, 규칙 내용을 재던 단위
테스트는 동작 계약만 검증한다.

```bash
npm run gate
# 안전 회귀 테스트: 31/31 활성 · 31 통과 · 0 미구현
```

활성이 아닌 번호가 있으면 `미구현: #1 #2 ...`가, 활성인데 통과하지 않는 번호가 있으면
`미통과: ...`가 함께 찍힌다. 번호가 하나라도 없거나 미통과가 있으면 0이 아닌 코드로
끝난다. 번호와 파일 배치는 [`tests/safety/README.md`](../tests/safety/README.md).


## DB 접근

`src/lib/db.ts`가 전부다 — `query()`와 `withTransaction()` 둘.

**쿼리 빌더를 만들지 않는다.** raw SQL을 그대로 쓴다.

**커넥션 풀 외의 프로세스 로컬 상태를 만들지 않는다.** 배포가 서버리스라
([D-018](./00-decisions.md)) 인스턴스가 수시로 새로 뜨고, 인메모리 카운터·캐시는
인스턴스 사이에서 공유되지 않는다. 레이트리밋 카운트도 킬 스위치도 Postgres에서 읽는다
([05-api §5](./05-api.md)).


## 배포 시 해야 할 일

### 재분류 · 파기 잡의 스케줄러

`/api/cron/reclassify`(재분류, 10분 주기)와 `/api/cron/purge`(파기, 하루 1회,
[D-031](./00-decisions.md))는 외부 스케줄러가 `Authorization: Bearer <CRON_SECRET>`
헤더로 불러야 한다. 값은 배포 환경변수 `CRON_SECRET`과 **같아야** 하고, 다르면 라우트가
401을 낸다. **공개 저장소에는 이 스케줄 워크플로를 포함하지 않았다.**

재분류가 안 돌면 `classifier_state = 'unavailable'`인 편지가 영원히 재분류되지 않는다
([05-api §1](./05-api.md)). 파기가 안 돌면 **보유기간 위반이 누적된다.** 잡이 실패하면
스스로 `retention_healthy`를 끄고 신규 작성을 막지만(D-031), **아예 안 불리면 실패도 하지
않는다.** 그 구멍은 [07 §7 주간 점검](./07-operations.md)이 붙잡는다.

### `ACCESS_LOG_KEY` — 같은 함정이 하나 더 있다

[D-030](./00-decisions.md)의 법정 접속기록은 이 키가 있어야 남는다. **비어 있으면
`recordAccess`가 아무것도 하지 않고 조용히 통과한다.** 로컬과 CI가 키 없이 돌아야 해서
그렇게 만들었고(평문 IP를 남기는 것보다 안 남기는 쪽이 D-030에 맞다), 그 대가로 배포
환경에서 잊으면 **보관 의무가 걸린 3개월치가 통째로 비게 된다.**

배포 후 `audit.access_log`에 행이 실제로 쌓이는지 눈으로 확인한다 —
[출시 게이트 19번](./08-milestones.md)이 그것이다.

**이 키는 교체 불가에 가깝다.** 바꾸면 그 이전 기록을 복호할 수 없고, 못 읽는 기록은
보관하지 않은 것과 같다. `ANSWER_KEY`와 같은 취급으로 관리한다.

### DB 역할 분리

D-030은 "애플리케이션 일반 코드에서는 쓰기만 가능하고 조회는 불가능"을 요구한다.
코드 쪽은 읽는 함수를 만들지 않는 것으로 지키고 있고([안전 테스트 26](./05-api.md)),
**권한으로 강제하는 것은 배포 시 별도 DB 사용자로 한다** — 앱용(`audit.access_log`에
INSERT만)과 파기 잡용(DELETE)을 나눈다. 마이그레이션이 이걸 대신할 수 없는 이유는
`migrations/0004` 주석에 있다.

