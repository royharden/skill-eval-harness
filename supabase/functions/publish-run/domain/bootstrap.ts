export interface TaskCluster {
  taskId: string;
  pairs: Array<{ baselinePassed: boolean; treatmentPassed: boolean }>;
}

export interface BootstrapInterval {
  estimate: number;
  low: number;
  high: number;
  degenerate: boolean;
}

/** mulberry32. Returns values in [0, 1). */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairedDifference(clusters: TaskCluster[]): number | null {
  let pairs = 0;
  let treatmentOnly = 0;
  let baselineOnly = 0;
  for (const cluster of clusters) {
    for (const pair of cluster.pairs) {
      pairs += 1;
      if (!pair.baselinePassed && pair.treatmentPassed) treatmentOnly += 1;
      if (pair.baselinePassed && !pair.treatmentPassed) baselineOnly += 1;
    }
  }
  if (pairs === 0) return null;
  return (treatmentOnly - baselineOnly) / pairs;
}

/**
 * Percentile interval of the paired pass-rate difference.
 * Each draw resamples tasks with replacement and keeps every seed inside a drawn task.
 * `random` must return values in [0, 1).
 */
export function bootstrapPairedDifference(
  clusters: TaskCluster[],
  draws: number,
  random: () => number,
): BootstrapInterval | null {
  if (!Number.isInteger(draws) || draws < 1) {
    throw new Error("Bootstrap draws must be a positive integer");
  }
  if (clusters.length === 0) return null;
  const estimate = pairedDifference(clusters);
  if (estimate === null) return null;
  if (clusters.length < 2) {
    return { estimate, low: estimate, high: estimate, degenerate: true };
  }

  const diffs: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    const picked: TaskCluster[] = [];
    for (let i = 0; i < clusters.length; i += 1) {
      const idx = Math.min(clusters.length - 1, Math.floor(random() * clusters.length));
      const cluster = clusters[idx];
      if (cluster) picked.push(cluster);
    }
    const diff = pairedDifference(picked);
    diffs.push(diff ?? estimate);
  }
  diffs.sort((a, b) => a - b);
  const low = diffs[Math.floor(0.025 * (draws - 1))] ?? estimate;
  const high = diffs[Math.ceil(0.975 * (draws - 1))] ?? estimate;
  return {
    estimate,
    low,
    high,
    degenerate: high - low < 1e-12,
  };
}
