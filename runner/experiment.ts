// Resolves an owner experiment file + trusted suite + adapter into a sealed ExperimentSpec (PLAN.md §4).
// All overrides are resolved and pinned before dispatch. Env values are never recorded, only names.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { digestOf, utf8 } from "../supabase/functions/publish-run/domain/canonical.ts";
import { RETRY_SELECTION_POLICY, SCHEMA_VERSION, type ExperimentSpec, type ExposureMode, type HarnessId } from "../supabase/functions/publish-run/domain/contracts.ts";
import { sealSpec, type UnsealedSpec } from "../supabase/functions/publish-run/domain/digests.ts";
import { DEFAULT_LIMITS, isSafeId, LIMITS } from "../supabase/functions/publish-run/domain/limits.ts";
import { adapterFor } from "./adapters/index.ts";
import type { Adapter } from "./adapters/types.ts";
import { nodeSha256, sha256Hex } from "./fsutil.ts";
import type { LoadedSuite } from "./suite.ts";

export interface ExperimentFile {
  experiment_id: string;
  suite: string;
  harness: HarnessId;
  model: string;
  effort: string | null;
  repeats: number;
  scheduling_seed: number;
  exposure_mode: Exclude<ExposureMode, "none">;
  /** Pinned owner estimate per side, USD; required for paid dispatch when max_usd is set. */
  estimate_usd_per_side: number | null;
  output_root: string | null;
  environment_allowlist: string[];
  startup_retries: number;
  limits: Partial<{
    first_event_timeout_ms: number;
    agent_timeout_ms: number;
    grader_timeout_ms: number;
    max_output_bytes: number;
    max_attempts: number;
    max_usd: number | null;
    max_tokens: number | null;
    run_deadline: string | null;
  }>;
  notes: string;
}

export class ExperimentError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join("\n"));
  }
}

/** Base env names every child needs to start at all; values pass through, names are recorded. */
export const BASE_ENV_NAMES = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "PATHEXT", "LANG"];

export async function loadExperimentFile(path: string): Promise<{ file: ExperimentFile; dir: string }> {
  const abs = resolve(path);
  const text = await readFile(abs, "utf8");
  if (Buffer.byteLength(text) > 64 * 1024) throw new ExperimentError(["experiment file exceeds 64 KiB"]);
  const y = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true }) as Record<string, unknown> | null;
  const r: string[] = [];
  if (!y || typeof y !== "object") throw new ExperimentError(["experiment file must be a mapping"]);
  if (!isSafeId(y.experiment_id)) r.push("experiment_id must be a safe id");
  if (typeof y.suite !== "string") r.push("suite must be a path to the suite directory");
  if (y.harness !== "claude-code" && y.harness !== "codex" && y.harness !== "replay") r.push("harness must be claude-code, codex or replay");
  if (typeof y.model !== "string" || !y.model.trim()) r.push("model must be a pinned model id (no default is assumed)");
  else if (/^PIN-/i.test(y.model.trim())) r.push("model is still the template placeholder; pin a real model id at authorized activation");
  const repeats = y.repeats ?? 3;
  if (typeof repeats !== "number" || !Number.isInteger(repeats) || repeats < 1 || repeats > LIMITS.repeats) r.push(`repeats must be 1-${LIMITS.repeats}`);
  const seed = y.scheduling_seed ?? 20261023;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) r.push("scheduling_seed must be a 32-bit unsigned integer");
  const mode = y.exposure_mode ?? "native";
  if (mode !== "native" && mode !== "explicit-request" && mode !== "forced-content") r.push("exposure_mode must be native, explicit-request or forced-content");
  const estimate = y.estimate_usd_per_side ?? null;
  if (estimate !== null && (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0)) r.push("estimate_usd_per_side must be null or a non-negative number");
  const allow = y.environment_allowlist ?? [];
  if (!Array.isArray(allow) || !allow.every((n) => typeof n === "string" && /^[A-Z_][A-Z0-9_]{0,127}$/.test(n))) r.push("environment_allowlist must list environment variable NAMES");
  const retries = y.startup_retries ?? 0;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > 3) r.push("startup_retries must be 0-3 (default 0)");
  const limits = (y.limits ?? {}) as ExperimentFile["limits"];
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) r.push("limits must be a mapping");
  else {
    const L = limits as Record<string, unknown>;
    const known = ["first_event_timeout_ms", "agent_timeout_ms", "grader_timeout_ms", "max_output_bytes", "max_attempts", "max_usd", "max_tokens", "run_deadline"];
    for (const k of Object.keys(L)) if (!known.includes(k)) r.push(`limits.${k} is not a known limit`);
    for (const k of ["first_event_timeout_ms", "agent_timeout_ms", "grader_timeout_ms", "max_output_bytes", "max_attempts"]) {
      if (L[k] !== undefined && (typeof L[k] !== "number" || !Number.isInteger(L[k]) || (L[k] as number) < 1)) r.push(`limits.${k} must be a positive integer`);
    }
    if (typeof L.first_event_timeout_ms === "number" && typeof L.agent_timeout_ms === "number" && L.first_event_timeout_ms > L.agent_timeout_ms) r.push("limits.first_event_timeout_ms must not exceed agent_timeout_ms");
    if (L.max_usd !== undefined && L.max_usd !== null && (typeof L.max_usd !== "number" || !Number.isFinite(L.max_usd) || L.max_usd < 0)) r.push("limits.max_usd must be null or a non-negative number");
    if (L.max_tokens !== undefined && L.max_tokens !== null && (typeof L.max_tokens !== "number" || !Number.isInteger(L.max_tokens) || L.max_tokens < 0)) r.push("limits.max_tokens must be null or a non-negative integer");
    if (L.run_deadline !== undefined && L.run_deadline !== null && (typeof L.run_deadline !== "string" || Number.isNaN(Date.parse(L.run_deadline)))) r.push("limits.run_deadline must be null or an ISO timestamp");
  }
  if (r.length) throw new ExperimentError(r);
  return {
    dir: dirname(abs),
    file: {
      experiment_id: y.experiment_id as string,
      suite: y.suite as string,
      harness: y.harness as HarnessId,
      model: (y.model as string).trim(),
      effort: typeof y.effort === "string" ? y.effort : null,
      repeats: repeats as number,
      scheduling_seed: seed as number,
      exposure_mode: mode as ExperimentFile["exposure_mode"],
      estimate_usd_per_side: estimate as number | null,
      output_root: typeof y.output_root === "string" ? y.output_root : null,
      environment_allowlist: allow as string[],
      startup_retries: retries as number,
      limits,
      notes: typeof y.notes === "string" ? y.notes.slice(0, 4000) : "",
    },
  };
}

