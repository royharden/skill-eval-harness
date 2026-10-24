// Replay adapter (PLAN.md §7 last bullet): feeds synthetic events and workspace changes through the real
// process host, capture, graders and writer. It never bypasses grading with canned pass booleans.
// The child is this CLI's hidden "__replay-agent" command run by the same Node executable. No model, no spend.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ArmDescriptor } from "../../supabase/functions/publish-run/domain/contracts.ts";
import type { CandidateArtifact } from "../suite.ts";
import { emptyParsedState, nonNegInt, nonNegNumber, type Adapter, type EventParser, type InvocationContext } from "./types.ts";

export const REPLAY_SCHEMA = "s20.replay.v1";

/** Finds replay/<task>/<arm>.r<repeat>.json, falling back to replay/<task>/<arm>.json. */
export function replayScriptPath(suiteRoot: string, taskId: string, armId: string, repeatId: number): string | null {
  const specific = resolve(suiteRoot, "replay", taskId, `${armId}.r${repeatId}.json`);
  if (existsSync(specific)) return specific;
  const general = resolve(suiteRoot, "replay", taskId, `${armId}.json`);
  return existsSync(general) ? general : null;
}

export function replayParser(arm: ArmDescriptor, candidate: CandidateArtifact | null): EventParser {
  const state = emptyParsedState();
  state.usage.semantics = "synthetic replay counters";
  if (arm.arm_id === "baseline") state.exposure = { status: "unsupported", mechanism: "none", artifact_digest: null, event_ref: null };
  let line_no = 0;
  return {
    push(line: string): boolean {
      line_no += 1;
      if (!line.trim()) return false;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        event = parsed as Record<string, unknown>;
      } catch {
        state.malformed_lines += 1;
        return false;
      }
      switch (event.type) {
        case "start": {
          const first = !state.first_event;
          state.first_event = true;
          state.reported_model = typeof event.model === "string" ? event.model : null;
          state.cli_version = typeof event.cli_version === "string" ? event.cli_version : null;
          return first;
        }
        case "exposure":
          if (arm.arm_id === "treatment" && candidate && event.artifact === (candidate.kind === "skill" ? "SKILL.md" : candidate.name)) {
            state.exposure = { status: "observed", mechanism: event.mechanism === "file-read" ? "file-read" : "native-invocation", artifact_digest: candidate.artifact_digest, event_ref: `stdout:${line_no}` };
          }
          return false;
        case "action":
          state.action_observed = true;
          return false;
        case "usage":
          state.usage = {
            input_tokens: nonNegInt(event.input_tokens),
            output_tokens: nonNegInt(event.output_tokens),
            cache_read_tokens: nonNegInt(event.cache_read_tokens),
            cache_write_tokens: nonNegInt(event.cache_write_tokens),
            semantics: "synthetic replay counters",
          };
          {
            const usd = nonNegNumber(event.cost_usd);
            state.cost = usd === null ? { usd: null, source: "unknown", pricing_snapshot: null } : { usd, source: "estimated", pricing_snapshot: "synthetic-replay (no model spend)" };
          }
          state.turns = nonNegInt(event.turns);
          return false;
        case "result":
          state.terminal = event.status === "success" ? { ok: true, reason: "replay result success" } : { ok: false, reason: `replay result ${String(event.status)}` };
          return false;
        default:
          state.unknown_events += 1;
          return false;
      }
    },
    state: () => state,
  };
}

export const replayAdapter: Adapter = {
  harness_id: "replay",
  supported_cli_version_range: "replay-1",
  binary_env: null,
  auth_env_names: [],
  discovery_locations: [],
  capabilities: {
    discovery: { skill: "verified", "agents-md": "verified", "claude-md": "verified" },
    exposure_observation: { skill: "verified", "agents-md": "verified", "claude-md": "verified" },
    exposure_modes: { native: "verified", "explicit-request": "unsupported", "forced-content": "unsupported" },
    cancellation: "process-tree",
    telemetry: { usage: "verified", cost: "verified", semantics: "synthetic replay counters; no model spend" },
  },
  tool_permission_config: () => ({ summary: "replay: scripted file writes only; no tools, no network", argv_flags: [] }),
  refuse: (_kind, mode) => (mode === "native" ? null : "replay supports native exposure mode only"),
  placement: (candidate) => ({ root: "workspace", dir: candidate.kind === "skill" ? `.replay/skills/${candidate.name}` : "." }),
  overlay: () => null,
  isolation_env: (paths) => ({ HOME: paths.home, USERPROFILE: paths.home }),
  invocation(ctx: InvocationContext) {
    const script = replayScriptPath(ctx.suite_root, ctx.task.descriptor.task_id, ctx.arm.arm_id, ctx.repeat_id);
    const cli = process.argv[1] ?? "";
    return {
      argv: script ? [process.execPath, cli, "__replay-agent", script, ctx.paths.workspace] : [],
      env: ctx.env,
      cwd: ctx.paths.workspace,
      stdin: null,
    };
  },
  parser: (arm, candidate) => replayParser(arm, candidate),
  version_argv: () => null,
};
