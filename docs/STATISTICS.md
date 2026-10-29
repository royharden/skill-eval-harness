# Statistics implemented (method s20.taskmean.v1)

Source: `supabase/functions/publish-run/domain/` — `stats.ts`, `summary.ts`, `pairing.ts` and `wilson.ts` (only `makeRng` is reused from the legacy `bootstrap.ts`). Written and type-checked; the unit tests
in `tests/v2-stats.test.ts` have not been executed and the numerics have not been independently cross-checked yet.

## Units

A **side** is one (task, repeat, arm). A **block** is (run, experiment digest, task, repeat). A **complete pair** is
one policy-selected eligible attempt per arm in a block, with equal base prompt, fixture, grader, model, CLI,
tool/permission configuration and ambient pins; only the declared artifact/exposure difference may vary.
Eligible statuses: `pass`, `fail`, task-deadline `timeout` (scored as a failure). `agent_error`, `grader_error`,
`cancelled`, `cleanup_pending` and pin mismatches are operational exclusions and stay visible.

The report leads with planned/attempted/not-started sides, finalized attempts, complete pairs, contributing tasks,
repeats, per-arm status counts, unmatched sides and pin-mismatch exclusions. Missingness can bias paired results.

## Paired table

n00 both fail, n01 baseline fail / treatment pass (helpful), n10 baseline pass / treatment fail (harmful), n11 both pass.

## Primary estimand

d_t = mean over task t's complete pairs of (treatment_pass − baseline_pass); delta_task = mean of d_t over
contributing tasks. Secondary pooled descriptive effect: (n01 − n10) / complete pairs.
Example: task A one pair at +1, task B four pairs at 0 → primary 0.5, pooled 0.2.

## Uncertainty

Empirical 95% percentile task-cluster bootstrap: task ids sorted; each of 10,000 resamples draws T tasks with
replacement (each drawn task carries all its paired repeats through d_t) and records the mean; percentiles use
linear interpolation at index (B−1)·p; PRNG mulberry32 seeded with the experiment's scheduling seed.

| Dataset | Observed result | Uncertainty |
|---|---|---|
| No eligible complete pairs | effect unavailable | none |
| Fewer than two contributing tasks | observed delta kept | interval unavailable |
| Identical task deltas or zero width | observed delta kept | degenerate, not certainty |
| Interval touches/spans zero | observed delta kept | includes zero |
| Interval above / below zero | observed delta kept | favors treatment / baseline; method not calibrated |

No winner or "significantly better" badge, no minimum-count power claim and no sign-test gate.

## Exact McNemar (repeat 0 only)

Only predeclared repeat_id = 0 eligible complete pairs, at most one per task. The report lists tasks without a
repeat-0 pair; no other repeat is substituted and repeats are never pooled. D = n01 + n10, m = min(n01, n10),
p = min(1, 2 · Σ_{k=0..m} C(D,k) · 2^−D), computed in log space; D = 0 → undefined.
Checks: 5 vs 1 → 14/64; 6 vs 0 → 2/64.

## Arm rates

Wilson 95% intervals (z = 1.959963984540054) over explicit eligible denominators. Repeats within a task are
correlated, so these are descriptive; overlap is not a paired test. Checks: 0/10 ≈ [0, 0.2775], 10/10 ≈
[0.7225, 1], 5/10 ≈ [0.2366, 0.7634], 3/4 ≈ [0.3006, 0.9544].

Operational success = selected passing planned sides / all planned sides of that arm; retries do not inflate it.

## Cost

Totals include every executed attempt, including failed startups and retries, where known. USD per passing attempt
= total arm USD / selected passes; USD per distinct task solved = total arm USD / distinct tasks with at least one
selected pass. Both ratios are suppressed at a zero denominator or when any executed attempt has unknown cost.
Known total, coverage and the reported/estimated split are always shown. Known zero differs from unknown; text
length is never priced. Tokens and duration carry their own coverage.

## Exposure

Observed means the artifact was accessed or injected, not that it was used correctly. Missing events are unknown;
confirmed-absent requires verified exhaustive observation. Exposure-split outcomes are descriptive only.
