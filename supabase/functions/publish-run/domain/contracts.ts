// s20.run.v2 canonical contracts (PLAN.md §4–§5).
// Environment-neutral: no process, filesystem, Deno, browser-global or crypto calls in this module.

export const SCHEMA_VERSION = "s20.run.v2" as const;
export const METHOD_VERSION = "s20.taskmean.v1" as const;
export const TOOL_VERSION = "s20-skill-eval-harness 0.2.0" as const;

export const ARM_IDS = ["baseline", "treatment"] as const;
export const ARTIFACT_KINDS = ["none", "skill", "agents-md", "claude-md"] as const;
export const EXPOSURE_MODES = ["none", "native", "explicit-request", "forced-content"] as const;
export const HARNESS_IDS = ["claude-code", "codex", "replay"] as const;
export const ATTEMPT_STATUSES = ["pass", "fail", "timeout", "agent_error", "grader_error", "cancelled"] as const;
/** Statuses that may enter a complete analysable pair (§4 eligibility). */
export const ELIGIBLE_STATUSES = ["pass", "fail", "timeout"] as const;
export const SIDE_STATES = ["planned", "attempted", "not_started"] as const;
export const LEDGER_KINDS = ["plan", "final", "recovery"] as const;
export const ATTESTATIONS = ["runner", "replay-synthetic", "imported"] as const;
export const EXPOSURE_STATUSES = ["observed", "unknown", "unsupported", "confirmed-absent"] as const;
export const EXPOSURE_MECHANISMS = [
  "native-invocation",
  "native-injection",
  "context-report",
  "file-read",
  "owner-claim",
  "none",
] as const;
export const COST_SOURCES = ["reported", "estimated", "unknown"] as const;
export const CLEANUP_STATUSES = ["confirmed", "not_needed", "cleanup_pending"] as const;
export const INTERVENTIONS = ["content-only"] as const;
export const RETRY_SELECTION_POLICY = "last-attempt-after-qualified-startup-retries" as const;
export const LIFECYCLE_STEPS = [
  "planned_at",
  "materialized_at",
  "agent_started_at",
  "first_event_at",
  "agent_terminal_at",
  "grader_terminal_at",
  "finalized_at",
] as const;

export type ArmId = (typeof ARM_IDS)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ExposureMode = (typeof EXPOSURE_MODES)[number];
export type HarnessId = (typeof HARNESS_IDS)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type SideState = (typeof SIDE_STATES)[number];
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export type Attestation = (typeof ATTESTATIONS)[number];
export type ExposureStatus = (typeof EXPOSURE_STATUSES)[number];
export type ExposureMechanism = (typeof EXPOSURE_MECHANISMS)[number];
export type CostSource = (typeof COST_SOURCES)[number];
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];
export type Intervention = (typeof INTERVENTIONS)[number];
export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

/** Lowercase hex SHA-256. */
export type Digest = string;

export interface TaskDescriptor {
  task_id: string;
  display_label: string;
  /** Digest of the base (arm-invariant) task prompt bytes. */
  prompt_digest: Digest;
  fixture_tree_digest: Digest;
  grader_digest: Digest;
  oracle_digest: Digest;
  /** Trusted suite-relative directory for this task. Private prompts/sources stay in the local suite. */
  suite_path: string;
}

export interface Limits {
  first_event_timeout_ms: number;
  agent_timeout_ms: number;
  grader_timeout_ms: number;
  /** Combined stdout/stderr capture cap per process, bytes. */
  max_output_bytes: number;
  max_attempts: number;
  max_usd: number | null;
  max_tokens: number | null;
  /** ISO-8601 wall-clock deadline for dispatching new work. */
  run_deadline: string | null;
  /** Caps stop new work; they are not provider-enforced hard limits. */
  enforcement: "stop-new-work";
}

export interface RetryPolicy {
  /** Default zero. Only startup failures with affirmative complete no-action evidence may retry. */
  startup_retries: number;
  selection: typeof RETRY_SELECTION_POLICY;
}

export interface ArmDescriptor {
  arm_id: ArmId;
  artifact_kind: ArtifactKind;
  /** "none" iff artifact_kind is none. */
  artifact_digest: Digest | "none";
  /** Sorted relative-path/content-digest tree digest of the complete bounded bundle, or "none". */
  bundle_files_digest: Digest | "none";
  exposure_mode: ExposureMode;
  /** Digest of an explicit prompt prefix / content overlay, or "none". */
  prompt_overlay_digest: Digest | "none";
  /** Declared configuration differences from the invariant spec. Content-only intervention requires []. */
  config_differences: string[];
  /** Digest of this descriptor without arm_digest. */
  arm_digest: Digest;
}

