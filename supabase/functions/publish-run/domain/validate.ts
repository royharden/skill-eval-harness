// Runtime validators: accept unknown data, establish the TypeScript contract (PLAN.md §4–§5).
// One implementation shared by browser, Edge function and Node runner.

import {
  ARM_IDS,
  ARTIFACT_KINDS,
  ATTEMPT_STATUSES,
  ATTESTATIONS,
  CLEANUP_STATUSES,
  COST_SOURCES,
  EXPOSURE_MECHANISMS,
  EXPOSURE_MODES,
  EXPOSURE_STATUSES,
  HARNESS_IDS,
  INTERVENTIONS,
  LEDGER_KINDS,
  LIFECYCLE_STEPS,
  RETRY_SELECTION_POLICY,
  SCHEMA_VERSION,
  SIDE_STATES,
  type ArmDescriptor,
  type AttemptRecord,
  type ExperimentSpec,
  type LedgerEdition,
  type Result,
  type RunRecords,
} from "./contracts.ts";
import { isDigest, isSafeId, LIMITS, relativePathError } from "./limits.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_ERRORS = 200;

class Checker {
  errors: string[] = [];

  fail(path: string, message: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(`${path}: ${message}`);
  }

  obj(value: unknown, path: string): Record<string, unknown> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.fail(path, "must be an object");
      return null;
    }
    return value as Record<string, unknown>;
  }

  arr(value: unknown, path: string, max: number): unknown[] | null {
    if (!Array.isArray(value)) {
      this.fail(path, "must be an array");
      return null;
    }
    if (value.length > max) {
      this.fail(path, `must have at most ${max} items`);
      return null;
    }
    return value;
  }

  str(value: unknown, path: string, max: number = LIMITS.freeTextChars, allowEmpty = true): value is string {
    if (typeof value !== "string") {
      this.fail(path, "must be a string");
      return false;
    }
    if (!allowEmpty && value.trim().length === 0) {
      this.fail(path, "must not be empty");
      return false;
    }
    if (value.length > max) {
      this.fail(path, `must be at most ${max} characters`);
      return false;
    }
    return true;
  }

  nullableStr(value: unknown, path: string, max: number = LIMITS.idChars): void {
    if (value !== null) this.str(value, path, max);
  }

  id(value: unknown, path: string): void {
    if (!isSafeId(value)) this.fail(path, "must be a safe id (letters, digits, . _ : -; at most 256 characters)");
  }

  digest(value: unknown, path: string, allowNone = false): void {
    if (allowNone && value === "none") return;
    if (!isDigest(value)) this.fail(path, allowNone ? 'must be a lowercase SHA-256 hex digest or "none"' : "must be a lowercase SHA-256 hex digest");
  }

  nullableDigest(value: unknown, path: string): void {
    if (value !== null) this.digest(value, path);
  }

  int(value: unknown, path: string, min: number, max: number = Number.MAX_SAFE_INTEGER): void {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      this.fail(path, `must be an integer between ${min} and ${max}`);
    }
  }

  nullableInt(value: unknown, path: string, min = 0): void {
    if (value !== null) this.int(value, path, min);
  }

  nullableNumber(value: unknown, path: string, min = 0): void {
    if (value === null) return;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) this.fail(path, `must be null or a finite number >= ${min}`);
  }

  bool(value: unknown, path: string): void {
    if (typeof value !== "boolean") this.fail(path, "must be true or false");
  }

  oneOf<T extends string>(value: unknown, options: readonly T[], path: string): value is T {
    if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
      this.fail(path, `must be one of ${options.join(", ")}`);
      return false;
    }
    return true;
  }

  iso(value: unknown, path: string, nullable = true): void {
    if (nullable && value === null) return;
    if (typeof value !== "string" || !ISO.test(value) || Number.isNaN(Date.parse(value))) this.fail(path, "must be an ISO-8601 timestamp");
  }

  exact(value: unknown, expected: unknown, path: string): void {
    if (value !== expected) this.fail(path, `must be ${JSON.stringify(expected)}`);
  }
}

