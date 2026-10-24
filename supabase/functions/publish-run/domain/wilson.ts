import { Z95 } from "./types.ts";

export function wilsonInterval(
  successes: number,
  trials: number,
  z: number = Z95,
): { low: number; high: number } | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new Error("Wilson counts must be integers");
  }
  if (trials < 0 || successes < 0 || successes > trials) {
    throw new Error("Wilson successes must be between 0 and the number of trials");
  }
  if (trials === 0) return null;

  const n = trials;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: clamp01(center - margin),
    high: clamp01(center + margin),
  };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
