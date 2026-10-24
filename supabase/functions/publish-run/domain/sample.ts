// Labelled synthetic v2 sample (PLAN.md §6 last paragraph, §12 M1).
// No agent produced these records. Harmful flips here are fabricated test data, never measured agent behavior.
// Covers helpful/harmful flips, ties, a task timeout, a missing side, a grader error and unknown cost.

import { utf8 } from "./canonical.ts";
import {
  RETRY_SELECTION_POLICY,
  SCHEMA_VERSION,
  type AttemptRecord,
  type AttemptStatus,
  type CostSource,
  type ExposureEvidence,
  type LedgerEdition,
  type PlanSide,
  type RunRecords,
  type Sha256Port,
  type TaskDescriptor,
} from "./contracts.ts";
import { sealSpec, type UnsealedSpec } from "./digests.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

export const SAMPLE_LABEL = "Synthetic sample — fabricated records for demonstrating the report. Not measured agent behavior.";
export const SAMPLE_RUN_ID = "sample-run-20261023";

export type SyntheticCell = AttemptStatus | "missing";
export type SyntheticPlan = Record<string, { label: string; cells: Array<[SyntheticCell, SyntheticCell]>; cost: CostSource }>;

/** Outcomes per task: [repeat0, repeat1, repeat2] x [baseline, treatment]. */
export const SAMPLE_PLAN: SyntheticPlan = {
  "changelog-date-format": { label: "Use ISO dates in release headings", cells: [["fail", "pass"], ["fail", "fail"], ["fail", "pass"]], cost: "reported" },
  "changelog-heading": { label: "Add a release heading in house style", cells: [["fail", "pass"], ["fail", "pass"], ["pass", "pass"]], cost: "reported" },
  "changelog-link-refs": { label: "Keep compare links at the bottom", cells: [["pass", "pass"], ["pass", "fail"], ["pass", "pass"]], cost: "reported" },
  "neutral-add-test": { label: "Add a unit test for the parser (neutral)", cells: [["pass", "pass"], ["pass", "grader_error"], ["missing", "pass"]], cost: "unknown" },
  "neutral-fix-typo": { label: "Fix a README typo (neutral)", cells: [["pass", "pass"], ["pass", "pass"], ["pass", "pass"]], cost: "estimated" },
  "version-metadata": { label: "Record the version in package metadata", cells: [["fail", "pass"], ["fail", "timeout"], ["fail", "pass"]], cost: "reported" },
};

const BASE_TIME = Date.parse("2026-10-23T12:00:00Z");

function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString();
}

export async function buildSampleRecords(sha256: Sha256Port): Promise<RunRecords> {
  return buildSyntheticRecords(SAMPLE_PLAN, sha256);
}

/**
 * Builds valid synthetic v2 records from a per-task outcome plan. Every task must list the same number of repeats.
 * "missing" marks a not_started side. Used by the sample and by analytic test fixtures.
 */