function checkArm(c: Checker, value: unknown, path: string, expectedId: string): void {
  const arm = c.obj(value, path);
  if (!arm) return;
  c.exact(arm.arm_id, expectedId, `${path}.arm_id`);
  const kindOk = c.oneOf(arm.artifact_kind, ARTIFACT_KINDS, `${path}.artifact_kind`);
  c.digest(arm.artifact_digest, `${path}.artifact_digest`, true);
  c.digest(arm.bundle_files_digest, `${path}.bundle_files_digest`, true);
  c.oneOf(arm.exposure_mode, EXPOSURE_MODES, `${path}.exposure_mode`);
  c.digest(arm.prompt_overlay_digest, `${path}.prompt_overlay_digest`, true);
  const diffs = c.arr(arm.config_differences, `${path}.config_differences`, 64);
  diffs?.forEach((d, i) => c.str(d, `${path}.config_differences[${i}]`, 512));
  c.digest(arm.arm_digest, `${path}.arm_digest`);
  if (kindOk) {
    const none = arm.artifact_kind === "none";
    if (none !== (arm.artifact_digest === "none")) c.fail(`${path}.artifact_digest`, 'must be "none" exactly when artifact_kind is none');
    if (none !== (arm.bundle_files_digest === "none")) c.fail(`${path}.bundle_files_digest`, 'must be "none" exactly when artifact_kind is none');
  }
  if (expectedId === "baseline") {
    if (arm.artifact_kind !== "none") c.fail(`${path}.artifact_kind`, "baseline must have no artifact");
    if (arm.exposure_mode !== "none") c.fail(`${path}.exposure_mode`, "baseline exposure_mode must be none");
  } else {
    if (arm.artifact_kind === "none") c.fail(`${path}.artifact_kind`, "treatment must have an artifact");
    if (arm.exposure_mode === "none") c.fail(`${path}.exposure_mode`, "treatment needs an exposure mode");
  }
}

