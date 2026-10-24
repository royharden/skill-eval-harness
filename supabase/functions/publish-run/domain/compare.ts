import { bootstrapPairedDifference, makeRng, type TaskCluster } from "./bootstrap.ts";
import { costOf } from "./cost.ts";
import { mcnemarExact } from "./mcnemar.ts";
import { validateBatch } from "./pins.ts";
import {
  DEFAULT_DRAWS,
  DEFAULT_SEED,
  HARNESSES,
  TREATMENT_CONDITIONS,
  type ArmReport,
  type Condition,
  type ConditionReport,
  type Harness,
  type HarnessReport,
  type Summary,
  type TreatmentCondition,
  type TrialRecord,
} from "./types.ts";
import { decideVerdict } from "./verdict.ts";
import { wilsonInterval } from "./wilson.ts";

export interface CompareOptions {
  draws?: number;
  seed?: number;
  random?: () => number;
}

export function compareTrials(
  trials: TrialRecord[],
  options: CompareOptions = {},
): { ok: true; summary: Summary } | { ok: false; errors: string[] } {
  const errors = validateBatch(trials);
  if (trials.length === 0) errors.push("at least one trial is required");
  if (errors.length > 0) return { ok: false, errors };

  const draws = options.draws ?? DEFAULT_DRAWS;
  const seed = options.seed ?? DEFAULT_SEED;
  const harnesses: HarnessReport[] = [];
  const summaryWarnings: string[] = [];

  for (const harness of HARNESSES) {
    const rows = trials.filter((trial) => trial.harness === harness);
    if (rows.length === 0) continue;
    const built = compareHarness(harness, rows, draws, seed, options.random);
    if (!built.ok) return built;
    harnesses.push(built.report);
    summaryWarnings.push(...built.report.warnings);
  }

  if (harnesses.length === 0) return { ok: false, errors: ["no supported harness was present"] };

  return {
    ok: true,
    summary: {
      schemaVersion: 1,
      attestation: "owner-supplied",
      generatedBy: "publish-run",
      bootstrapDraws: draws,
      bootstrapSeed: seed,
      harnesses,
      pins: {
        cliVersions: unique(trials.map((trial) => trial.cliVersion)),
        modelIds: unique(trials.map((trial) => trial.modelId)),
        artifactShas: unique(trials.map((trial) => trial.artifactSha256)),
        graderIds: unique(trials.map((trial) => trial.graderId)),
        graderShas: unique(trials.map((trial) => trial.graderSha256)),
      },
      warnings: unique(summaryWarnings),
    },
  };
}

function compareHarness(
  harness: Harness,
  rows: TrialRecord[],
  draws: number,
  seed: number,
  random: (() => number) | undefined,
): { ok: true; report: HarnessReport } | { ok: false; errors: string[] } {
  const baselineRows = rows.filter((trial) => trial.condition === "baseline");
  const treatments = TREATMENT_CONDITIONS.filter((condition) => rows.some((trial) => trial.condition === condition));
  if (treatments.length > 0 && baselineRows.length === 0) {
    return { ok: false, errors: [`${harness} has treatment trials and no baseline`] };
  }

  const warnings: string[] = [];
  if (treatments.length === 0) warnings.push(`${harness} has no treatment condition to compare.`);
  const baseline = baselineRows.length === 0 ? null : armReport(baselineRows);
  if (baseline) warnings.push(...baseline.warnings);

  const conditions: ConditionReport[] = [];
  for (const condition of treatments) {
    const treatmentRows = rows.filter((trial) => trial.condition === condition);
    const report = compareCondition(condition, baselineRows, treatmentRows, draws, seed, random);
    conditions.push(report);
    warnings.push(...report.warnings);
  }

  return { ok: true, report: { harness, baseline, conditions, warnings } };
}