export interface ResolvedExperiment {
  spec: ExperimentSpec;
  adapter: Adapter;
  file: ExperimentFile;
  /** Overlay text for the treatment arm, or null. */
  overlay: string | null;
  tool_flags: string[];
  /** Digest of the effective configuration actually used per attempt (identical for both arms). */
  effective_config_digest: string;
}

export async function resolveExperiment(file: ExperimentFile, suite: LoadedSuite, ambient: Record<string, unknown>): Promise<ResolvedExperiment> {
  const adapter = adapterFor(file.harness);
  const reasons: string[] = [];
  const refusal = adapter.refuse(suite.candidate.kind, file.exposure_mode);
  if (refusal) reasons.push(refusal);
  if (adapter.capabilities.discovery[suite.candidate.kind] === "unsupported" && file.exposure_mode === "native") {
    reasons.push(`${file.harness} has no supported native discovery for ${suite.candidate.kind}; native mode is refused`);
  }
  if (suite.tasks.length * file.repeats * 2 > LIMITS.plannedSides) reasons.push("tasks x repeats x 2 exceeds the planned-side cap");
  if (reasons.length) throw new ExperimentError(reasons);

  const tools = adapter.tool_permission_config({ requested_model_id: file.model, effort: file.effort });
  const overlay = adapter.overlay(suite.candidate, file.exposure_mode);
  const maxAttempts = file.limits.max_attempts ?? suite.tasks.length * file.repeats * 2 * (1 + file.startup_retries);
  const unsealed: UnsealedSpec = {
    schema_version: SCHEMA_VERSION,
    experiment_id: file.experiment_id,
    suite: { suite_id: suite.suite_id, version: suite.version, digest: suite.digest },
    tasks: suite.tasks.map((t) => t.descriptor),
    harness_id: file.harness,
    supported_cli_version_range: adapter.supported_cli_version_range,
    pinned_cli_version: typeof ambient.cli_version === "string" ? ambient.cli_version : "unknown",
    requested_model_id: file.model,
    resolved_model_policy: file.harness === "replay" ? "not-applicable" : "exact",
    effort: file.effort,
    base_tool_permission_config: { digest: sha256Hex(utf8(JSON.stringify(tools))), summary: tools.summary },
    environment_allowlist_names: [...new Set([...BASE_ENV_NAMES, ...file.environment_allowlist, ...adapter.auth_env_names])].sort(),
    ambient_context_digest: await digestOf(ambient, nodeSha256),
    repeats: file.repeats,
    scheduling_seed: file.scheduling_seed,
    retry_policy: { startup_retries: file.startup_retries, selection: RETRY_SELECTION_POLICY },
    limits: {
      first_event_timeout_ms: file.limits.first_event_timeout_ms ?? DEFAULT_LIMITS.first_event_timeout_ms,
      agent_timeout_ms: file.limits.agent_timeout_ms ?? DEFAULT_LIMITS.agent_timeout_ms,
      grader_timeout_ms: file.limits.grader_timeout_ms ?? DEFAULT_LIMITS.grader_timeout_ms,
      max_output_bytes: file.limits.max_output_bytes ?? DEFAULT_LIMITS.max_output_bytes,
      max_attempts: Math.min(maxAttempts, LIMITS.attempts),
      max_usd: file.limits.max_usd ?? null,
      max_tokens: file.limits.max_tokens ?? null,
      run_deadline: file.limits.run_deadline ?? null,
      enforcement: "stop-new-work",
    },
    intervention: "content-only",
    arms: [
      { arm_id: "baseline", artifact_kind: "none", artifact_digest: "none", bundle_files_digest: "none", exposure_mode: "none", prompt_overlay_digest: "none", config_differences: [] },
      {
        arm_id: "treatment",
        artifact_kind: suite.candidate.kind,
        artifact_digest: suite.candidate.artifact_digest,
        bundle_files_digest: suite.candidate.bundle_files_digest,
        exposure_mode: file.exposure_mode,
        prompt_overlay_digest: overlay === null ? "none" : sha256Hex(utf8(overlay)),
        config_differences: [],
      },
    ],
    notes: file.notes,
  };
  const spec = await sealSpec(unsealed, nodeSha256);
  const effective = await digestOf({ harness: file.harness, model: file.model, effort: file.effort, tools, env_names: unsealed.environment_allowlist_names }, nodeSha256);
  return { spec, adapter, file, overlay, tool_flags: tools.argv_flags, effective_config_digest: effective };
}