export interface SuiteRef {
  suite_id: string;
  version: string;
  digest: Digest;
}

export interface ExperimentSpec {
  schema_version: typeof SCHEMA_VERSION;
  experiment_id: string;
  suite: SuiteRef;
  tasks: TaskDescriptor[];
  harness_id: HarnessId;
  supported_cli_version_range: string;
  pinned_cli_version: string;
  requested_model_id: string;
  resolved_model_policy: "exact" | "alias-unresolved" | "not-applicable";
  effort: string | null;
  base_tool_permission_config: { digest: Digest; summary: string };
  environment_allowlist_names: string[];
  ambient_context_digest: Digest;
  repeats: number;
  scheduling_seed: number;
  retry_policy: RetryPolicy;
  limits: Limits;
  intervention: Intervention;
  arms: [ArmDescriptor, ArmDescriptor];
  /** Digest of invariant configuration (everything except arms and this field). */
  experiment_digest: Digest;
  /** Free-text label, e.g. "synthetic sample — not measured agent behavior". */
  notes: string;
}

export interface PlanSide {
  task_id: string;
  repeat_id: number;
  arm_id: ArmId;
  /** Global seeded dispatch order index. */
  order_index: number;
  /** 0 if this side runs first within its block. */
  order_in_pair: 0 | 1;
  state: SideState;
  attempt_ids: string[];
  selected_attempt_id: string | null;
}

export interface LedgerEdition {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  experiment_digest: Digest;
  edition: number;
  kind: LedgerKind;
  /** Digest of the predecessor edition's canonical bytes, or null for edition 0. */
  predecessor_digest: Digest | null;
  created_at: string;
  sides: PlanSide[];
  note: string;
}

export interface CheckResult {
  check_id: string;
  kind: "file_exists" | "file_contains" | "file_equals" | "command_exit" | "json_score";
  pass: boolean;
  detail: string;
}

export interface GradeEvidence {
  checks: CheckResult[];
  score: number | null;
  snapshot_digest: Digest | null;
}

export interface ExposureEvidence {
  status: ExposureStatus;
  mechanism: ExposureMechanism;
  artifact_digest: Digest | null;
  event_ref: string | null;
}

export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  /** Provider semantics/version label for the counters, or null when unknown. */
  semantics: string | null;
}

export interface Cost {
  usd: number | null;
  source: CostSource;
  pricing_snapshot: string | null;
}

export type Lifecycle = Record<LifecycleStep, string | null>;

export interface AttemptRecord {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  experiment_id: string;
  experiment_digest: Digest;
  task_id: string;
  repeat_id: number;
  arm_id: ArmId;
  arm_digest: Digest;
  attempt_id: string;
  attempt_no: number;
  order_in_pair: 0 | 1;
  cli_reported_version: string | null;
  requested_model_id: string;
  reported_model_id: string | null;
  /** Digest of effective tools/permissions/model/effort configuration actually used. */
  effective_config_digest: Digest;
  ambient_context_digest: Digest;
  base_prompt_digest: Digest;
  effective_prompt_digest: Digest;
  fixture_digest: Digest;
  grader_digest: Digest;
  artifact_digest: Digest | "none";
  lifecycle: Lifecycle;
  status: AttemptStatus;
  terminal_reason: string;
  exit_code: number | null;
  grade: GradeEvidence | null;
  trace: { digest: Digest | null; bytes: number | null; truncated: boolean };
  exposure: ExposureEvidence;
  usage: Usage;
  cost: Cost;
  turns: number | null;
  duration_ms: number | null;
  cleanup: CleanupStatus;
  /** True only with affirmative complete evidence that no agent action occurred before a startup failure. */
  retry_qualified: boolean;
  errors: string[];
  attestation: Attestation;
}

/** Normalized run inputs used for pairing and summaries. */
export interface RunRecords {
  spec: ExperimentSpec;
  ledger: LedgerEdition;
  attempts: AttemptRecord[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Async SHA-256 port supplied by each runtime. Returns lowercase hex. */
export type Sha256Port = (bytes: Uint8Array) => Promise<Digest>;
