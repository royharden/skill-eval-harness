// Shared run summary (PLAN.md §9). Observed effects with honest uncertainty; no winner badge, no sign-test gate.

import { compareCodeUnits } from "./canonical.ts";
import {
  ATTEMPT_STATUSES,
  EXPOSURE_STATUSES,
  METHOD_VERSION,
  SCHEMA_VERSION,
  type ArmId,
  type Attestation,
  type AttemptRecord,
  type AttemptStatus,
  type Digest,
  type ExposureStatus,
  type Result,
  type RunRecords,
} from "./contracts.ts";
import { isEligibleStatus, pairRecords, type CompletePair, type Pairing } from "./pairing.ts";
import { BOOTSTRAP_PRNG, BOOTSTRAP_RESAMPLES, clusterBootstrap, mcnemarTwoSided, PERCENTILE_METHOD, type UncertaintyStatus } from "./stats.ts";
import { Z95 } from "./types.ts";
import { wilsonInterval } from "./wilson.ts";

export interface CoverageTotal {
  known_total: number;
  /** Attempts whose value is known / executed attempts. */
  known_attempts: number;
  executed_attempts: number;
  complete: boolean;
}

export interface CostSummary extends CoverageTotal {
  reported_usd: number;
  estimated_usd: number;
  usd_per_passing_attempt: number | null;
  usd_per_task_solved: number | null;
  /** Why the ratios are null, when they are. */
  ratio_note: string | null;
}

export interface ArmSummary {
  arm_id: ArmId;
  planned_sides: number;
  not_started_sides: number;
  selected_attempts: number;
  executed_attempts: number;
  status_counts: Record<AttemptStatus, number>;
  eligible_denominator: number;
  passes: number;
  pass_rate: number | null;
  /** Descriptive only: repeated attempts within a task are correlated. */
  wilson_descriptive: { low: number; high: number } | null;
  distinct_tasks_solved: number;
  operational_success: number | null;
  cost: CostSummary;
  tokens: CoverageTotal & { per_passing_attempt: number | null };
  cache_tokens: CoverageTotal;
  duration_ms: CoverageTotal;
  exposure_counts: Record<ExposureStatus, number>;
}

export interface TaskEffect {
  task_id: string;
  display_label: string;
  complete_pairs: number;
  baseline_passes: number;
  treatment_passes: number;
  d_t: number | null;
  helpful: number;
  harmful: number;
}

export type Direction = "favors-treatment" | "favors-baseline" | "tie" | "unavailable";

export interface RunSummary {
  schema_version: typeof SCHEMA_VERSION;
  method_version: typeof METHOD_VERSION;
  run_id: string;
  experiment_id: string;
  experiment_digest: Digest;
  records_edition_digest: Digest;
  harness_id: string;
  attestations: Attestation[];
  counts: {
    planned_sides: number;
    attempted_sides: number;
    not_started_sides: number;
    pending_sides: number;
    finalized_attempts: number;
    complete_pairs: number;
    contributing_tasks: number;
    tasks: number;
    repeats: number;
    incomplete_blocks: number;
    excluded_attempts: number;
  };
  table: { n00: number; n01: number; n10: number; n11: number };
  effect: {
    primary_task_mean: number | null;
    pooled_descriptive: number | null;
    direction: Direction;
    per_task: TaskEffect[];
  };
  uncertainty: {
    method: "task-cluster percentile bootstrap";
    level: 0.95;
    resamples: number;
    seed: number;
    prng: typeof BOOTSTRAP_PRNG;
    percentile: typeof PERCENTILE_METHOD;
    low: number | null;
    high: number | null;
    status: UncertaintyStatus;
    note: string;
  };
  mcnemar_repeat0: {
    subset: "repeat_id=0 eligible complete pairs, one per task";
    pairs: number;
    tasks_without_repeat0_pair: string[];
    n01: number;
    n10: number;
    discordant: number;
    p_value: number | null;
    note: string;
  };
  arms: { baseline: ArmSummary; treatment: ArmSummary };
  /** Descriptive treatment outcomes split by exposure status. Never the primary effect. */
  exposure_descriptive: Array<{ status: ExposureStatus; selected: number; passes: number }>;
  incomplete: Array<{ task_id: string; repeat_id: number; reasons: string[] }>;
  excluded: Array<{ attempt_id: string; reasons: string[] }>;
  wilson_z: number;
  notes: string[];
}

const UNCERTAINTY_NOTES: Record<UncertaintyStatus, string> = {
  "unavailable-no-pairs": "No eligible complete pairs: no paired estimate.",
  "unavailable-fewer-than-two-tasks": "Fewer than two contributing tasks: the task-cluster interval is unavailable.",
  degenerate: "Degenerate empirical interval (identical task deltas or zero width). This is not certainty.",
  "includes-zero": "The empirical interval includes zero.",
  "above-zero": "The empirical interval lies above zero (favors treatment). The method is not calibrated for decisions.",
  "below-zero": "The empirical interval lies below zero (favors baseline). The method is not calibrated for decisions.",
};

function zeroCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
}

function coverage(values: Array<number | null>): CoverageTotal {
  let known = 0;
  let total = 0;
  for (const v of values) {
    if (v === null) continue;
    known += 1;
    total += v;
  }
  return { known_total: total, known_attempts: known, executed_attempts: values.length, complete: known === values.length };
}

function armSummary(arm: ArmId, records: RunRecords, pairing: Pairing): ArmSummary {
  const sides = records.ledger.sides.filter((s) => s.arm_id === arm);
  const selected = pairing.selected.filter((a) => a.arm_id === arm);
  const executed = pairing.attempts.filter((a) => a.arm_id === arm);
  const status_counts = zeroCounts(ATTEMPT_STATUSES);
  for (const a of selected) status_counts[a.status] += 1;
  const eligible = selected.filter((a) => isEligibleStatus(a.status));
  const passes = selected.filter((a) => a.status === "pass").length;
  const solved = new Set(selected.filter((a) => a.status === "pass").map((a) => a.task_id)).size;

  const usd = coverage(executed.map((a) => a.cost.usd));
  const reported = executed.filter((a) => a.cost.source === "reported").reduce((s, a) => s + (a.cost.usd ?? 0), 0);
  const estimated = executed.filter((a) => a.cost.source === "estimated").reduce((s, a) => s + (a.cost.usd ?? 0), 0);
  let ratioNote: string | null = null;
  if (!usd.complete) ratioNote = "Cost ratios suppressed: cost is unknown for some executed attempts.";
  else if (passes === 0) ratioNote = "Cost ratios undefined: no selected attempt passed.";
  const costRatioOk = ratioNote === null;

  const tokenValues = executed.map((a) => (a.usage.input_tokens === null || a.usage.output_tokens === null ? null : a.usage.input_tokens + a.usage.output_tokens));
  const tokens = coverage(tokenValues);
  const cacheValues = executed.map((a) => (a.usage.cache_read_tokens === null || a.usage.cache_write_tokens === null ? null : a.usage.cache_read_tokens + a.usage.cache_write_tokens));

  const exposure_counts = zeroCounts(EXPOSURE_STATUSES);
  for (const a of selected) exposure_counts[a.exposure.status] += 1;

  return {
    arm_id: arm,
    planned_sides: sides.length,
    not_started_sides: sides.filter((s) => s.state === "not_started").length,
    selected_attempts: selected.length,
    executed_attempts: executed.length,
    status_counts,
    eligible_denominator: eligible.length,
    passes,
    pass_rate: eligible.length === 0 ? null : passes / eligible.length,
    wilson_descriptive: wilsonInterval(passes, eligible.length, Z95),
    distinct_tasks_solved: solved,
    operational_success: sides.length === 0 ? null : passes / sides.length,
    cost: {
      ...usd,
      reported_usd: reported,
      estimated_usd: estimated,
      usd_per_passing_attempt: costRatioOk ? usd.known_total / passes : null,
      usd_per_task_solved: costRatioOk && solved > 0 ? usd.known_total / solved : null,
      ratio_note: ratioNote,
    },
    tokens: { ...tokens, per_passing_attempt: tokens.complete && passes > 0 ? tokens.known_total / passes : null },
    cache_tokens: coverage(cacheValues),
    duration_ms: coverage(executed.map((a) => a.duration_ms)),
    exposure_counts,
  };
}

function directionOf(value: number | null): Direction {
  if (value === null) return "unavailable";
  if (value > 0) return "favors-treatment";
  if (value < 0) return "favors-baseline";
  return "tie";
}

