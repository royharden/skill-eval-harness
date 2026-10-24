# Statistics

These rules are what `supabase/functions/publish-run/domain` implements. They are not a claim that a particular study was reproduced.

## Units

A trial is one harness, one condition, one task, and one seed. A pair matches baseline and one treatment on the same task and seed. Tasks are the cluster. Seeds stay inside the task when the bootstrap resamples.

Conditions are `baseline`, `skill` (`SKILL.md`), `agents` (`AGENTS.md`), and `claude` (`CLAUDE.md`). Each treatment is compared only with baseline, and only inside one harness (`claude-code` or `codex`).

## Pass rate

Each condition's pass rate uses every trial in that condition. The 95% Wilson interval uses z = 1.959963984540054. Zero trials have no interval. The interval is not a test against the other condition, and it is not bootstrapped.

## Paired difference

The estimate is `(treatment-only passes − baseline-only passes) / paired trials`.

The interval is a percentile bootstrap: 2,000 draws by default, seed `20261023`, resampling tasks with replacement. The 2.5% and 97.5% indexes are `floor(0.025 × (draws − 1))` and `ceil(0.975 × (draws − 1))` on the sorted draws. Raw pass rates are not bootstrapped.

With fewer than two tasks, or with no paired trials, the interval is unavailable or degenerate.

## Verdict

- `no-winner` when the interval includes zero, including a collapsed interval at exactly zero.
- `uninformative` when there is no interval, or the interval collapses to a non-zero point. A zero-width interval is not treated as a sure winner.
- `winner` only when the interval is non-degenerate and lies entirely above zero (treatment) or entirely below zero (baseline).

## McNemar

The exact two-sided p-value sums the binomial probabilities, under a fair coin on the discordant pairs, that are no larger than the observed split. No discordant pairs leave the p-value unset. The p-value is reported beside the interval. It does not override the verdict rule above.

For 50 or fewer discordant pairs the sum uses binomial coefficients. Above that it uses a log-space sum.

## Cost

USD per passing trial is the condition's total USD divided by its passing trials. Tokens per passing trial use input plus output tokens the same way. Zero passes store null and a warning. The app does not price tokens itself. The record must already contain USD.

## Loaded file

Baseline trials store `instruction_loaded: null`. Every other trial stores true or false. A false value warns that a file which never triggered is not evidence of no effect. Those trials still count in the pass rate. The warning is the point.

## Pins

Every trial carries a CLI version, model id, grader id, and grader sha256. Baseline artifact sha256 is `none`. A treatment artifact sha256 is 64 hex characters. Mixed versions, models, or hashes inside one condition produce a warning. Publication still stores the recomputed summary. The summary's attestation is `owner-supplied` until a future runner writes records itself.
