// Claude Code adapter (PLAN.md §7). Every flag, event shape and discovery root here is a HYPOTHESIS taken from
// the supplied plans; none has been executed by this repo. Activation must check current official docs/help,
// pin the installed binary and run disposable canaries before any capability is marked verified.
//
// Candidate invocation: claude -p <prompt> --output-format stream-json --verbose --model <id> --permission-mode acceptEdits
// Candidate native skill root: <workspace>/.claude/skills/<frontmatter-name>/SKILL.md

import type { ArmDescriptor } from "../../supabase/functions/publish-run/domain/contracts.ts";
import type { CandidateArtifact } from "../suite.ts";
import { emptyParsedState, nonNegInt, nonNegNumber, type Adapter, type EventParser, type InvocationContext } from "./types.ts";

const SKILL_ROOT = ".claude/skills";

function contentBlocks(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>).filter((b) => b && typeof b === "object") : [];
}

export function claudeParser(arm: ArmDescriptor, candidate: CandidateArtifact | null): EventParser {
  const state = emptyParsedState();
  state.usage.semantics = "claude-code stream-json result.usage (hypothesis)";
  if (arm.arm_id === "baseline") state.exposure = { status: "unsupported", mechanism: "none", artifact_digest: null, event_ref: null };
  else if (candidate && candidate.kind !== "skill") state.exposure = { status: "unsupported", mechanism: "none", artifact_digest: null, event_ref: null };
  let line = 0;
  return {
    push(text: string): boolean {
      line += 1;
      if (!text.trim()) return false;
      let event: Record<string, unknown>;
      try {
        const v = JSON.parse(text) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        event = v as Record<string, unknown>;
      } catch {
        state.malformed_lines += 1;
        return false;
      }
      if (event.type === "system" && event.subtype === "init") {
        const first = !state.first_event;
        state.first_event = true;
        if (typeof event.model === "string") state.reported_model = event.model;
        if (typeof event.claude_code_version === "string") state.cli_version = event.claude_code_version;
        return first;
      }
      if (event.type === "assistant") {
        for (const block of contentBlocks(event)) {
          if (block.type !== "tool_use") continue;
          state.action_observed = true;
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (arm.arm_id !== "treatment" || !candidate || candidate.kind !== "skill") continue;
          if (block.name === "Skill" && (input.skill === candidate.name || input.command === candidate.name || input.name === candidate.name)) {
            state.exposure = { status: "observed", mechanism: "native-invocation", artifact_digest: candidate.artifact_digest, event_ref: `stdout:${line}` };
          } else if (block.name === "Read" && typeof input.file_path === "string" && input.file_path.replace(/\\/g, "/").endsWith(`${SKILL_ROOT}/${candidate.name}/SKILL.md`) && state.exposure.status !== "observed") {
            state.exposure = { status: "observed", mechanism: "file-read", artifact_digest: candidate.artifact_digest, event_ref: `stdout:${line}` };
          }
        }
        return false;
      }
      if (event.type === "user") return false;
      if (event.type === "result") {
        const isError = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
        state.terminal = isError ? { ok: false, reason: `result ${String(event.subtype)}${event.is_error === true ? " (is_error)" : ""}` } : { ok: true, reason: "result success" };
        const usage = (event.usage ?? {}) as Record<string, unknown>;
        state.usage = {
          input_tokens: nonNegInt(usage.input_tokens),
          output_tokens: nonNegInt(usage.output_tokens),
          cache_read_tokens: nonNegInt(usage.cache_read_input_tokens),
          cache_write_tokens: nonNegInt(usage.cache_creation_input_tokens),
          semantics: "claude-code stream-json result.usage (hypothesis)",
        };
        const usd = nonNegNumber(event.total_cost_usd);
        state.cost = usd === null ? { usd: null, source: "unknown", pricing_snapshot: null } : { usd, source: "reported", pricing_snapshot: "claude-code total_cost_usd (CLI-reported)" };
        state.turns = nonNegInt(event.num_turns);
        return false;
      }
      state.unknown_events += 1;
      return false;
    },
    state: () => state,
  };
}

export const claudeAdapter: Adapter = {
  harness_id: "claude-code",
  supported_cli_version_range: "unverified (pin at activation)",
  binary_env: "CLAUDE_BIN",
  auth_env_names: ["ANTHROPIC_API_KEY"],
  discovery_locations: [".claude/skills", ".claude/CLAUDE.md", ".claude/settings.json"],
  capabilities: {
    discovery: { skill: "hypothesis", "agents-md": "unsupported", "claude-md": "hypothesis" },
    exposure_observation: { skill: "hypothesis", "agents-md": "unsupported", "claude-md": "unsupported" },
    exposure_modes: { native: "hypothesis", "explicit-request": "hypothesis", "forced-content": "hypothesis" },
    cancellation: "process-tree",
    telemetry: { usage: "hypothesis", cost: "hypothesis", semantics: "stream-json result usage and total_cost_usd" },
  },
  tool_permission_config: (spec) => ({
    summary: `permission-mode acceptEdits (file edits only, no blanket bypass); model ${spec.requested_model_id}; effort flag none`,
    argv_flags: ["--permission-mode", "acceptEdits"],
  }),
  refuse(kind, mode) {
    if (kind === "agents-md") return "Claude Code is not assumed to read AGENTS.md; this combination is refused until verified";
    if (kind === "claude-md" && mode === "explicit-request") return "explicit-request applies to skills only";
    return null;
  },
  placement: (candidate) => ({ root: "workspace", dir: candidate.kind === "skill" ? `${SKILL_ROOT}/${candidate.name}` : "." }),
  overlay(candidate, mode) {
    if (mode === "explicit-request") return `Use the ${candidate.name} skill for this task.`;
    if (mode === "forced-content") return `The following instructions apply to this task:\n<instructions>\n${candidate.primary_text}\n</instructions>`;
    return null;
  },
  isolation_env: (paths) => ({ HOME: paths.home, USERPROFILE: paths.home, CLAUDE_CONFIG_DIR: `${paths.home}/.claude` }),
  invocation(ctx: InvocationContext) {
    const flags = claudeAdapter.tool_permission_config(ctx.spec).argv_flags;
    return {
      argv: [ctx.binary, "-p", ctx.prompt, "--output-format", "stream-json", "--verbose", "--model", ctx.spec.requested_model_id, ...flags],
      env: ctx.env,
      cwd: ctx.paths.workspace,
      stdin: null,
    };
  },
  parser: (arm, candidate) => claudeParser(arm, candidate),
  version_argv: (binary) => [binary, "--version"],
};
