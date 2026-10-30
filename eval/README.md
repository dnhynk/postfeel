# Classifier evaluation

This runner decides the launch checklist item "the classifier works". The pass criteria are in [docs/08-milestones.md](../docs/08-milestones.md) (in Korean): recall of at least 0.8 on risky letters and a false-positive rate of at most 0.2 on normal ones.

The model for layer 2 is not chosen yet. The candidates and the screening rules are in [docs/o-009-classifier-candidates.md](../docs/o-009-classifier-candidates.md) (in Korean).

The production evaluation set is not in this public repository. Its risky and normal cases, and the layer 1 detections expected for them, would work as a map for getting around the filter. `dataset.ts` here holds two made-up cases that show the format, and this public copy has no run records.

```bash
npm run eval
```

The run needs both `OPENAI_API_KEY` and Postgres, and it makes paid API calls. `classify()` uses the key. The database holds the daily spend cap that `src/lib/safety/budget.ts` checks and updates. Without a database, `checkBudget` fails, every case comes back `unavailable`, the failure path rates every letter medium, and the run reports a recall of 1.0 and a false-positive rate of 1.0, which mean nothing.

A run whose layer 2 status section (`층 2 상태` in the output) shows any `unavailable` cases is not used for the launch decision.

## Files

| File | Contents |
|---|---|
| `dataset.ts` | Labels, risk types and the `layer1Catchable` field. The public copy has two made-up cases |
| `run.ts` | The runner. It calls the real pipeline and counts results per layer |
| `resolve.ts` | A resolve hook so that `node` can follow the extensionless imports in `src/` |

## How it measures

The target is the whole pipeline, layer 1 plus layer 2. The runner calls `runLayer1`, then `classify`, then `grade`, the same functions the submit path uses. It does not reimplement the grading rules, because a copy would measure the copy instead of the pipeline.

A detection is a grade of medium or higher. False positives use the same line.

Each letter is graded twice to tell the layers apart:

| Pass | Call |
|---|---|
| Layer 1 alone | `grade(layer1, { state: 'ok', risk: 'low', flags: [] })` |
| Full pipeline | `grade(layer1, classify(draft))` |

If layer 1 alone already reaches medium, layer 1 caught the letter. If it does not and the full pipeline does, layer 2 caught it. A medium that comes from `unavailable` goes into a third column. The failure path exists to keep writing open during a classifier outage, so every letter gets medium; counted as detections, an outage would score a recall of 1.0 and a false-positive rate of 1.0.
