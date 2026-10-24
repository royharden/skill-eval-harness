// Synthetic event fixtures in the HYPOTHESIZED shapes of Claude Code stream-json and Codex exec --json.
// They test parser logic only; they are not captures of real CLI output and prove nothing about current CLIs.
import { describe, expect, it } from "vitest";
import type { ArmDescriptor } from "../supabase/functions/publish-run/domain/contracts.ts";
import { claudeAdapter, claudeParser } from "../runner/adapters/claude.ts";
import { codexAdapter, codexParser } from "../runner/adapters/codex.ts";
import type { CandidateArtifact } from "../runner/suite.ts";

const treatment = { arm_id: "treatment" } as ArmDescriptor;
const baseline = { arm_id: "baseline" } as ArmDescriptor;
const skill = { kind: "skill", name: "acme-changelog", artifact_digest: "a".repeat(64), primary_text: "---\nname: acme-changelog\n---\nRules" } as CandidateArtifact;

const CLAUDE = [
  { type: "system", subtype: "init", model: "claude-test-model", claude_code_version: "9.9.9" },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "acme-changelog" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "CHANGELOG.md" } }] } },
  { type: "some_future_event" },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0123, num_turns: 3, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } },
].map((e) => JSON.stringify(e));

const CODEX = [
  { type: "thread.started", thread_id: "t1" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "command_execution", command: "cat .agents/skills/acme-changelog/SKILL.md", exit_code: 0 } },
  { type: "item.completed", item: { type: "file_change", changes: [{ path: "CHANGELOG.md" }] } },
  { type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 30 } },
].map((e) => JSON.stringify(e));

describe("claude parser (hypothesis shapes)", () => {
  it("parses init, Skill invocation exposure, usage and reported cost", () => {
    const p = claudeParser(treatment, skill);
    const firsts = CLAUDE.map((l) => p.push(l));
    expect(firsts[0]).toBe(true);
    const s = p.state();
    expect(s.reported_model).toBe("claude-test-model");
    expect(s.exposure).toMatchObject({ status: "observed", mechanism: "native-invocation" });
    expect(s.terminal).toEqual({ ok: true, reason: "result success" });
    expect(s.cost).toMatchObject({ usd: 0.0123, source: "reported" });
    expect(s.usage.cache_read_tokens).toBe(5);
    expect(s.unknown_events).toBe(1);
    expect(s.action_observed).toBe(true);
  });
  it("never treats final text without a result event as completion", () => {
    const p = claudeParser(treatment, skill);
    p.push(CLAUDE[0]!);
    p.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done!" }] } }));
    expect(p.state().terminal).toBeNull();
  });
  it("marks an error result as not ok and leaves baseline exposure unsupported", () => {
    const p = claudeParser(baseline, null);
    p.push(CLAUDE[0]!);
    p.push(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    expect(p.state().terminal?.ok).toBe(false);
    expect(p.state().exposure.status).toBe("unsupported");
  });
  it("refuses AGENTS.md under Claude and builds shell-free argv with spaces intact", () => {
    expect(claudeAdapter.refuse("agents-md", "native")).not.toBeNull();
    const inv = claudeAdapter.invocation({ spec: { requested_model_id: "m", effort: null }, prompt: "a prompt with spaces", binary: "/bin/claude", paths: { workspace: "/w", home: "/h" }, env: {} } as never);
    expect(inv.argv).toContain("a prompt with spaces");
    expect(inv.argv).not.toContain("--dangerously-skip-permissions");
  });
});

describe("codex parser (hypothesis shapes)", () => {
  it("parses thread start, file-read exposure, summed usage and leaves cost unknown", () => {
    const p = codexParser(treatment, skill);
    expect(CODEX.map((l) => p.push(l))[0]).toBe(true);
    const s = p.state();
    expect(s.exposure).toMatchObject({ status: "observed", mechanism: "file-read" });
    expect(s.usage).toMatchObject({ input_tokens: 200, output_tokens: 30, cache_read_tokens: 50 });
    expect(s.cost.source).toBe("unknown");
    expect(s.terminal?.ok).toBe(true);
  });
  it("keeps exposure unknown without a SKILL.md read and reports turn.failed", () => {
    const p = codexParser(treatment, skill);
    p.push(CODEX[0]!);
    p.push(JSON.stringify({ type: "turn.failed", error: { message: "boom" } }));
    expect(p.state().exposure.status).toBe("unknown");
    expect(p.state().terminal?.ok).toBe(false);
  });
  it("refuses CLAUDE.md under Codex and uses $name only as explicit-request", () => {
    expect(codexAdapter.refuse("claude-md", "native")).not.toBeNull();
    expect(codexAdapter.overlay(skill, "explicit-request")).toBe("$acme-changelog");
    expect(codexAdapter.overlay(skill, "native")).toBeNull();
  });
});
