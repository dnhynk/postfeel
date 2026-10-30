# Safety regression tests

These 31 tests guard the safety rules, and the launch gate requires every one of them to pass. 26 of them (#1 to #17, #22, #23, #25 to #31) come from section 7 of the [API spec](../../docs/05-api.md), and 5 (#18 to #21, #24) come from section 6 of the [notification spec](../../docs/09-notifications.md). Both documents are in Korean.

- Each test is named `safety#<n>` in its `describe` title. That number is what `npm run gate` counts, so a number keeps its meaning and its file.
- All 31 are implemented and pass. Deleting a number or turning it back into `it.todo` would remove it from the gate's count.
- The list can grow but not shrink. #25 to #31 were added on 16 August 2026, after the legal review: hard deletion, the legally required access log, quarantine, the retention purge, age confirmation, sensitive data, and holding letters until the classifier has judged them. A new decision that creates a new way to fail gets a new number.
- `npm run gate` prints how many are active and passing, and exits non-zero if a number is missing or an active test fails.

Tests #25 to #28 point the other way from the rest. They check that something which must not exist is absent, so a pass shows nothing on screen. A change that adds a letter ID to the access log looks reasonable in review and works, yet it would link access records to letters and end the anonymity of writing without an account. Quarantine and purging are similar: the letter is taken down and the review screen still shows its text, so only the tests can tell where that text remains.

Test #28 adds one assertion in the opposite direction: data still inside its retention period must remain. Without it, deleting everything would pass every other assertion, and over-deletion cannot be undone.

| # | What it checks | File |
|---|---|---|
| 1 | A locked letter's GET response has no body without the unlock cookie | `locked-letter.test.ts` |
| 2 | A locked letter's share card image has no body | `letter-status.test.ts` |
| 3 | A high-risk letter is not created, with no confirmation token or with a forged one | `letter-create.test.ts` |
| 4 | Changing the body or answer after a confirmation token is issued triggers a new classification | `letter-create.test.ts` |
| 5 | A wrong-answer response does not vary with the length or content of the right answer | `unlock.test.ts` |
| 6 | After one client, identified by a fingerprint hash, runs out of attempts, the letter-wide limit still applies on its own | `unlock.test.ts` |
| 7 | One report sets the letter to `hidden_auto` | `report-flow.test.ts` |
| 8 | A letter exempt from auto-hiding stays published on ordinary reports and is hidden on severe-category reports | `report-flow.test.ts` |
| 9 | `/m/:id` returns a `noindex` header | `letter-status.test.ts` |
| 10 | Hidden and author-deleted letters return 404 in the feed, the API, `/m/:id` and the share card | `letter-status.test.ts` |
| 11 | `/manage/:token` still responds when the letter is hidden or deleted | `manage.test.ts` |
| 12 | With the classifier forced down, a letter is created at medium risk | `classifier.test.ts` |
| 13 | A letter that layer 1 rates high is blocked whatever the classifier's state | `classifier.test.ts` |
| 14 | No email is stored unless the age confirmation is present and true | `manage.test.ts` |
| 15 | `/manage/:token` keeps working while public reading is switched off | `manage.test.ts` |
| 16 | A forged unlock cookie, or one from another letter, does not open the body | `locked-letter.test.ts` |
| 17 | An email cannot be registered through `/api/letters/:id` routes without the management token | `manage.test.ts` |
| 18 | The unsubscribe link deletes the contact row, and nothing is sent afterwards | `email.test.ts` |
| 19 | A letter opened twice produces one "someone opened your letter" email | `email.test.ts` |
| 20 | No email contains the letter body | `email.test.ts` |
| 21 | Telegram alerts contain neither the letter body nor the letter ID | `telegram.test.ts` |
| 22 | A classifier refusal means the letter is not created | `classifier.test.ts` |
| 23 | The plain answer appears in none of the stored answer HMACs | `unlock.test.ts` |
| 24 | The reader-response email goes out only for a yes, and only once | `email.test.ts` |
| 25 | A deleted letter's text no longer exists in the database | `manage.test.ts` |
| 26 | The access log has no link to service data | `access-log.test.ts` |
| 27 | A quarantined letter's body no longer exists in the letters table | `quarantine.test.ts` |
| 28 | Data past its retention period is purged | `retention.test.ts` |
| 29 | No letter is created unless the age confirmation is present and true | `age.test.ts` |
| 30 | A sensitive detail about an identifiable third party is blocked before posting | `sensitive.test.ts` |
| 31 | A letter the classifier has not judged cannot be read, reacted to or unlocked | `pending-review.test.ts` |