export function summarize(records: RunRecords, pairing: Pairing, recordsEditionDigest: Digest): RunSummary {
  const { spec } = records;
  const pairs = pairing.pairs;
  const table = { n00: 0, n01: 0, n10: 0, n11: 0 };
  for (const p of pairs) {
    if (p.baseline_pass && p.treatment_pass) table.n11 += 1;
    else if (!p.baseline_pass && !p.treatment_pass) table.n00 += 1;
    else if (p.treatment_pass) table.n01 += 1;
    else table.n10 += 1;
  }

  const byTask = new Map<string, CompletePair[]>();
  for (const p of pairs) byTask.set(p.task_id, [...(byTask.get(p.task_id) ?? []), p]);
  const sortedTasks = [...spec.tasks].sort((a, b) => compareCodeUnits(a.task_id, b.task_id));
  const perTask: TaskEffect[] = sortedTasks.map((task) => {
    const list = byTask.get(task.task_id) ?? [];
    const diffSum = list.reduce((s, p) => s + (Number(p.treatment_pass) - Number(p.baseline_pass)), 0);
    return {
      task_id: task.task_id,
      display_label: task.display_label,
      complete_pairs: list.length,
      baseline_passes: list.filter((p) => p.baseline_pass).length,
      treatment_passes: list.filter((p) => p.treatment_pass).length,
      d_t: list.length === 0 ? null : diffSum / list.length,
      helpful: list.filter((p) => p.flip === "helpful").length,
      harmful: list.filter((p) => p.flip === "harmful").length,
    };
  });
  const deltas = perTask.filter((t) => t.d_t !== null).map((t) => t.d_t as number);
  const primary = deltas.length === 0 ? null : deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const pooled = pairs.length === 0 ? null : (table.n01 - table.n10) / pairs.length;
  const interval = clusterBootstrap(deltas, spec.scheduling_seed, BOOTSTRAP_RESAMPLES);

  const repeat0 = pairs.filter((p) => p.repeat_id === 0);
  const r01 = repeat0.filter((p) => p.flip === "helpful").length;
  const r10 = repeat0.filter((p) => p.flip === "harmful").length;
  const repeat0Tasks = new Set(repeat0.map((p) => p.task_id));

  const treatmentSelected = pairing.selected.filter((a: AttemptRecord) => a.arm_id === "treatment");
  const exposureDescriptive = EXPOSURE_STATUSES.map((status) => {
    const rows = treatmentSelected.filter((a) => a.exposure.status === status);
    return { status, selected: rows.length, passes: rows.filter((a) => a.status === "pass").length };
  });

  const notes: string[] = [];
  if (spec.notes) notes.push(spec.notes);
  if (pairing.incomplete.length > 0) notes.push(`${pairing.incomplete.length} block(s) are not complete pairs; missingness can bias the paired estimate.`);
  if (pairing.excluded.length > 0) notes.push(`${pairing.excluded.length} attempt(s) were excluded for pin mismatches and kept as diagnostics.`);
  notes.push("Observed direction is reported without a winner label. Results apply only to this suite and recorded environment.");

  return {
    schema_version: SCHEMA_VERSION,
    method_version: METHOD_VERSION,
    run_id: records.ledger.run_id,
    experiment_id: spec.experiment_id,
    experiment_digest: spec.experiment_digest,
    records_edition_digest: recordsEditionDigest,
    harness_id: spec.harness_id,
    attestations: [...new Set(pairing.attempts.map((a) => a.attestation))].sort(compareCodeUnits),
    counts: {
      planned_sides: pairing.planned_sides,
      attempted_sides: pairing.attempted_sides,
      not_started_sides: pairing.not_started_sides,
      pending_sides: pairing.pending_sides,
      finalized_attempts: pairing.attempts.length,
      complete_pairs: pairs.length,
      contributing_tasks: deltas.length,
      tasks: spec.tasks.length,
      repeats: spec.repeats,
      incomplete_blocks: pairing.incomplete.length,
      excluded_attempts: pairing.excluded.length,
    },
    table,
    effect: { primary_task_mean: primary, pooled_descriptive: pooled, direction: directionOf(primary), per_task: perTask },
    uncertainty: {
      method: "task-cluster percentile bootstrap",
      level: 0.95,
      resamples: interval.resamples,
      seed: interval.seed,
      prng: BOOTSTRAP_PRNG,
      percentile: PERCENTILE_METHOD,
      low: interval.low,
      high: interval.high,
      status: interval.status,
      note: UNCERTAINTY_NOTES[interval.status],
    },
    mcnemar_repeat0: {
      subset: "repeat_id=0 eligible complete pairs, one per task",
      pairs: repeat0.length,
      tasks_without_repeat0_pair: sortedTasks.map((t) => t.task_id).filter((id) => !repeat0Tasks.has(id)),
      n01: r01,
      n10: r10,
      discordant: r01 + r10,
      p_value: mcnemarTwoSided(r01, r10),
      note: r01 + r10 === 0 ? "No discordant repeat-0 pairs: p is undefined." : "Exact two-sided test on predeclared repeat 0 only; other repeats are not pooled or substituted.",
    },
    arms: { baseline: armSummary("baseline", records, pairing), treatment: armSummary("treatment", records, pairing) },
    exposure_descriptive: exposureDescriptive,
    incomplete: pairing.incomplete.map((b) => ({ task_id: b.task_id, repeat_id: b.repeat_id, reasons: b.reasons })),
    excluded: pairing.excluded,
    wilson_z: Z95,
    notes,
  };
}

/** Pair then summarize. */
export function analyze(records: RunRecords, recordsEditionDigest: Digest): Result<{ pairing: Pairing; summary: RunSummary }> {
  const pairing = pairRecords(records);
  if (!pairing.ok) return pairing;
  return { ok: true, value: { pairing: pairing.value, summary: summarize(records, pairing.value, recordsEditionDigest) } };
}
