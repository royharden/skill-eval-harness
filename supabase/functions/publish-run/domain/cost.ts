import type { CostReport, TrialRecord } from "./types.ts";

export function costOf(trials: TrialRecord[]): CostReport {
  let totalUsd = 0;
  let totalTokens = 0;
  let passes = 0;
  for (const trial of trials) {
    totalUsd += trial.costUsd;
    totalTokens += trial.inputTokens + trial.outputTokens;
    if (trial.passed) passes += 1;
  }
  return {
    totalUsd,
    totalTokens,
    passes,
    usdPerPass: passes === 0 ? null : totalUsd / passes,
    tokensPerPass: passes === 0 ? null : totalTokens / passes,
  };
}