export async function buildSyntheticRecords(PLAN: SyntheticPlan, sha256: Sha256Port, schedulingSeed = 20261023): Promise<RunRecords> {
  const d = (label: string) => sha256(utf8(`synthetic-sample:${label}`));
  const taskIds = Object.keys(PLAN).sort();
  const repeats = PLAN[taskIds[0]!]?.cells.length ?? 0;
  if (taskIds.some((id) => PLAN[id]!.cells.length !== repeats)) throw new Error("synthetic plan tasks must have equal repeat counts");
  const tasks: TaskDescriptor[] = [];
  for (const id of taskIds) {
    tasks.push({
      task_id: id,
      display_label: PLAN[id]!.label,
      prompt_digest: await d(`${id}:prompt`),
      fixture_tree_digest: await d(`${id}:fixture`),
      grader_digest: await d(`${id}:grader`),
      oracle_digest: await d(`${id}:oracle`),
      suite_path: `tasks/${id}`,
    });
  }
  const skillDigest = await d("skill:acme-changelog/SKILL.md");
  const unsealed: UnsealedSpec = {
    schema_version: SCHEMA_VERSION,
    experiment_id: "sample-acme-changelog-skill",
    suite: { suite_id: "acme-changelog", version: "1", digest: await d("suite") },
    tasks,
    harness_id: "replay",
    supported_cli_version_range: "replay",
    pinned_cli_version: "replay-synthetic",
    requested_model_id: "synthetic-model",
    resolved_model_policy: "not-applicable",
    effort: null,
    base_tool_permission_config: { digest: await d("tools"), summary: "synthetic: no tools executed" },
    environment_allowlist_names: [],
    ambient_context_digest: await d("ambient"),
    repeats,
    scheduling_seed: schedulingSeed,
    retry_policy: { startup_retries: 0, selection: RETRY_SELECTION_POLICY },
    limits: { ...DEFAULT_LIMITS, max_attempts: Math.max(1, taskIds.length * repeats * 2), max_usd: null, max_tokens: null, run_deadline: null, enforcement: "stop-new-work" },
    intervention: "content-only",
    arms: [
      { arm_id: "baseline", artifact_kind: "none", artifact_digest: "none", bundle_files_digest: "none", exposure_mode: "none", prompt_overlay_digest: "none", config_differences: [] },
      { arm_id: "treatment", artifact_kind: "skill", artifact_digest: skillDigest, bundle_files_digest: await d("skill-tree"), exposure_mode: "native", prompt_overlay_digest: "none", config_differences: [] },
    ],
    notes: SAMPLE_LABEL,
  };
  const spec = await sealSpec(unsealed, sha256);
  const configDigest = await d("effective-config");

  const sides: PlanSide[] = [];
  const attempts: AttemptRecord[] = [];
  let order = 0;
  for (const task of tasks) {
    const plan = PLAN[task.task_id]!;
    plan.cells.forEach(([bCell, tCell], repeat) => {
      // Deterministic synthetic order: alternate which arm runs first.
      const treatmentFirst = (repeat + task.task_id.length) % 2 === 1;
      const blockBase = order;
      order += 2;
      for (const [armIndex, cell] of [[0, bCell], [1, tCell]] as const) {
        const arm = spec.arms[armIndex];
        const orderInPair: 0 | 1 = (armIndex === 1) === treatmentFirst ? 0 : 1;
        const attemptId = `${task.task_id}.r${repeat}.${arm.arm_id}.a1`;
        const side: PlanSide = {
          task_id: task.task_id,
          repeat_id: repeat,
          arm_id: arm.arm_id,
          order_index: blockBase + orderInPair,
          order_in_pair: orderInPair,
          state: cell === "missing" ? "not_started" : "attempted",
          attempt_ids: cell === "missing" ? [] : [attemptId],
          selected_attempt_id: cell === "missing" ? null : attemptId,
        };
        sides.push(side);
        if (cell === "missing") continue;
        const start = (side.order_index + 1) * 3;
        const isTreatment = arm.arm_id === "treatment";
        const exposure: ExposureEvidence = !isTreatment
          ? { status: "unsupported", mechanism: "none", artifact_digest: null, event_ref: null }
          : repeat === 1
            ? { status: "unknown", mechanism: "none", artifact_digest: null, event_ref: null }
            : { status: "observed", mechanism: "native-invocation", artifact_digest: skillDigest, event_ref: `synthetic-event-${side.order_index}` };
        const graded = cell === "pass" || cell === "fail" || cell === "timeout";
        const costUsd = plan.cost === "unknown" ? null : Number((isTreatment ? 0.041 : 0.029).toFixed(3));
        attempts.push({
          schema_version: SCHEMA_VERSION,
          run_id: SAMPLE_RUN_ID,
          experiment_id: spec.experiment_id,
          experiment_digest: spec.experiment_digest,
          task_id: task.task_id,
          repeat_id: repeat,
          arm_id: arm.arm_id,
          arm_digest: arm.arm_digest,
          attempt_id: attemptId,
          attempt_no: 1,
          order_in_pair: orderInPair,
          cli_reported_version: "replay-synthetic",
          requested_model_id: spec.requested_model_id,
          reported_model_id: "synthetic-model",
          effective_config_digest: configDigest,
          ambient_context_digest: spec.ambient_context_digest,
          base_prompt_digest: task.prompt_digest,
          effective_prompt_digest: task.prompt_digest,
          fixture_digest: task.fixture_tree_digest,
          grader_digest: task.grader_digest,
          artifact_digest: arm.artifact_digest,
          lifecycle: {
            planned_at: at(0),
            materialized_at: at(start),
            agent_started_at: at(start),
            first_event_at: at(start),
            agent_terminal_at: at(start + 2),
            grader_terminal_at: cell === "grader_error" || graded ? at(start + 2) : null,
            finalized_at: at(start + 2),
          },
          status: cell,
          terminal_reason:
            cell === "timeout" ? "agent deadline reached after productive startup" : cell === "grader_error" ? "grader script output was not valid JSON" : "agent exited",
          exit_code: cell === "timeout" ? null : 0,
          grade: graded
            ? {
                checks: [{ check_id: "output-matches", kind: "file_contains", pass: cell === "pass", detail: cell === "pass" ? "synthetic: matched" : "synthetic: did not match" }],
                score: null,
                snapshot_digest: null,
              }
            : null,
          trace: { digest: null, bytes: null, truncated: false },
          exposure,
          usage: {
            input_tokens: plan.cost === "unknown" ? null : isTreatment ? 1800 : 1200,
            output_tokens: plan.cost === "unknown" ? null : isTreatment ? 420 : 380,
            cache_read_tokens: null,
            cache_write_tokens: null,
            semantics: plan.cost === "unknown" ? null : "synthetic",
          },
          cost: { usd: costUsd, source: plan.cost, pricing_snapshot: plan.cost === "estimated" ? "synthetic-rates-2026-10" : null },
          turns: null,
          duration_ms: 120_000,
          cleanup: "confirmed",
          retry_qualified: false,
          errors: [],
          attestation: "replay-synthetic",
        });
      }
    });
  }

  const ledger: LedgerEdition = {
    schema_version: SCHEMA_VERSION,
    run_id: SAMPLE_RUN_ID,
    experiment_digest: spec.experiment_digest,
    edition: 0,
    kind: "final",
    predecessor_digest: null,
    created_at: at(200),
    sides,
    note: SAMPLE_LABEL,
  };
  return { spec, ledger, attempts };
}