function checkSpec(c: Checker, value: unknown): void {
  const s = c.obj(value, "spec");
  if (!s) return;
  c.exact(s.schema_version, SCHEMA_VERSION, "spec.schema_version");
  c.id(s.experiment_id, "spec.experiment_id");
  const suite = c.obj(s.suite, "spec.suite");
  if (suite) {
    c.id(suite.suite_id, "spec.suite.suite_id");
    c.str(suite.version, "spec.suite.version", LIMITS.idChars, false);
    c.digest(suite.digest, "spec.suite.digest");
  }
  const tasks = c.arr(s.tasks, "spec.tasks", LIMITS.tasks);
  const taskIds = new Set<string>();
  if (tasks && tasks.length === 0) c.fail("spec.tasks", "must list at least one task");
  tasks?.forEach((t, i) => {
    const p = `spec.tasks[${i}]`;
    const task = c.obj(t, p);
    if (!task) return;
    c.id(task.task_id, `${p}.task_id`);
    if (typeof task.task_id === "string") {
      if (taskIds.has(task.task_id)) c.fail(`${p}.task_id`, "is duplicated");
      taskIds.add(task.task_id);
    }
    c.str(task.display_label, `${p}.display_label`, 200, false);
    for (const key of ["prompt_digest", "fixture_tree_digest", "grader_digest", "oracle_digest"]) c.digest(task[key], `${p}.${key}`);
    const pathError = relativePathError(task.suite_path);
    if (pathError) c.fail(`${p}.suite_path`, pathError);
  });
  c.oneOf(s.harness_id, HARNESS_IDS, "spec.harness_id");
  c.str(s.supported_cli_version_range, "spec.supported_cli_version_range", LIMITS.idChars, false);
  c.str(s.pinned_cli_version, "spec.pinned_cli_version", LIMITS.idChars, false);
  c.str(s.requested_model_id, "spec.requested_model_id", LIMITS.idChars, false);
  c.oneOf(s.resolved_model_policy, ["exact", "alias-unresolved", "not-applicable"] as const, "spec.resolved_model_policy");
  c.nullableStr(s.effort, "spec.effort");
  const tools = c.obj(s.base_tool_permission_config, "spec.base_tool_permission_config");
  if (tools) {
    c.digest(tools.digest, "spec.base_tool_permission_config.digest");
    c.str(tools.summary, "spec.base_tool_permission_config.summary", 4096);
  }
  const env = c.arr(s.environment_allowlist_names, "spec.environment_allowlist_names", 128);
  env?.forEach((n, i) => {
    if (typeof n !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(n)) c.fail(`spec.environment_allowlist_names[${i}]`, "must be an environment variable name");
  });
  c.digest(s.ambient_context_digest, "spec.ambient_context_digest");
  c.int(s.repeats, "spec.repeats", 1, LIMITS.repeats);
  c.int(s.scheduling_seed, "spec.scheduling_seed", 0, 0xffffffff);
  const retry = c.obj(s.retry_policy, "spec.retry_policy");
  if (retry) {
    c.int(retry.startup_retries, "spec.retry_policy.startup_retries", 0, 3);
    c.exact(retry.selection, RETRY_SELECTION_POLICY, "spec.retry_policy.selection");
  }
  const limits = c.obj(s.limits, "spec.limits");
  if (limits) {
    c.int(limits.first_event_timeout_ms, "spec.limits.first_event_timeout_ms", 1);
    c.int(limits.agent_timeout_ms, "spec.limits.agent_timeout_ms", 1);
    c.int(limits.grader_timeout_ms, "spec.limits.grader_timeout_ms", 1);
    c.int(limits.max_output_bytes, "spec.limits.max_output_bytes", 1);
    c.int(limits.max_attempts, "spec.limits.max_attempts", 1, LIMITS.attempts);
    c.nullableNumber(limits.max_usd, "spec.limits.max_usd");
    c.nullableInt(limits.max_tokens, "spec.limits.max_tokens");
    c.iso(limits.run_deadline, "spec.limits.run_deadline");
    c.exact(limits.enforcement, "stop-new-work", "spec.limits.enforcement");
  }
  c.oneOf(s.intervention, INTERVENTIONS, "spec.intervention");
  const arms = c.arr(s.arms, "spec.arms", 2);
  if (arms) {
    if (arms.length !== 2) c.fail("spec.arms", "must contain exactly baseline then treatment");
    else {
      checkArm(c, arms[0], "spec.arms[0]", "baseline");
      checkArm(c, arms[1], "spec.arms[1]", "treatment");
      const treatment = arms[1] as Partial<ArmDescriptor>;
      if (s.intervention === "content-only" && Array.isArray(treatment.config_differences) && treatment.config_differences.length > 0) {
        c.fail("spec.arms[1].config_differences", "content-only intervention refuses configuration differences");
      }
      if (s.harness_id === "codex" && treatment.artifact_kind === "claude-md") {
        c.fail("spec.arms[1].artifact_kind", "CLAUDE.md under Codex is refused in this version");
      }
    }
  }
  c.digest(s.experiment_digest, "spec.experiment_digest");
  c.str(s.notes, "spec.notes", 4096);
  if (tasks && typeof s.repeats === "number" && tasks.length * s.repeats * 2 > LIMITS.plannedSides) {
    c.fail("spec", `tasks x repeats x 2 exceeds ${LIMITS.plannedSides} planned sides`);
  }
}

