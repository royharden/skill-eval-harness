// Seeded plan (PLAN.md §4 "Plan ledger"): every (task, repeat, arm) side and its dispatch order are fixed before
// dispatch. The scheduling seed controls order only; it is not a provider seed.

import { makeRng } from "../supabase/functions/publish-run/domain/bootstrap.ts";
import { compareCodeUnits } from "../supabase/functions/publish-run/domain/canonical.ts";
import { SCHEMA_VERSION, type ExperimentSpec, type LedgerEdition, type PlanSide } from "../supabase/functions/publish-run/domain/contracts.ts";

export function planSides(spec: ExperimentSpec): PlanSide[] {
  const rng = makeRng(spec.scheduling_seed);
  const blocks: Array<{ task_id: string; repeat_id: number }> = [];
  for (const task of [...spec.tasks].sort((a, b) => compareCodeUnits(a.task_id, b.task_id))) {
    for (let r = 0; r < spec.repeats; r += 1) blocks.push({ task_id: task.task_id, repeat_id: r });
  }
  // Fisher-Yates with the pinned mulberry32 stream.
  for (let i = blocks.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
  }
  const sides: PlanSide[] = [];
  let order = 0;
  for (const block of blocks) {
    const treatmentFirst = rng() < 0.5;
    const arms = treatmentFirst ? (["treatment", "baseline"] as const) : (["baseline", "treatment"] as const);
    arms.forEach((arm, k) => {
      sides.push({ task_id: block.task_id, repeat_id: block.repeat_id, arm_id: arm, order_index: order, order_in_pair: k as 0 | 1, state: "planned", attempt_ids: [], selected_attempt_id: null });
      order += 1;
    });
  }
  return sides;
}

export function initialLedger(spec: ExperimentSpec, runId: string, createdAt: string): LedgerEdition {
  return { schema_version: SCHEMA_VERSION, run_id: runId, experiment_digest: spec.experiment_digest, edition: 0, kind: "plan", predecessor_digest: null, created_at: createdAt, sides: planSides(spec), note: "planned before dispatch" };
}
