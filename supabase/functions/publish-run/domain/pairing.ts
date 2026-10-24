// Policy attempt selection, eligibility and canonical pairing (PLAN.md §4 "Eligibility and retry selection").
// Block key: (run_id, experiment_digest, task_id, repeat_id). Only declared artifact/exposure differences may vary.

import { compareCodeUnits, sortAttempts } from "./canonical.ts";
import {
  ELIGIBLE_STATUSES,
  type ArmDescriptor,
  type ArmId,
  type AttemptRecord,
  type AttemptStatus,
  type Result,
  type RunRecords,
  type SideState,
  type TaskDescriptor,
} from "./contracts.ts";

export type FlipKind = "helpful" | "harmful" | "both-pass" | "both-fail";

export interface CompletePair {
  task_id: string;
  repeat_id: number;
  baseline: AttemptRecord;
  treatment: AttemptRecord;
  baseline_pass: boolean;
  treatment_pass: boolean;
  flip: FlipKind;
}

export interface SideOutcome {
  state: SideState;
  status: AttemptStatus | null;
  attempt_id: string | null;
  attempts: number;
}

export interface IncompleteBlock {
  task_id: string;
  repeat_id: number;
  reasons: string[];
  baseline: SideOutcome;
  treatment: SideOutcome;
}

export interface Pairing {
  pairs: CompletePair[];
  incomplete: IncompleteBlock[];
  /** Selected attempts kept as diagnostics because a pin did not match. */
  excluded: Array<{ attempt_id: string; reasons: string[] }>;
  /** Policy-selected attempt per attempted side, sorted canonically. */
  selected: AttemptRecord[];
  /** Every finalized attempt including retries, sorted canonically. */
  attempts: AttemptRecord[];
  planned_sides: number;
  attempted_sides: number;
  not_started_sides: number;
  /** Sides still in "planned" state (non-final ledger). */
  pending_sides: number;
}

const ELIGIBLE = new Set<string>(ELIGIBLE_STATUSES);

export function isEligibleStatus(status: AttemptStatus): boolean {
  return ELIGIBLE.has(status);
}

/** Binary outcome under the pinned deadline policy: task timeout maps to failure. */
export function passOf(attempt: AttemptRecord): boolean {
  return attempt.status === "pass";
}

/** Invariant pins every selected attempt must share with the spec. */
function specPinErrors(a: AttemptRecord, records: RunRecords, task: TaskDescriptor | undefined, arm: ArmDescriptor): string[] {
  const { spec } = records;
  const errors: string[] = [];
  if (a.experiment_digest !== spec.experiment_digest) errors.push("experiment digest differs from the spec");
  if (a.arm_digest !== arm.arm_digest) errors.push(`${a.arm_id} arm digest differs from the spec`);
  if (a.artifact_digest !== arm.artifact_digest) errors.push(`${a.arm_id} artifact digest differs from the spec`);
  if (!task) errors.push("task is not in the spec");
  else {
    if (a.base_prompt_digest !== task.prompt_digest) errors.push("base prompt digest differs from the task");
    if (a.fixture_digest !== task.fixture_tree_digest) errors.push("fixture digest differs from the task");
    if (a.grader_digest !== task.grader_digest) errors.push("grader digest differs from the task");
  }
  if (a.requested_model_id !== spec.requested_model_id) errors.push("requested model differs from the spec");
  if (a.ambient_context_digest !== spec.ambient_context_digest) errors.push("ambient context digest differs from the spec");
  if (a.cli_reported_version !== null && a.cli_reported_version !== spec.pinned_cli_version) errors.push("reported CLI version differs from the pinned version");
  if (a.arm_id === "baseline" && a.effective_prompt_digest !== a.base_prompt_digest) errors.push("baseline effective prompt differs from the base prompt");
  if (arm.prompt_overlay_digest === "none" && a.effective_prompt_digest !== a.base_prompt_digest) errors.push("effective prompt differs although the arm declares no overlay");
  return errors;
}

/** Pins both sides of a pair must share (§4: model, CLI, tools, permissions). */
function crossPinErrors(b: AttemptRecord, t: AttemptRecord): string[] {
  const errors: string[] = [];
  if (b.reported_model_id !== t.reported_model_id) errors.push("arms report different models");
  if (b.cli_reported_version !== t.cli_reported_version) errors.push("arms report different CLI versions");
  if (b.effective_config_digest !== t.effective_config_digest) errors.push("arms used different tool/permission/model configuration");
  return errors;
}

function flipOf(baselinePass: boolean, treatmentPass: boolean): FlipKind {
  if (baselinePass && treatmentPass) return "both-pass";
  if (!baselinePass && !treatmentPass) return "both-fail";
  return treatmentPass ? "helpful" : "harmful";
}

/**
 * Recomputes the policy-selected attempt for every side and refuses records whose ledger selection disagrees
 * (no cherry-picked retries). Then pairs blocks and lists incomplete blocks and pin-mismatch exclusions.
 */
