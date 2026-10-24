// Allowlist sanitization for distributable exports (PLAN.md §10). Export is not publication.
// Fields are rebuilt from an allowlist; free-text scrubbing is supplemental, not the primary control.

import type { AttemptRecord, ExperimentSpec, LedgerEdition, Result, RunRecords, Sha256Port } from "./contracts.ts";
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
}

export const DEFAULT_SANITIZE: SanitizeOptions = { keepTaskLabels: false, keepCheckDetails: false, keepNotes: true };

const SCRUBBERS: Array<[RegExp, string]> = [
  [/[A-Za-z]:\\[^\s"'<>|]*/g, "<path>"],
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
    "terminal reasons, errors, tool summary and notes scrubbed for paths, emails and secret-like tokens",
    "environment variable values never present (names only)",
    "experiment digest recomputed for the transformed spec; arm and task content digests unchanged",
  ];
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
    lifecycle: { ...a.lifecycle },
    status: a.status,
    terminal_reason: scrubText(a.terminal_reason),
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
    usage: { ...a.usage },
    cost: { ...a.cost },
    turns: a.turns,
    duration_ms: a.duration_ms,
    cleanup: a.cleanup,
    retry_qualified: a.retry_qualified,
    errors: a.errors.map(scrubText),
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
    suite: { ...s.suite },
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
    retry_policy: { ...s.retry_policy },
    limits: { ...s.limits },
    intervention: s.intervention,
    arms: [
      { ...s.arms[0], config_differences: [...s.arms[0].config_differences] },
      { ...s.arms[1], config_differences: [...s.arms[1].config_differences] },
    ].map(({ arm_digest: _d, ...rest }) => {
      void _d;
      return rest;
    }) as UnsealedSpec["arms"],
    notes: options.keepNotes ? scrubText(s.notes) : "",
  };
  const spec: ExperimentSpec = await sealSpec(unsealed, sha256);
  const ledger: LedgerEdition = { ...records.ledger, experiment_digest: spec.experiment_digest, note: scrubText(records.ledger.note), sides: records.ledger.sides.map((side) => ({ ...side, attempt_ids: [...side.attempt_ids] })) };
  const attempts = records.attempts.map((a) => sanitizeAttempt(a, spec.experiment_digest, options));
  const sanitized: RunRecords = { spec, ledger, attempts };

  const sourceRefs: SourceRef[] = [{ kind: "private-manifest", ref: "manifest.private.json", digest: privateManifest.content_digest, note: "Original private manifest; not distributed." }];
  for (const a of records.attempts) {
    if (a.trace.digest) sourceRefs.push({ kind: "withheld-trace", ref: `traces/${a.attempt_id}`, digest: a.trace.digest, note: "Raw agent trace kept private." });
  }
  sourceRefs.push({ kind: "withheld-prompt", ref: "suite prompts", digest: null, note: "Task prompts and fixtures stay in the local suite; only their digests are exported." });

  const built = await buildEnvelope(sanitized, sha256, {
    kind: "sanitized",
    runtime: Object.fromEntries(Object.entries(privateManifest.runtime).map(([k, v]) => [k, scrubText(v)])),
    sourceRefs,
    transform: { version: SANITIZE_VERSION, rules: sanitizeRules(options), source_manifest_digest: privateManifest.content_digest, source_experiment_digest: s.experiment_digest },
    derivation: "sanitized edition derived from the private records by the allowlist transform; summary recomputed from the sanitized edition",
  });
  if (!built.ok) return built;
  return { ok: true, value: { ...built.value, records: sanitized } };
}
