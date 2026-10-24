// Codex adapter (PLAN.md §7). Every flag, event shape and discovery root here is a HYPOTHESIS taken from the
// supplied plans; none has been executed by this repo. Activation must check current official docs/help,
// pin the installed binary and run disposable canaries before any capability is marked verified.
//
// Candidate invocation: codex exec --json --model <id> --sandbox workspace-write -- <prompt>
// Candidate native skill root: <workspace>/.agents/skills/<frontmatter-name>/SKILL.md
// A literal "$name" prefix is explicit-request, not forced-content and not proof of loading.
// Injected-fragment exposure is not observable from trustworthy events: exposure stays unknown unless a completed,
// successful (exit 0) read command names the exact SKILL.md path as a whole token.

import type { ArmDescriptor } from "../../supabase/functions/publish-run/domain/contracts.ts";
import type { CandidateArtifact } from "../suite.ts";
import { emptyParsedState, nonNegInt, type Adapter, type EventParser, type InvocationContext } from "./types.ts";

const SKILL_ROOT = ".agents/skills";
const READ_VERBS = /(^|[\s;&|("'])(cat|head|tail|sed|less|more|nl|awk|type|Get-Content|gc)(?=\s)/;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True for a read command naming the exact SKILL.md path as a whole token (optionally under an absolute prefix). */
export function readsSkillFile(command: string, candidateName: string): boolean {
  const c = command.replace(/\\/g, "/");
  const path = escapeRe(`${SKILL_ROOT}/${candidateName}/SKILL.md`);
  const token = new RegExp(`(^|[\\s'"=])((?:\\./)?|[^\\s'"]*/)${path}(?=$|[\\s'"])`);
  return READ_VERBS.test(c) && token.test(c);
}

export function codexParser(arm: ArmDescriptor, candidate: CandidateArtifact | null): EventParser {
  const state = emptyParsedState();
  state.usage.semantics = "codex exec --json turn.completed.usage (hypothesis)";
  const unsupported = arm.arm_id === "baseline" || !candidate || candidate.kind !== "skill" || arm.exposure_mode === "forced-content";
  if (unsupported) state.exposure = { status: "unsupported", mechanism: "none", artifact_digest: null, event_ref: null };
  let line = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let turns = 0;
  let everyTurnHadUsage = true;
  let everyTurnHadCache = true;
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
      switch (event.type) {
        case "thread.started": {
          const first = !state.first_event;
          state.first_event = true;
          return first;
        }
        case "turn.started":
          return false;
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const item = (event.item ?? {}) as Record<string, unknown>;
          if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call") state.action_observed = true;
          if (
            event.type === "item.completed" &&
            !unsupported &&
            candidate &&
            state.exposure.status !== "observed" &&
            item.type === "command_execution" &&
            item.exit_code === 0 &&
            typeof item.command === "string" &&
            readsSkillFile(item.command, candidate.name)
          ) {
            state.exposure = { status: "observed", mechanism: "file-read", artifact_digest: candidate.artifact_digest, event_ref: `stdout:${line}` };
          }
          return false;
        }
        case "turn.completed": {
          const usage = (event.usage ?? {}) as Record<string, unknown>;
          const i = nonNegInt(usage.input_tokens);
          const o = nonNegInt(usage.output_tokens);
          const c = nonNegInt(usage.cached_input_tokens);
          turns += 1;
          if (i === null || o === null) everyTurnHadUsage = false;
          else {
            input += i;
            output += o;
          }
          if (c === null) everyTurnHadCache = false;
          else cached += c;
          state.turns = turns;
          state.usage = {
            input_tokens: everyTurnHadUsage ? input : null,
            output_tokens: everyTurnHadUsage ? output : null,
            cache_read_tokens: everyTurnHadCache ? cached : null,
            cache_write_tokens: null,
            semantics: "codex exec --json turn.completed.usage; input includes cached input (hypothesis)",
          };
          state.terminal = { ok: true, reason: "turn.completed" };
          return false;
        }
        case "turn.failed":
        case "error": {
          const err = (event.error ?? {}) as Record<string, unknown>;
          const message = typeof err.message === "string" ? err.message : typeof event.message === "string" ? event.message : "error event";
          state.terminal = { ok: false, reason: `${String(event.type)}: ${message.slice(0, 300)}` };
          return false;
        }
        default:
          state.unknown_events += 1;
          return false;
      }
    },
    state: () => state,
  };
}

export const codexAdapter: Adapter = {
  harness_id: "codex",
  supported_cli_version_range: "unverified (pin at activation)",
  binary_env: "CODEX_BIN",
  auth_env_names: ["OPENAI_API_KEY"],
  discovery_locations: [".codex/skills", ".agents/skills", ".codex/AGENTS.md", ".codex/config.toml"],
  capabilities: {
    discovery: { skill: "hypothesis", "agents-md": "hypothesis", "claude-md": "unsupported" },
    exposure_observation: { skill: "hypothesis", "agents-md": "unsupported", "claude-md": "unsupported" },
    exposure_modes: { native: "hypothesis", "explicit-request": "hypothesis", "forced-content": "hypothesis" },
    cancellation: "process-tree",
    telemetry: { usage: "hypothesis", cost: "unsupported", semantics: "token counts only; cost stays unknown unless an owner pins rates" },
  },
  tool_permission_config: (spec) => ({
    summary: `sandbox workspace-write (no blanket approval bypass); model ${spec.requested_model_id}`,
    argv_flags: ["--sandbox", "workspace-write"],
  }),
  refuse(kind, mode) {
    if (kind === "claude-md") return "CLAUDE.md under Codex is refused in this version";
    if (kind === "agents-md" && mode === "explicit-request") return "explicit-request applies to skills only";
    return null;
  },
  placement: (candidate) => ({ root: "workspace", dir: candidate.kind === "skill" ? `${SKILL_ROOT}/${candidate.name}` : "." }),
  overlay(candidate, mode) {
    if (mode === "explicit-request") return `$${candidate.name}`;
    if (mode === "forced-content") return `The following instructions apply to this task:\n<instructions>\n${candidate.primary_text}\n</instructions>`;
    return null;
  },
  isolation_env: (paths) => ({ HOME: paths.home, USERPROFILE: paths.home, CODEX_HOME: `${paths.home}/.codex` }),
  invocation(ctx: InvocationContext) {
    const flags = codexAdapter.tool_permission_config(ctx.spec).argv_flags;
    return {
      argv: [ctx.binary, "exec", "--json", "--model", ctx.spec.requested_model_id, ...flags, "--", ctx.prompt],
      env: ctx.env,
      cwd: ctx.paths.workspace,
      stdin: null,
    };
  },
  parser: (arm, candidate) => codexParser(arm, candidate),
  version_argv: (binary) => [binary, "--version"],
};