export function pairRecords(records: RunRecords): Result<Pairing> {
  const { spec, ledger } = records;
  const errors: string[] = [];
  const attempts = sortAttempts(records.attempts);
  const byId = new Map(attempts.map((a) => [a.attempt_id, a]));
  const tasks = new Map(spec.tasks.map((t) => [t.task_id, t]));
  const arms: Record<ArmId, ArmDescriptor> = { baseline: spec.arms[0], treatment: spec.arms[1] };

  const selectedBySide = new Map<string, AttemptRecord>();
  const sideInfo = new Map<string, SideOutcome>();
  let attempted = 0;
  let notStarted = 0;
  let pending = 0;

  for (const side of ledger.sides) {
    const key = `${side.task_id}\u0000${side.repeat_id}\u0000${side.arm_id}`;
    const sideAttempts = side.attempt_ids
      .map((id) => byId.get(id))
      .filter((a): a is AttemptRecord => a !== undefined)
      .sort((a, b) => a.attempt_no - b.attempt_no);
    if (side.state === "not_started") notStarted += 1;
    if (side.state === "planned") pending += 1;
    let selected: AttemptRecord | null = null;
    if (side.state === "attempted") {
      attempted += 1;
      sideAttempts.forEach((a, i) => {
        if (a.attempt_no !== i + 1) errors.push(`${side.task_id}/${side.repeat_id}/${side.arm_id}: attempt numbers must be 1..n without gaps`);
        if (a.order_in_pair !== side.order_in_pair) errors.push(`${a.attempt_id}: order_in_pair differs from the ledger`);
      });
      const retries = sideAttempts.slice(0, -1);
      if (retries.length > spec.retry_policy.startup_retries) {
        errors.push(`${side.task_id}/${side.repeat_id}/${side.arm_id}: more attempts than the retry policy allows`);
      }
      for (const r of retries) {
        if (!(r.status === "agent_error" && r.retry_qualified)) {
          errors.push(`${r.attempt_id}: a ${r.status} attempt was followed by a retry without qualified no-action evidence`);
        }
      }
      selected = sideAttempts[sideAttempts.length - 1] ?? null;
      if (selected && side.selected_attempt_id !== selected.attempt_id) {
        errors.push(`${side.task_id}/${side.repeat_id}/${side.arm_id}: ledger selection does not follow ${spec.retry_policy.selection}`);
      }
      if (selected) selectedBySide.set(key, selected);
    } else if (side.selected_attempt_id !== null) {
      errors.push(`${side.task_id}/${side.repeat_id}/${side.arm_id}: only attempted sides can select an attempt`);
    }
    sideInfo.set(key, {
      state: side.state,
      status: selected?.status ?? null,
      attempt_id: selected?.attempt_id ?? null,
      attempts: sideAttempts.length,
    });
  }
  if (errors.length) return { ok: false, errors };

  const pairs: CompletePair[] = [];
  const incomplete: IncompleteBlock[] = [];
  const excluded: Array<{ attempt_id: string; reasons: string[] }> = [];
  const emptySide: SideOutcome = { state: "not_started", status: null, attempt_id: null, attempts: 0 };

  const sortedTasks = [...spec.tasks].sort((a, b) => compareCodeUnits(a.task_id, b.task_id));
  for (const task of sortedTasks) {
    for (let repeat = 0; repeat < spec.repeats; repeat += 1) {
      const bKey = `${task.task_id}\u0000${repeat}\u0000baseline`;
      const tKey = `${task.task_id}\u0000${repeat}\u0000treatment`;
      const b = selectedBySide.get(bKey);
      const t = selectedBySide.get(tKey);
      const reasons: string[] = [];
      let pinOk = true;
      for (const [arm, attempt] of [["baseline", b], ["treatment", t]] as const) {
        const info = sideInfo.get(arm === "baseline" ? bKey : tKey) ?? emptySide;
        if (!attempt) {
          reasons.push(`${arm} ${info.state === "planned" ? "not yet run" : "not started"}`);
          continue;
        }
        const pinErrors = specPinErrors(attempt, records, tasks.get(task.task_id), arms[arm]);
        if (pinErrors.length) {
          pinOk = false;
          excluded.push({ attempt_id: attempt.attempt_id, reasons: pinErrors });
          reasons.push(`${arm} pin mismatch`);
        }
        if (!isEligibleStatus(attempt.status)) reasons.push(`${arm} ${attempt.status}`);
        if (attempt.cleanup === "cleanup_pending") reasons.push(`${arm} cleanup pending`);
      }
      if (b && t && pinOk) {
        const cross = crossPinErrors(b, t);
        if (cross.length) {
          excluded.push({ attempt_id: b.attempt_id, reasons: cross }, { attempt_id: t.attempt_id, reasons: cross });
          reasons.push("pin mismatch between arms");
        }
      }
      if (b && t && reasons.length === 0) {
        pairs.push({
          task_id: task.task_id,
          repeat_id: repeat,
          baseline: b,
          treatment: t,
          baseline_pass: passOf(b),
          treatment_pass: passOf(t),
          flip: flipOf(passOf(b), passOf(t)),
        });
      } else {
        incomplete.push({
          task_id: task.task_id,
          repeat_id: repeat,
          reasons,
          baseline: sideInfo.get(bKey) ?? emptySide,
          treatment: sideInfo.get(tKey) ?? emptySide,
        });
      }
    }
  }

  return {
    ok: true,
    value: {
      pairs,
      incomplete,
      excluded,
      selected: sortAttempts([...selectedBySide.values()]),
      attempts,
      planned_sides: ledger.sides.length,
      attempted_sides: attempted,
      not_started_sides: notStarted,
      pending_sides: pending,
    },
  };
}
