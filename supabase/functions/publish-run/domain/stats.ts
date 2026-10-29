// s20.taskmean.v1 numerics (PLAN.md §9). Pinned conventions live here only.

import { makeRng } from "./bootstrap.ts";

export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_PRNG = "mulberry32" as const;
export const PERCENTILE_METHOD = "linear interpolation at index (B-1)*p" as const;
export const INTERVAL_LEVEL = 0.95;

/** Percentile of an ascending-sorted array with linear interpolation at index (n-1)*p. */
export function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty array");
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (index - lo);
}

export type UncertaintyStatus =
  | "unavailable-no-pairs"
  | "unavailable-fewer-than-two-tasks"
  | "degenerate"
  | "includes-zero"
  | "above-zero"
  | "below-zero";

export interface ClusterInterval {
  low: number | null;
  high: number | null;
  status: UncertaintyStatus;
  resamples: number;
  seed: number;
}

/**
 * Empirical 95% percentile task-cluster bootstrap of delta_task.
 * taskDeltas must be ordered by sorted task id; each resample draws T tasks with replacement (all of a drawn
 * task's paired repeats travel together via its d_t) and records the mean sampled d_t.
 */
export function clusterBootstrap(taskDeltas: number[], seed: number, resamples = BOOTSTRAP_RESAMPLES): ClusterInterval {
  if (!Number.isInteger(resamples) || resamples < 2) throw new Error("resamples must be an integer >= 2");
  const base = { resamples, seed };
  if (taskDeltas.length === 0) return { ...base, low: null, high: null, status: "unavailable-no-pairs" };
  if (taskDeltas.length < 2) return { ...base, low: null, high: null, status: "unavailable-fewer-than-two-tasks" };
  const first = taskDeltas[0]!;
  const identical = taskDeltas.every((d) => d === first);
  const rng = makeRng(seed);
  const t = taskDeltas.length;
  const means = new Array<number>(resamples);
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < t; i += 1) sum += taskDeltas[Math.min(t - 1, Math.floor(rng() * t))]!;
    means[b] = sum / t;
  }
  means.sort((x, y) => x - y);
  const alpha = (1 - INTERVAL_LEVEL) / 2;
  const low = percentileSorted(means, alpha);
  const high = percentileSorted(means, 1 - alpha);
  let status: UncertaintyStatus;
  if (identical || high - low === 0) status = "degenerate";
  else if (low <= 0 && high >= 0) status = "includes-zero";
  else status = low > 0 ? "above-zero" : "below-zero";
  return { ...base, low, high, status };
}

/**
 * Exact two-sided McNemar: D = n01 + n10, m = min(n01, n10), p = min(1, 2 * sum_{k=0..m} C(D,k) 2^-D).
 * D = 0 -> null (no discordance). Summed in log space for stability at large D.
 */
export function mcnemarTwoSided(n01: number, n10: number): number | null {
  if (![n01, n10].every((n) => Number.isInteger(n) && n >= 0)) throw new Error("McNemar counts must be non-negative integers");
  const d = n01 + n10;
  if (d === 0) return null;
  const m = Math.min(n01, n10);
  let logTerm = -d * Math.LN2; // log(C(D,0) * 2^-D)
  let maxLog = logTerm;
  const logs: number[] = [logTerm];
  for (let k = 0; k < m; k += 1) {
    logTerm += Math.log(d - k) - Math.log(k + 1);
    logs.push(logTerm);
    if (logTerm > maxLog) maxLog = logTerm;
  }
  let acc = 0;
  for (const l of logs) acc += Math.exp(l - maxLog);
  const tail = Math.exp(maxLog + Math.log(acc));
  return Math.min(1, 2 * tail);
}
