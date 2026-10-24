// Allowlist sanitization for distributable exports (PLAN.md §10). Export is not publication.
// Fields are rebuilt from an allowlist; free-text scrubbing is supplemental, not the primary control.

import type { ArmDescriptor, AttemptRecord, ExperimentSpec, LedgerEdition, Result, RunRecords, Sha256Port } from "./contracts.ts";
import { sealSpec, type UnsealedSpec } from "./digests.ts";
import { buildEnvelope, type Envelope, type RunManifest, type SourceRef } from "./manifest.ts";
import type { RunSummary } from "./summary.ts";

export const SANITIZE_VERSION = "s20.sanitize.v1";

export interface SanitizeOptions {
  /** Keep owner task display labels after exact-content review. Default false: labels become "Task NN". */
  keepTaskLabels: boolean;
  /** Keep per-check detail text. Default false: detail becomes "check passed"/"check failed". */
  keepCheckDetails: boolean;
  /** Keep the experiment notes label (scrubbed). Default true. */
  keepNotes: boolean;
  /** Keep attempt terminal reasons and error text (scrubbed). Default false: replaced with status-derived text. */
  keepReasons: boolean;
}

export const DEFAULT_SANITIZE: SanitizeOptions = { keepTaskLabels: false, keepCheckDetails: false, keepNotes: true, keepReasons: false };

/** Runtime keys that may be exported, each with a value pattern; everything else is dropped. */
const RUNTIME_ALLOW: Record<string, RegExp> = {
  os: /^(win32|linux|darwin|freebsd|openbsd|sunos|aix)$/,
  node: /^v\d+\.\d+\.\d+$/,
  cli: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/,
};

export function sanitizeRuntime(runtime: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(RUNTIME_ALLOW)) {
    const value = Object.prototype.hasOwnProperty.call(runtime, key) ? runtime[key] : undefined;
    if (typeof value === "string" && pattern.test(value)) out[key] = value;
  }
  return out;
}

