// Harness adapter contract (PLAN.md §7). Adapters declare version range, argv builder, event parser,
// telemetry semantics, discovery/exposure support, context placement and cancellation support.
// Unsupported execution refuses; unavailable observation is explicit.

import type { ArmDescriptor, ArtifactKind, Cost, ExperimentSpec, ExposureEvidence, ExposureMode, Usage } from "../../supabase/functions/publish-run/domain/contracts.ts";
import type { CandidateArtifact, ResolvedTask } from "../suite.ts";

export type Support = "verified" | "hypothesis" | "unsupported";

export interface AdapterCapabilities {
  /** Whether the harness discovers each artifact kind natively. "hypothesis" = documented, not yet canaried. */
  discovery: Record<Exclude<ArtifactKind, "none">, Support>;
  /** Whether exposure of each kind can be observed from trustworthy events. */
  exposure_observation: Record<Exclude<ArtifactKind, "none">, Support>;
  exposure_modes: Record<Exclude<ExposureMode, "none">, Support>;
  cancellation: "process-tree";
  /** Whether usage/cost come from provider-reported events. */
  telemetry: { usage: Support; cost: Support; semantics: string };
}

export interface AttemptPaths {
  workspace: string;
  /** Per-attempt isolated home/config root (proposed isolation; not proof of exclusion). */
  home: string;
}

export interface InvocationContext {
  spec: ExperimentSpec;
  /** Trusted suite root (never visible to the agent). */
  suite_root: string;
  task: ResolvedTask;
  arm: ArmDescriptor;
  candidate: CandidateArtifact;
  paths: AttemptPaths;
  repeat_id: number;
  attempt_id: string;
  /** Effective prompt after any declared arm overlay. */
  prompt: string;
  /** Child environment already reduced to the allowlist. */
  env: Record<string, string>;
  binary: string;
}

export interface Invocation {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string | null;
}

export interface ParsedState {
  first_event: boolean;
  /** Set once a trustworthy terminal event is parsed. ok=false means the harness reported an error result. */
  terminal: { ok: boolean; reason: string } | null;
  usage: Usage;
  cost: Cost;
  reported_model: string | null;
  cli_version: string | null;
  turns: number | null;
  exposure: ExposureEvidence;
  unknown_events: number;
  malformed_lines: number;
  /** True if events show agent actions (tool use / file writes). Used only to deny startup retries. */
  action_observed: boolean;
  errors: string[];
}

export interface EventParser {
  /** Consumes one stdout line; returns true when the line was a meaningful first event. */
  push(line: string): boolean;
  state(): ParsedState;
}

export interface Adapter {
  harness_id: ExperimentSpec["harness_id"];
  supported_cli_version_range: string;
  /** Environment variable naming the binary, e.g. CLAUDE_BIN. */
  binary_env: string | null;
  /** Provider auth env NAMES the child needs (proposed channel). Values are never read into records or logs. */
  auth_env_names: string[];
  /** Real-home-relative discovery locations whose existence (never contents) preflight reports. */
  discovery_locations: string[];
  capabilities: AdapterCapabilities;
  /** Tool/permission configuration pinned into the experiment (identical for both arms). */
  tool_permission_config(spec: Pick<ExperimentSpec, "requested_model_id" | "effort">): { summary: string; argv_flags: string[] };
  /** Refusal reason when this harness/artifact/exposure combination cannot run, else null. */
  refuse(kind: Exclude<ArtifactKind, "none">, mode: Exclude<ExposureMode, "none">): string | null;
  /** Relative install locations for the treatment artifact inside workspace/home. */
  placement(candidate: CandidateArtifact): { root: "workspace" | "home"; dir: string };
  /** Prompt overlay for explicit-request / forced-content arms (null when none). */
  overlay(candidate: CandidateArtifact, mode: ExposureMode): string | null;
  /** Child environment additions for per-attempt isolation (names only are recorded). */
  isolation_env(paths: AttemptPaths): Record<string, string>;
  invocation(ctx: InvocationContext): Invocation;
  /** workspace lets parsers anchor file-read exposure to the installed artifact path. */
  parser(arm: ArmDescriptor, candidate: CandidateArtifact | null, workspace: string | null): EventParser;
  /** argv to print the CLI version during preflight, or null. */
  version_argv(binary: string): string[] | null;
}

export function emptyParsedState(): ParsedState {
  return {
    first_event: false,
    terminal: null,
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, semantics: null },
    cost: { usd: null, source: "unknown", pricing_snapshot: null },
    reported_model: null,
    cli_version: null,
    turns: null,
    exposure: { status: "unknown", mechanism: "none", artifact_digest: null, event_ref: null },
    unknown_events: 0,
    malformed_lines: 0,
    action_observed: false,
    errors: [],
  };
}

export function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function nonNegNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
