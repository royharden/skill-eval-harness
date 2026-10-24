// Explicit legacy importer for historical owner-supplied v1 records (PLAN.md §4 first paragraph).
// v1 rows carry no prompt/fixture/config pins and use a "seed" that was never a provider seed or a predeclared
// repeat. Pairing on (task, seed) is therefore UNVERIFIED and no prompt/config pins are invented.

import { compareCodeUnits } from "./canonical.ts";
import { shapeBoundsErrors } from "./limits.ts";
import { validateBatch } from "./pins.ts";
import { trialsFromImport } from "./preview.ts";
import { TREATMENT_CONDITIONS, type Harness, type ImportPayload, type TreatmentCondition, type TrialRecord } from "./types.ts";
import type { Result } from "./contracts.ts";

export const LEGACY_UNAVAILABLE_FIELDS = [
  "experiment/arm digests",
  "base and effective prompt digests",
  "fixture digests",
  "effective tool/permission configuration",
  "ambient context digest",
  "attempt lifecycle and terminal reasons",
  "predeclared repeat ids (repeat-0 McNemar unavailable)",
  "plan ledger (not_started sides unknown)",
  "exposure mechanism (instruction_loaded is an owner claim)",
  "cost source (owner-supplied amounts)",
] as const;

export interface LegacyPair {
  task_id: string;
  legacy_seed: number;
  baseline_pass: boolean;
  treatment_pass: boolean;
  /** Owner claim; not exposure evidence. */
  treatment_loaded_claim: boolean | null;
}

export interface LegacyArm {
  trials: number;
  passes: number;
  owner_usd_total: number;
  owner_tokens_total: number;
}

export interface LegacyComparison {
  harness: Harness;
  treatment: TreatmentCondition;
  pairs: LegacyPair[];
  unpaired_trials: number;
  baseline: LegacyArm;
  treatment_arm: LegacyArm;
  pin_warnings: string[];
}

export interface LegacyView {
  kind: "legacy-v1";
  attestation: "imported";
  pairing: "unverified";
  name: string;
  unavailable_fields: readonly string[];
  comparisons: LegacyComparison[];
}

function arm(rows: TrialRecord[]): LegacyArm {
  return {
    trials: rows.length,
    passes: rows.filter((r) => r.passed).length,
    owner_usd_total: rows.reduce((sum, r) => sum + r.costUsd, 0),
    owner_tokens_total: rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0),
  };
}

export function isLegacyPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.trials) && Array.isArray(v.tasks) && !("manifest" in v);
}

export function importLegacy(value: unknown): Result<LegacyView> {
  const bounds = shapeBoundsErrors(value);
  if (bounds.length) return { ok: false, errors: bounds };
  if (!isLegacyPayload(value)) return { ok: false, errors: ["legacy record must be an object with tasks and trials arrays"] };
  const payload = value as ImportPayload;
  const errors: string[] = [];
  const slugs = new Set<string>();
  for (const task of payload.tasks) {
    if (!task || typeof task !== "object" || typeof task.slug !== "string") {
      errors.push("every legacy task needs a slug");
      continue;
    }
    slugs.add(task.slug);
  }
  for (const trial of payload.trials) {
    if (!trial || typeof trial !== "object") {
      errors.push("every legacy trial must be an object");
      continue;
    }
    if (!slugs.has(trial.task_slug)) errors.push(`task_slug ${String(trial.task_slug)} is not in tasks`);
  }
  if (errors.length) return { ok: false, errors };
  const trials = trialsFromImport(payload);
  const batchErrors = validateBatch(trials);
  if (trials.length === 0) batchErrors.push("at least one trial is required");
  if (batchErrors.length) return { ok: false, errors: batchErrors };

  const comparisons: LegacyComparison[] = [];
  const harnesses = [...new Set(trials.map((t) => t.harness))].sort(compareCodeUnits);
  for (const harness of harnesses) {
    const rows = trials.filter((t) => t.harness === harness);
    const baselineRows = rows.filter((t) => t.condition === "baseline");
    const baselineByKey = new Map(baselineRows.map((t) => [`${t.taskId}\u0000${t.seed}`, t]));
    for (const condition of TREATMENT_CONDITIONS) {
      const treatmentRows = rows.filter((t) => t.condition === condition);
      if (treatmentRows.length === 0) continue;
      const pairs: LegacyPair[] = [];
      const matched = new Set<string>();
      for (const t of treatmentRows) {
        const key = `${t.taskId}\u0000${t.seed}`;
        const b = baselineByKey.get(key);
        if (!b) continue;
        matched.add(key);
        pairs.push({ task_id: t.taskId, legacy_seed: t.seed, baseline_pass: b.passed, treatment_pass: t.passed, treatment_loaded_claim: t.instructionLoaded });
      }
      pairs.sort((a, b) => compareCodeUnits(a.task_id, b.task_id) || a.legacy_seed - b.legacy_seed);
      const unpaired = treatmentRows.length - pairs.length + baselineRows.filter((b) => !matched.has(`${b.taskId}\u0000${b.seed}`)).length;
      const pinWarnings: string[] = [];
      for (const [label, values] of [
        ["CLI versions", rows.map((r) => r.cliVersion)],
        ["model ids", rows.map((r) => r.modelId)],
        ["instruction hashes", treatmentRows.map((r) => r.artifactSha256)],
      ] as const) {
        if (new Set(values).size > 1) pinWarnings.push(`Records mix ${label}.`);
      }
      comparisons.push({ harness, treatment: condition, pairs, unpaired_trials: unpaired, baseline: arm(baselineRows), treatment_arm: arm(treatmentRows), pin_warnings: pinWarnings });
    }
  }
  if (comparisons.length === 0) return { ok: false, errors: ["no treatment condition with a baseline to compare"] };
  return {
    ok: true,
    value: {
      kind: "legacy-v1",
      attestation: "imported",
      pairing: "unverified",
      name: typeof payload.name === "string" ? payload.name.slice(0, 160) : "Legacy record",
      unavailable_fields: LEGACY_UNAVAILABLE_FIELDS,
      comparisons,
    },
  };
}
