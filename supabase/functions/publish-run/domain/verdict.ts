import type { VerdictKind, WinnerSide } from "./types.ts";

export function decideVerdict(
  interval: { low: number; high: number; degenerate: boolean } | null,
  estimate: number | null,
): { verdict: VerdictKind; winner: WinnerSide } {
  if (!interval || estimate === null) {
    return { verdict: "uninformative", winner: null };
  }
  const includesZero = interval.low <= 0 && interval.high >= 0;
  if (includesZero) return { verdict: "no-winner", winner: null };
  if (interval.degenerate) return { verdict: "uninformative", winner: null };
  if (estimate > 0 && interval.low > 0) return { verdict: "winner", winner: "treatment" };
  if (estimate < 0 && interval.high < 0) return { verdict: "winner", winner: "baseline" };
  return { verdict: "uninformative", winner: null };
}