function compareCondition(
  condition: TreatmentCondition,
  baselineRows: TrialRecord[],
  treatmentRows: TrialRecord[],
  draws: number,
  seed: number,
  random: (() => number) | undefined,
): ConditionReport {
  const baselineByKey = indexByPair(baselineRows);
  const treatmentByKey = indexByPair(treatmentRows);
  const flips = [];
  const unpaired = new Set<string>();

  for (const trial of treatmentRows) {
    const partner = baselineByKey.get(pairKey(trial));
    if (!partner) {
      unpaired.add(trial.id);
      continue;
    }
    flips.push({
      taskId: trial.taskId,
      taskSlug: trial.taskSlug,
      seed: trial.seed,
      baselinePassed: partner.passed,
      treatmentPassed: trial.passed,
      treatmentLoaded: trial.instructionLoaded,
    });
  }
  for (const trial of baselineRows) {
    if (!treatmentByKey.has(pairKey(trial))) unpaired.add(trial.id);
  }

  const counts = { bothPass: 0, bothFail: 0, baselineOnly: 0, treatmentOnly: 0 };
  const clusters = new Map<string, TaskCluster>();
  for (const flip of flips) {
    if (flip.baselinePassed && flip.treatmentPassed) counts.bothPass += 1;
    else if (!flip.baselinePassed && !flip.treatmentPassed) counts.bothFail += 1;
    else if (flip.baselinePassed && !flip.treatmentPassed) counts.baselineOnly += 1;
    else counts.treatmentOnly += 1;

    const existing = clusters.get(flip.taskId);
    const cluster = existing ?? { taskId: flip.taskId, pairs: [] };
    cluster.pairs.push({ baselinePassed: flip.baselinePassed, treatmentPassed: flip.treatmentPassed });
    clusters.set(flip.taskId, cluster);
  }

  const rng = random ?? makeRng(seed);
  const interval = bootstrapPairedDifference([...clusters.values()], draws, rng);
  const decision = decideVerdict(interval, interval?.estimate ?? null);
  const mcnemar = mcnemarExact(counts.treatmentOnly, counts.baselineOnly);
  const treatmentArm = armReport(treatmentRows);
  const baselineArm = armReport(baselineRows);
  const loaded = countLoaded(treatmentRows);
  const warnings = conditionWarnings(condition, treatmentRows, unpaired.size, loaded.notLoaded, treatmentArm.cost.usdPerPass);

  return {
    condition,
    baseline: "baseline",
    trials: treatmentRows.length,
    passes: treatmentArm.passes,
    passRate: treatmentArm.passRate,
    wilson: treatmentArm.wilson,
    baselineTrials: baselineRows.length,
    baselinePasses: baselineArm.passes,
    baselinePassRate: baselineArm.passRate,
    baselineWilson: baselineArm.wilson,
    pairedTrials: flips.length,
    unpairedTrialIds: [...unpaired].sort(),
    flips,
    counts,
    mcnemar,
    pairedDifference: {
      estimate: interval?.estimate ?? null,
      low: interval?.low ?? null,
      high: interval?.high ?? null,
      method: interval ? "task-bootstrap" : "unavailable",
      draws,
      seed,
      degenerate: interval?.degenerate ?? true,
    },
    verdict: decision.verdict,
    winner: decision.winner,
    cost: treatmentArm.cost,
    baselineCost: baselineArm.cost,
    loaded,
    warnings,
  };
}

function armReport(rows: TrialRecord[]): ArmReport {
  const passes = rows.filter((trial) => trial.passed).length;
  const cost = costOf(rows);
  return {
    trials: rows.length,
    passes,
    passRate: rows.length === 0 ? null : passes / rows.length,
    wilson: wilsonInterval(passes, rows.length),
    cost,
    warnings: pinWarnings(rows, false),
  };
}

function conditionWarnings(
  condition: Condition,
  rows: TrialRecord[],
  unpaired: number,
  notLoaded: number,
  usdPerPass: number | null,
): string[] {
  const warnings = pinWarnings(rows, true);
  if (notLoaded > 0) {
    warnings.push(
      `${notLoaded} ${condition} trial(s) did not load the instruction file. A file that never triggered is not evidence of no effect.`,
    );
  }
  if (unpaired > 0) {
    warnings.push(`${unpaired} trial(s) had no pair on (task, seed) and were left out of the paired test.`);
  }
  if (usdPerPass === null) warnings.push("Cost per passing trial is undefined because nothing passed.");
  return warnings;
}

function pinWarnings(rows: TrialRecord[], includeArtifact: boolean): string[] {
  const warnings: string[] = [];
  if (unique(rows.map((trial) => trial.cliVersion)).length > 1) warnings.push("This condition mixes CLI versions.");
  if (unique(rows.map((trial) => trial.modelId)).length > 1) warnings.push("This condition mixes model ids.");
  if (includeArtifact && unique(rows.map((trial) => trial.artifactSha256)).length > 1) {
    warnings.push("This condition mixes instruction hashes, so it is not one pinned file.");
  }
  return warnings;
}

function countLoaded(rows: TrialRecord[]): { applicable: number; loaded: number; notLoaded: number } {
  let loaded = 0;
  let notLoaded = 0;
  for (const trial of rows) {
    if (trial.instructionLoaded === true) loaded += 1;
    if (trial.instructionLoaded === false) notLoaded += 1;
  }
  return { applicable: rows.length, loaded, notLoaded };
}

function indexByPair(rows: TrialRecord[]): Map<string, TrialRecord> {
  return new Map(rows.map((trial) => [pairKey(trial), trial]));
}

function pairKey(trial: TrialRecord): string {
  return `${trial.taskId}\u0000${trial.seed}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