function checkLedger(c: Checker, value: unknown): void {
  const l = c.obj(value, "ledger");
  if (!l) return;
  c.exact(l.schema_version, SCHEMA_VERSION, "ledger.schema_version");
  c.id(l.run_id, "ledger.run_id");
  c.digest(l.experiment_digest, "ledger.experiment_digest");
  c.int(l.edition, "ledger.edition", 0, 10_000);
  c.oneOf(l.kind, LEDGER_KINDS, "ledger.kind");
  c.nullableDigest(l.predecessor_digest, "ledger.predecessor_digest");
  if (l.edition === 0 && l.predecessor_digest !== null) c.fail("ledger.predecessor_digest", "edition 0 has no predecessor");
  if (typeof l.edition === "number" && l.edition > 0 && l.predecessor_digest === null) c.fail("ledger.predecessor_digest", "later editions must reference a predecessor");
  c.iso(l.created_at, "ledger.created_at", false);
  c.str(l.note, "ledger.note", 4096);
  const sides = c.arr(l.sides, "ledger.sides", LIMITS.plannedSides);
  sides?.forEach((v, i) => {
    const p = `ledger.sides[${i}]`;
    const side = c.obj(v, p);
    if (!side) return;
    c.id(side.task_id, `${p}.task_id`);
    c.int(side.repeat_id, `${p}.repeat_id`, 0, LIMITS.repeats - 1);
    c.oneOf(side.arm_id, ARM_IDS, `${p}.arm_id`);
    c.int(side.order_index, `${p}.order_index`, 0, LIMITS.plannedSides);
    c.int(side.order_in_pair, `${p}.order_in_pair`, 0, 1);
    c.oneOf(side.state, SIDE_STATES, `${p}.state`);
    const ids = c.arr(side.attempt_ids, `${p}.attempt_ids`, 8);
    ids?.forEach((id, j) => c.id(id, `${p}.attempt_ids[${j}]`));
    if (side.selected_attempt_id !== null) c.id(side.selected_attempt_id, `${p}.selected_attempt_id`);
    if (side.state === "not_started" && (ids?.length ?? 0) > 0) c.fail(p, "a not_started side has no attempts");
    if (side.state === "planned" && (ids?.length ?? 0) > 0) c.fail(p, "a planned side has no attempts yet");
    if (side.state === "attempted" && (ids?.length ?? 0) === 0) c.fail(p, "an attempted side needs attempt ids");
    if (side.selected_attempt_id !== null && !ids?.includes(side.selected_attempt_id)) c.fail(`${p}.selected_attempt_id`, "must be one of attempt_ids");
  });
  if (l.kind === "final" && sides?.some((s) => (s as { state?: unknown })?.state === "planned")) {
    c.fail("ledger.sides", "a final ledger has no sides left in planned state");
  }
}

