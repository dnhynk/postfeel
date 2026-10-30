# PostFeel documentation

PostFeel is a wall for unsent letters: some letters anyone can read, others open only for someone who recognizes them. The design documents below are in Korean; this index is in English.

## Implementation status

The v0 features are built, followed by a round of changes made after the legal review of 16 August 2026 overturned several v0 assumptions. The results below are for the public snapshot. CI ran the tests, type check, lint and build on 21 September 2026. `npm run gate` is not part of CI; it ran locally on 31 October 2026, together with a local re-run of the rest, which matched.

| Check | Command | Result |
|---|---|---|
| All tests | `npm test` | 52 files, 573 passed |
| Safety regression tests (launch gate) | `npm run gate` | 31 of 31 active, 31 passing, 0 not implemented (exit code 0) |
| Types, lint, build | `npm run typecheck`, `npm run lint`, `npm run build` | All three exit with code 0 |

The safety regression tests are in `tests/safety/`. The number in each `describe` title (`safety#<n>`) is the gate's identifier. The tests come from section 7 of the API spec and section 6 of the notification spec, and [tests/safety/README.md](../tests/safety/README.md) maps each number to its file. `npm run gate` exits non-zero if a number is missing or an active test fails.

Read [Remaining work](#remaining-work-outside-the-code) below and the launch checklist in the [milestones](./08-milestones.md) first. As of 16 August 2026, 5 of the checklist's 19 items are closed, and most of the rest happens outside the code.

## Reading order

| # | Document (in Korean) | What it covers | When to read it |
|---|---|---|---|
| 00 | [Decision log](./00-decisions.md) | Decisions that are hard to reverse, with their reasons | When you ask why something works the way it does |
| 01 | [Product definition](./01-product.md) | What the product is and is not, and its north-star metric | When a feature request arrives |
| 02 | Threat model (not public) | Ten abuse scenarios and their defenses | Before any safety decision |
| 03 | [Core flows](./03-flows.md) | Screens, empty states and failure states | When building UI |
| 04 | [Data model](./04-data-model.md) | Schema, state machine, verification results | When changing the schema |
| 05 | [API spec](./05-api.md) | Endpoints, rate limits, safety tests | While coding |
| 06 | [Analytics spec](./06-analytics.md) | Events, funnel, seven weekly metrics | While coding, and every week |
| 07 | [Operations runbook](./07-operations.md) | Report handling, incident response, outside requests | Every day, including at 2 a.m. |
| 08 | [Milestones](./08-milestones.md) | Build order, launch checklist | For weekly planning |
| 09 | [Notification spec](./09-notifications.md) | Four emails, operator alerts, unsubscribing | Before touching any outgoing message |
| | [Development guide](./development.md) | Local setup, tests, codebase rules, deployment | When you run the code |
| | [Legal questions](./m0-legal-questions.md) | The facts and questions prepared for the legal review | When you need the facts behind the legal answers |
| | [Classifier candidates](./o-009-classifier-candidates.md) | Screening of layer 2 models that run inference in Korea | Before choosing that model |

## Rules between documents

- The decision log wins. If another document disagrees with it, either the log is right or the log is changed, with a reason.
- The threat model comes before the data model. Policy decides the schema.
- A changed decision goes into the decision log with its reason. Documents are not edited quietly.

## Open items

| Kind | Items |
|---|---|
| Undecided, blocks launch | Which model runs layer 2 with inference in Korea; which region stores the database |
| Undecided, outside v0 | The recipient identifier for mode C, private letters addressed to a named person |
| Legal, unverified, outside v0 | How stalking law treats messages that reach someone over a network (mode C); app store rules for user-generated content (app stage). The four questions required before launch were answered in the legal review |
| Provisional values | 500-character body, 3 attempts per locked letter, every rate limit, false-positive threshold 0.2, five switch triggers in the threat model |

Four of the provisional values are also marked provisional in the code (`src/components/write/limits.ts`, `src/lib/ratelimit.ts`).

## Remaining work outside the code

Most items here are outside the code. The first two need vendor checks and accounts before code can follow. Their status is tracked in the launch checklist in the [milestones](./08-milestones.md).

| Item | Why code cannot close it |
|---|---|
| Choose the layer 2 model | Where each candidate runs inference has to be confirmed in vendor documents and contracts, and the Azure model list is visible only with an account. It blocks checklist items 6, 14 and 18 |
| Database region | Whether Supabase offers a Korean region is checked in the account. If it does not, the provider changes |
| Four blanks in the terms and privacy policy | The privacy officer's title, a dedicated email address, the contact for the rights-remedy agency, and the effective date, listed in a comment at the end of `src/app/privacy/page.tsx`. All four come into being at deployment, and an address that does not exist yet would make the document false |
| Human review of the sentences in the 64-case evaluation set | Whether a risky case really reads like a targeted letter takes a human reader. Until then, the file states that it is not used for the gate |
| Calling the crisis line 109 | It is a live counseling line, so tests cannot call it. The number is in `src/lib/crisis.ts` and shows on screen; a person checks that it connects |
| 30 to 50 real letters | The decision log forbids filling the feed with fake letters, so people have to write them |
| Operations rehearsal, pressing the kill switches, restoring a backup | Tests cover the code paths. The checklist asks an operator to run each one once on the real screens, and backups are a setting of the managed database outside this repository |
| Deployment (Vercel, Supabase, Resend, Telegram, domain) and secrets | Outside accounts and secret injection. Four keys do nothing when empty: `SITE_URL` and `CRON_SECRET` (cron jobs), `ACCESS_LOG_KEY` (access log) and `QUARANTINE_KEY` (quarantine). Nothing fails, and nothing happens |
| Checking the KakaoTalk link preview by eye | KakaoTalk is Korea's main messaging app. The check is possible only after deployment, because its scraper has to fetch a public URL, and developer tools do not show the result |

## Fixed rules

These four hold wherever the documents change.

1. The service does not start contact with people who have not used it. Section 1 of the notification spec covers where sending meets this rule.
2. Signals report only events that happened, such as "someone opened your letter".
3. Reading a letter is free.
4. Every letter page carries `noindex`. This is the one rule whose breach cannot be repaired afterwards: once a page is indexed, copies stay in caches and scrapes after the letter is deleted.

## Korean section names in code comments

Code comments are in Korean and cite README sections by their Korean names. 「절대 규칙」 is Fixed rules above. 「편지 상태는 한 파일에서만 바꾼다」 (letter state changes in one file), 「DB 접근」 (database access) and 「스타일」 (style) are sections of the [development guide](./development.md).