const SCRUBBERS: Array<[RegExp, string]> = [
  // Windows paths may contain spaces ("C:\Program Files\..."): consume to the end of the quoted/line segment.
  [/[A-Za-z]:\\[^"'<>|\r\n]*/g, "<path>"],
  [/\\\\[^\s"'<>|]+/g, "<path>"],
  [/(?:\/Users|\/home|\/root|\/mnt|\/var|\/tmp|\/private)\/[^\s"'<>]*/g, "<path>"],
  [/~\/[^\s"'<>]*/g, "<path>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  [/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}\b/g, "<secret>"],
  [/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/g, "<env-assignment>"],
];

/** Supplemental scrubber for free text that survives the allowlist. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

export function sanitizeRules(options: SanitizeOptions): string[] {
  return [
    "allowlist rebuild of experiment, ledger and attempt fields",
    options.keepTaskLabels ? "task labels kept after owner review (scrubbed)" : "task labels replaced with Task NN",
    "task suite paths withheld",
    options.keepCheckDetails ? "check details kept (scrubbed)" : "check details replaced with pass/fail text",
    "raw trace digests withheld as source_refs; raw traces never exported",
    "exposure event references withheld",
    options.keepReasons ? "terminal reasons and errors kept (scrubbed)" : "terminal reasons replaced with status text; error text withheld",
    "tool summary and notes scrubbed for paths, emails and secret-like tokens",
    "runtime metadata limited to os, node and cli version values of known shape",
    "environment variable values never present (names only)",
    "experiment digest recomputed for the transformed spec; arm and task content digests unchanged",
  ];
}

function armInput(arm: ArmDescriptor): UnsealedSpec["arms"][number] {
  return {
    arm_id: arm.arm_id,
    artifact_kind: arm.artifact_kind,
    artifact_digest: arm.artifact_digest,
    bundle_files_digest: arm.bundle_files_digest,
    exposure_mode: arm.exposure_mode,
    prompt_overlay_digest: arm.prompt_overlay_digest,
    // Copied unchanged: arm digests (and the attempts' pinned arm_digest) must stay valid. Content-only requires [].
    config_differences: [...arm.config_differences],
  };
}

function sanitizeAttempt(a: AttemptRecord, experimentDigest: string, options: SanitizeOptions): AttemptRecord {
  return {
    schema_version: a.schema_version,
    run_id: a.run_id,
    experiment_id: a.experiment_id,
    experiment_digest: experimentDigest,
    task_id: a.task_id,
    repeat_id: a.repeat_id,
    arm_id: a.arm_id,
    arm_digest: a.arm_digest,
    attempt_id: a.attempt_id,
    attempt_no: a.attempt_no,
    order_in_pair: a.order_in_pair,
    cli_reported_version: a.cli_reported_version,
    requested_model_id: a.requested_model_id,
    reported_model_id: a.reported_model_id,
    effective_config_digest: a.effective_config_digest,
    ambient_context_digest: a.ambient_context_digest,
    base_prompt_digest: a.base_prompt_digest,
    effective_prompt_digest: a.effective_prompt_digest,
    fixture_digest: a.fixture_digest,
    grader_digest: a.grader_digest,
    artifact_digest: a.artifact_digest,
    lifecycle: {
      planned_at: a.lifecycle.planned_at,
      materialized_at: a.lifecycle.materialized_at,
      agent_started_at: a.lifecycle.agent_started_at,
      first_event_at: a.lifecycle.first_event_at,
      agent_terminal_at: a.lifecycle.agent_terminal_at,
      grader_terminal_at: a.lifecycle.grader_terminal_at,
      finalized_at: a.lifecycle.finalized_at,
    },
    status: a.status,
    terminal_reason: options.keepReasons ? scrubText(a.terminal_reason) : `status ${a.status}`,
    exit_code: a.exit_code,
    grade: a.grade
      ? {
          checks: a.grade.checks.map((c) => ({
            check_id: c.check_id,
            kind: c.kind,
            pass: c.pass,
            detail: options.keepCheckDetails ? scrubText(c.detail) : c.pass ? "check passed" : "check failed",
          })),
          score: a.grade.score,
          snapshot_digest: a.grade.snapshot_digest,
        }
      : null,
    trace: { digest: null, bytes: null, truncated: a.trace.truncated },
    exposure: { status: a.exposure.status, mechanism: a.exposure.mechanism, artifact_digest: a.exposure.artifact_digest, event_ref: null },
    usage: {
      input_tokens: a.usage.input_tokens,
      output_tokens: a.usage.output_tokens,
      cache_read_tokens: a.usage.cache_read_tokens,
      cache_write_tokens: a.usage.cache_write_tokens,
      semantics: a.usage.semantics === null ? null : scrubText(a.usage.semantics),
    },
    cost: { usd: a.cost.usd, source: a.cost.source, pricing_snapshot: a.cost.pricing_snapshot === null ? null : scrubText(a.cost.pricing_snapshot) },
    turns: a.turns,
    duration_ms: a.duration_ms,
    cleanup: a.cleanup,
    retry_qualified: a.retry_qualified,
    errors: options.keepReasons ? a.errors.map(scrubText) : [],
    attestation: a.attestation,
  };
}

/**
 * Builds the sanitized edition and its envelope from private records. The original private manifest is preserved
 * by the caller; the sanitized manifest records the transform, the private manifest digest and typed source_refs.
 * The summary is recomputed from the exact sanitized outcome edition.
 */
export async function sanitizeForExport(
  records: RunRecords,
  privateManifest: RunManifest,
  sha256: Sha256Port,
  options: SanitizeOptions = DEFAULT_SANITIZE,
): Promise<Result<{ envelope: Envelope; summary: RunSummary; records: RunRecords }>> {
  const s = records.spec;
  const width = String(s.tasks.length).length < 2 ? 2 : String(s.tasks.length).length;
  const unsealed: UnsealedSpec = {
    schema_version: s.schema_version,
    experiment_id: s.experiment_id,
    suite: { suite_id: s.suite.suite_id, version: s.suite.version, digest: s.suite.digest },
    tasks: [...s.tasks]
      .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))
      .map((t, i) => ({
        task_id: t.task_id,
        display_label: options.keepTaskLabels ? scrubText(t.display_label) : `Task ${String(i + 1).padStart(width, "0")}`,
        prompt_digest: t.prompt_digest,
        fixture_tree_digest: t.fixture_tree_digest,
        grader_digest: t.grader_digest,
        oracle_digest: t.oracle_digest,
        suite_path: "withheld",
      })),
    harness_id: s.harness_id,
    supported_cli_version_range: s.supported_cli_version_range,
    pinned_cli_version: s.pinned_cli_version,
    requested_model_id: s.requested_model_id,
    resolved_model_policy: s.resolved_model_policy,
    effort: s.effort,
    base_tool_permission_config: { digest: s.base_tool_permission_config.digest, summary: scrubText(s.base_tool_permission_config.summary) },
    environment_allowlist_names: [...s.environment_allowlist_names],
    ambient_context_digest: s.ambient_context_digest,
    repeats: s.repeats,
    scheduling_seed: s.scheduling_seed,
    retry_policy: { startup_retries: s.retry_policy.startup_retries, selection: s.retry_policy.selection },
    limits: {
      first_event_timeout_ms: s.limits.first_event_timeout_ms,
      agent_timeout_ms: s.limits.agent_timeout_ms,
      grader_timeout_ms: s.limits.grader_timeout_ms,
      max_output_bytes: s.limits.max_output_bytes,
      max_attempts: s.limits.max_attempts,
      max_usd: s.limits.max_usd,
      max_tokens: s.limits.max_tokens,
      run_deadline: s.limits.run_deadline,
      enforcement: s.limits.enforcement,
    },
    intervention: s.intervention,
    arms: [armInput(s.arms[0]), armInput(s.arms[1])],
    notes: options.keepNotes ? scrubText(s.notes) : "",
  };
  const spec: ExperimentSpec = await sealSpec(unsealed, sha256);
  const l = records.ledger;
  const ledger: LedgerEdition = {
    schema_version: l.schema_version,
    run_id: l.run_id,
    experiment_digest: spec.experiment_digest,
    edition: l.edition,
    kind: l.kind,
    predecessor_digest: l.predecessor_digest,
    created_at: l.created_at,
    note: options.keepReasons ? scrubText(l.note) : `${l.kind} edition`,
    sides: l.sides.map((side) => ({
      task_id: side.task_id,
      repeat_id: side.repeat_id,
      arm_id: side.arm_id,
      order_index: side.order_index,
      order_in_pair: side.order_in_pair,
      state: side.state,
      attempt_ids: [...side.attempt_ids],
      selected_attempt_id: side.selected_attempt_id,
    })),
  };
  const attempts = records.attempts.map((a) => sanitizeAttempt(a, spec.experiment_digest, options));
  const sanitized: RunRecords = { spec, ledger, attempts };

  const sourceRefs: SourceRef[] = [{ kind: "private-manifest", ref: "manifest.private.json", digest: privateManifest.content_digest, note: "Original private manifest; not distributed." }];
  for (const a of records.attempts) {
    if (a.trace.digest) sourceRefs.push({ kind: "withheld-trace", ref: `traces/${a.attempt_id}`, digest: a.trace.digest, note: "Raw agent trace kept private." });
  }
  sourceRefs.push({ kind: "withheld-prompt", ref: "suite prompts", digest: null, note: "Task prompts and fixtures stay in the local suite; only their digests are exported." });

  const built = await buildEnvelope(sanitized, sha256, {
    kind: "sanitized",
    runtime: sanitizeRuntime(privateManifest.runtime),
    sourceRefs,
    transform: { version: SANITIZE_VERSION, rules: sanitizeRules(options), source_manifest_digest: privateManifest.content_digest, source_experiment_digest: s.experiment_digest },
    derivation: "sanitized edition derived from the private records by the allowlist transform; summary recomputed from the sanitized edition",
  });
  if (!built.ok) return built;
  return { ok: true, value: { ...built.value, records: sanitized } };
}
