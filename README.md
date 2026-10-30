# PostFeel

[![CI](https://github.com/dnhynk/postfeel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dnhynk/postfeel/actions/workflows/ci.yml)

PostFeel is a web app for letters people never sent to someone they know, such as an ex, a friend, family or a coworker: the writer leaves each letter open to anyone, or locks it behind a question that only the intended reader should be able to answer.

Before anyone can read a letter, a rule filter and an LLM classifier check it for details that identify a real person, and a letter the classifier could not judge stays hidden until a retry or an operator gives a verdict.

![Three phone screens from a local build: the lock form, a locked letter, and the opened letter](docs/images/lock-flow.png)

*Local build with made-up text; with no API key, the classifier's verdict for this letter was set by hand. (1) The writer sets a clue and a question, both public, and an answer that is stored only as an HMAC. (2) A reader sees the clue and the question and has three attempts. (3) The right answer opens the letter and asks once whether it seems meant for the reader.*

- **Context:** personal project, solo, built 14 to 16 August 2026.
- **Verified:** 573 Vitest tests in 52 files pass in GitHub Actions against Postgres 16 on the snapshot commit (21 September 2026). A local re-run on 31 October 2026 gave the same count.
- **Status:** not launched. Public snapshot of a private development repository; history starts here because the private history contains the production filter rules, classifier prompts, evaluation set and threat model, which stay private so that users cannot learn how to get around the filter.

## What it does

- A writer picks an open letter, which anyone can read, or a locked letter, which shows only a clue and a question until a reader types the right answer. Each reader gets a limited number of attempts.
- Letters the filter rates low-risk appear in a public feed with fixed reactions, and every letter has a share card image. There are no notifications to non-users, so a letter reaches its intended reader through the feed or a shared link. Letter pages carry `noindex`.
- There are no accounts. After posting, the writer sees a management link once and can delete the letter with it. An email address is optional; it receives the management link and short notices, such as the first time the letter is opened, without the letter text.
- A reader who opens a locked letter can say whether it seems meant for them. A yes shows on the writer's management page and, if the writer left an email, arrives once by email, worded as a claim by whoever opened the letter.
- Operators get a queue for reports, appeals and deletion requests, and switches that stop public reading or new writing. Writing and email sign-up require confirming an age of 14 or older, and a letter blocked for self-harm language shows two crisis-line numbers.

## How it works

Built with Next.js 16 (App Router), React 19, TypeScript and Tailwind CSS 4, on PostgreSQL 16 through `pg` with plain SQL migrations and no ORM. Zod validates schemas, the OpenAI SDK calls the classifier, Resend sends email, the Telegram Bot API sends operator alerts, and Vitest runs the tests. Hosting was planned on Vercel and Supabase.

- Two-layer filter. `src/lib/safety/layer1.ts` runs regex and dictionary rules over the body, clue and question. `src/lib/safety/classifier.ts` asks an LLM for a verdict in a strict JSON schema. `src/lib/safety/grade.ts`, a pure function, merges both into publish, warn first and keep out of the feed, or block. Contact details and links anywhere, a school or company in the clue or question, a sensitive detail about an identifiable third party, and a model refusal all block. `tests/lib/safety-grade.test.ts` covers each rule.
- Hold on classifier failure. A timeout, network error or spend cap returns `unavailable`. The letter is saved at the cautious middle tier but cannot be read, reacted to or unlocked until the reclassify job (`src/lib/safety/reclassify.ts`, which a scheduler is meant to call every 10 minutes through `/api/cron/reclassify`) gets a verdict. After three failed retries the letter stays held until an operator decides. `tests/safety/pending-review.test.ts` checks the direct link, the feed, reactions and unlocking.
- Hashes in place of secrets. Answers are stored as HMAC-SHA256, keyed with a server secret and salted with the letter ID, and compared in constant time (`src/lib/answer.ts`). Management tokens are stored as SHA-256 hashes (`src/lib/crypto.ts`). `tests/safety/unlock.test.ts` checks that no stored value contains the plain answer.
- Hard deletion and retention limits. Deleting a letter clears its body, clue, question and answer hashes, deletes the writer's email address, and keeps a tombstone row so the management link can still report the deletion; every code path that changes a letter's status or text lives in `src/lib/letters/deletion.ts`. `src/lib/retention/purge.ts` deletes or anonymizes data past its retention period (fingerprint hashes are overwritten after 90 days) and turns off new writing when a purge fails. `tests/safety/retention.test.ts` checks that expired data is gone and data inside its period is kept. The periods come from a legal review on 16 August 2026; the questions asked and the decisions that followed are in `docs/m0-legal-questions.md` and `docs/00-decisions.md` (both in Korean).
- Switches and a safety gate. Three switches in Postgres (public reading, writing, retention health) are read on every request inside the route handlers (`src/lib/settings.ts`), so they apply across serverless instances. `tests/safety/` holds 31 numbered safety regression tests. `npm run gate` prints how many are active and passing, and exits non-zero if a number is missing or an active test fails.

Start reading here: `src/lib/safety/grade.ts`, `src/lib/letters/deletion.ts` and [`tests/safety/README.md`](tests/safety/README.md).

## Results

| Check | Setting | Result |
|---|---|---|
| `npm test` (Vitest, 52 files) | GitHub Actions, Node 24, Postgres 16, snapshot commit, 21 Sep 2026 | 573 passed (CI) |
| `npm test` | Windows 11, Node 24.19, Postgres 16.13, 31 Oct 2026 | 573 passed (local) |
| `npm run gate` | Same local setup | 31 of 31 safety tests active and passing (local) |
| Typecheck, lint, build, migrations run twice | The CI run above, and the local setup | All pass |
| Classifier outage path | Local dev server with no API key, 31 Oct 2026 | New letter saved (201), reader request 404, writer's management view shows `pendingReview: true` (local) |

The filter has no current accuracy numbers; see the next section.

## Status and limitations

- Not launched. The launch checklist in `docs/08-milestones.md` has 19 items, and 5 were closed as of 16 August 2026. Most open items need a live deployment or a person: at least 30 real letters, a full rehearsal of the report flow, delivery checks for email and Telegram, and a backup restore.
- The classifier code calls OpenAI's Responses API. After the legal review, the decision was to keep letter text, which describes third parties, inside Korea, so the classifier has to move to a model whose inference runs in Korea. No model has been chosen, and the database region is also open. Both block launch.
- The filter has no valid accuracy numbers. Results measured with the first model were dropped when the model choice changed. The new evaluation set (64 cases, 32 risky and 32 normal) still needs a human review of its sentences.
- This snapshot replaces the production regex rules, school and company dictionaries, text normalization, classifier prompts and evaluation set with made-up examples and stubs, and leaves out the threat model. Tests that measured rule content check only the behavior contract here.
- The scheduled jobs that call the reclassify and purge endpoints are not included. Without a scheduler, held letters stay held and retention purges do not run.

## Run it

Needs Node 24 or later, npm, and Docker for Postgres 16. The commands assume a POSIX shell (macOS, Linux, or Git Bash on Windows).

```bash
docker run -d --name postfeel-pg -e POSTGRES_USER=postfeel -e POSTGRES_PASSWORD=postfeel -e POSTGRES_DB=postfeel -p 54329:5432 postgres:16
npm ci
npm test
printf 'DATABASE_URL=postgresql://postfeel:postfeel@localhost:54329/postfeel\nANSWER_KEY=%s\nFP_KEY=%s\nNEXT_PUBLIC_SITE_URL=http://localhost:3000\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env.local
npm run db:migrate && npm run dev
```

`npm test` needs no API keys. It creates a throwaway database per test file on that Postgres server and drops it afterwards. It should end with:

```
 Test Files  52 passed (52)
      Tests  573 passed (573)
```

The app then runs at http://localhost:3000 without any API key. With no `OPENAI_API_KEY` the classifier counts as unavailable, so new letters are saved but stay hidden from readers. `npm run gate` prints the safety test count (in Korean), and `npm run eval` calls the OpenAI API and needs a key.

## Docs

- [Documentation index](docs/README.md): the design documents, open decisions and remaining work. The index is in English; the documents are in Korean.
- [Decision log](docs/00-decisions.md) (in Korean): each decision with its reason, the alternatives rejected and the cost of reversing it.
- [API spec](docs/05-api.md) (in Korean): endpoints, rate limits and the source list for the safety tests.
- [Milestones and launch checklist](docs/08-milestones.md) (in Korean).
- [Development guide](docs/development.md) (in Korean): local setup, the test database layout and deployment steps.

## Project context

Personal project, solo, built 14 to 16 August 2026 and published as this snapshot on 21 September 2026. This snapshot squashes the private history into one commit. Code comments (in Korean) that mention a coordinator or a worker describe how development tasks were split, not runtime components. In `vitest.config.ts` and `tests/setup/global.ts`, a worker is a Vitest worker process.

## License

The code is under the MIT License ([LICENSE](LICENSE)). The bundled NanumGothic font (`src/components/share/NanumGothic-Regular.ttf`), used to draw share cards, is copyright 2010 NHN Corporation and licensed under the SIL Open Font License 1.1 ([`src/components/share/OFL.txt`](src/components/share/OFL.txt)).