function checkAttempt(c: Checker, value: unknown, path: string): void {
  const a = c.obj(value, path);
  if (!a) return;
  c.exact(a.schema_version, SCHEMA_VERSION, `${path}.schema_version`);
  for (const key of ["run_id", "experiment_id", "task_id", "attempt_id"]) c.id(a[key], `${path}.${key}`);
  for (const key of ["experiment_digest", "arm_digest", "effective_config_digest", "ambient_context_digest", "base_prompt_digest", "effective_prompt_digest", "fixture_digest", "grader_digest"]) {
    c.digest(a[key], `${path}.${key}`);
  }
  c.digest(a.artifact_digest, `${path}.artifact_digest`, true);
  c.int(a.repeat_id, `${path}.repeat_id`, 0, LIMITS.repeats - 1);
  c.oneOf(a.arm_id, ARM_IDS, `${path}.arm_id`);
  c.int(a.attempt_no, `${path}.attempt_no`, 1, 8);
  c.int(a.order_in_pair, `${path}.order_in_pair`, 0, 1);
  c.nullableStr(a.cli_reported_version, `${path}.cli_reported_version`);
  c.str(a.requested_model_id, `${path}.requested_model_id`, LIMITS.idChars, false);
  c.nullableStr(a.reported_model_id, `${path}.reported_model_id`);
  const life = c.obj(a.lifecycle, `${path}.lifecycle`);
  if (life) for (const step of LIFECYCLE_STEPS) c.iso(life[step], `${path}.lifecycle.${step}`);
  c.oneOf(a.status, ATTEMPT_STATUSES, `${path}.status`);
  c.str(a.terminal_reason, `${path}.terminal_reason`, 1024);
  if (a.exit_code !== null) c.int(a.exit_code, `${path}.exit_code`, -2_147_483_648, 4_294_967_295);
  if (a.grade !== null) {
    const g = c.obj(a.grade, `${path}.grade`);
    if (g) {
      const checks = c.arr(g.checks, `${path}.grade.checks`, 256);
      checks?.forEach((v, i) => {
        const cp = `${path}.grade.checks[${i}]`;
        const chk = c.obj(v, cp);
        if (!chk) return;
        c.id(chk.check_id, `${cp}.check_id`);
        c.oneOf(chk.kind, ["file_exists", "file_contains", "file_equals", "command_exit", "json_score"] as const, `${cp}.kind`);
        c.bool(chk.pass, `${cp}.pass`);
        c.str(chk.detail, `${cp}.detail`, 2048);
      });
      if (g.score !== null && (typeof g.score !== "number" || !(g.score >= 0 && g.score <= 1))) c.fail(`${path}.grade.score`, "must be null or in [0,1]");
      c.nullableDigest(g.snapshot_digest, `${path}.grade.snapshot_digest`);
    }
  }
  if (a.status === "pass") {
    const g = a.grade as { checks?: Array<{ pass?: unknown }> } | null;
    if (!g || !Array.isArray(g.checks) || g.checks.length === 0 || !g.checks.every((chk) => chk?.pass === true)) {
      c.fail(`${path}.status`, "pass requires grader evidence where every declared check passed");
    }
  }
  const trace = c.obj(a.trace, `${path}.trace`);
  if (trace) {
    c.nullableDigest(trace.digest, `${path}.trace.digest`);
    c.nullableInt(trace.bytes, `${path}.trace.bytes`);
    c.bool(trace.truncated, `${path}.trace.truncated`);
  }
  const exp = c.obj(a.exposure, `${path}.exposure`);
  if (exp) {
    c.oneOf(exp.status, EXPOSURE_STATUSES, `${path}.exposure.status`);
    c.oneOf(exp.mechanism, EXPOSURE_MECHANISMS, `${path}.exposure.mechanism`);
    c.nullableDigest(exp.artifact_digest, `${path}.exposure.artifact_digest`);
    c.nullableStr(exp.event_ref, `${path}.exposure.event_ref`, 512);
    if (exp.status === "observed" && exp.mechanism === "none") c.fail(`${path}.exposure.mechanism`, "observed exposure needs a mechanism");
  }
  const usage = c.obj(a.usage, `${path}.usage`);
  if (usage) {
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) c.nullableInt(usage[key], `${path}.usage.${key}`);
    c.nullableStr(usage.semantics, `${path}.usage.semantics`);
  }
  const cost = c.obj(a.cost, `${path}.cost`);
  if (cost) {
    c.nullableNumber(cost.usd, `${path}.cost.usd`);
    c.oneOf(cost.source, COST_SOURCES, `${path}.cost.source`);
    c.nullableStr(cost.pricing_snapshot, `${path}.cost.pricing_snapshot`);
    if ((cost.source === "unknown") !== (cost.usd === null)) c.fail(`${path}.cost`, "usd is null exactly when source is unknown");
  }
  c.nullableInt(a.turns, `${path}.turns`);
  c.nullableInt(a.duration_ms, `${path}.duration_ms`);
  c.oneOf(a.cleanup, CLEANUP_STATUSES, `${path}.cleanup`);
  c.bool(a.retry_qualified, `${path}.retry_qualified`);
  if (a.retry_qualified === true && a.status !== "agent_error") c.fail(`${path}.retry_qualified`, "only startup agent_error attempts can qualify for retry");
  const errs = c.arr(a.errors, `${path}.errors`, 32);
  errs?.forEach((e, i) => c.str(e, `${path}.errors[${i}]`, 2048));
  c.oneOf(a.attestation, ATTESTATIONS, `${path}.attestation`);
}

export function parseSpec(value: unknown): Result<ExperimentSpec> {
  const c = new Checker();
  checkSpec(c, value);
  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: value as ExperimentSpec };
}

export function parseLedger(value: unknown): Result<LedgerEdition> {
  const c = new Checker();
  checkLedger(c, value);
  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: value as LedgerEdition };
}

export function parseAttempt(value: unknown, path = "attempt"): Result<AttemptRecord> {
  const c = new Checker();
  checkAttempt(c, value, path);
  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: value as AttemptRecord };
}

/**
 * Validates spec + ledger + attempts together and checks cross-record consistency:
 * one run, one schema, ledger sides match the spec plan, attempt ids are unique and referenced exactly once.
 */
export function parseRunRecords(spec: unknown, ledger: unknown, attemptsValue: unknown): Result<RunRecords> {
  const c = new Checker();
  checkSpec(c, spec);
  checkLedger(c, ledger);
  const attempts = c.arr(attemptsValue, "attempts", LIMITS.attempts) ?? [];
  attempts.forEach((a, i) => checkAttempt(c, a, `attempts[${i}]`));
  if (c.errors.length) return { ok: false, errors: c.errors };

  const s = spec as ExperimentSpec;
  const l = ledger as LedgerEdition;
  const list = attempts as AttemptRecord[];
  if (l.experiment_digest !== s.experiment_digest) c.fail("ledger.experiment_digest", "does not match spec.experiment_digest");

  const taskIds = new Set(s.tasks.map((t) => t.task_id));
  const sideKeys = new Set<string>();
  const referenced = new Map<string, string>();
  for (const side of l.sides) {
    const key = `${side.task_id}\u0000${side.repeat_id}\u0000${side.arm_id}`;
    if (sideKeys.has(key)) c.fail("ledger.sides", `duplicate side ${side.task_id}/${side.repeat_id}/${side.arm_id}`);
    sideKeys.add(key);
    if (!taskIds.has(side.task_id)) c.fail("ledger.sides", `side task ${side.task_id} is not in the spec`);
    if (side.repeat_id >= s.repeats) c.fail("ledger.sides", `side repeat ${side.repeat_id} exceeds spec repeats`);
    for (const id of side.attempt_ids) {
      if (referenced.has(id)) c.fail("ledger.sides", `attempt ${id} is referenced by two sides`);
      referenced.set(id, key);
    }
  }
  const expectedSides = s.tasks.length * s.repeats * 2;
  if (l.sides.length !== expectedSides) c.fail("ledger.sides", `expected ${expectedSides} planned sides (tasks x repeats x arms), found ${l.sides.length}`);

  const seen = new Set<string>();
  for (const a of list) {
    if (seen.has(a.attempt_id)) c.fail("attempts", `duplicate attempt_id ${a.attempt_id}`);
    seen.add(a.attempt_id);
    if (a.run_id !== l.run_id) c.fail(`attempt ${a.attempt_id}`, "belongs to a different run");
    if (a.experiment_id !== s.experiment_id) c.fail(`attempt ${a.attempt_id}`, "belongs to a different experiment");
    const owner = referenced.get(a.attempt_id);
    if (!owner) c.fail(`attempt ${a.attempt_id}`, "is not referenced by the ledger");
    else if (owner !== `${a.task_id}\u0000${a.repeat_id}\u0000${a.arm_id}`) c.fail(`attempt ${a.attempt_id}`, "identity conflicts with its ledger side");
  }
  for (const id of referenced.keys()) if (!seen.has(id)) c.fail("ledger.sides", `attempt ${id} is referenced but missing`);

  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: { spec: s, ledger: l, attempts: list } };
}
