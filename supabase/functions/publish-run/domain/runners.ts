import type { Condition, Harness } from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export interface RunnerEnv {
  claudeBin?: string;
  codexBin?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export interface RunRequest {
  harness: Harness;
  condition: Condition;
  prompt: string;
  seed: number;
  modelId: string;
  artifactSha256: string;
}

export interface AcceptedPlan {
  ok: true;
  flagsStatus: "unverified-contract";
  argv: string[];
  workspaceFiles: Array<{ path: string; description: string }>;
  expectLoaded: boolean;
  note: string;
}

export interface RejectedPlan {
  ok: false;
  error: string;
}

export type RunPlan = AcceptedPlan | RejectedPlan;

/**
 * Builds a command contract for a later host. Does not spawn a process.
 * CLI flags are unverified in this repo. Missing binaries or keys refuse the plan.
 */
export function planRun(request: RunRequest, env: RunnerEnv): RunPlan {
  const shape = validateRequest(request);
  if (shape) return { ok: false, error: shape };

  if (request.harness === "claude-code") {
    const missing = missingNames(!present(env.claudeBin), "CLAUDE_BIN", !present(env.anthropicApiKey), "ANTHROPIC_API_KEY");
    if (missing) return { ok: false, error: missing };
    return {
      ok: true,
      flagsStatus: "unverified-contract",
      argv: [env.claudeBin!.trim(), "-p", request.prompt, "--output-format", "json", "--model", request.modelId],
      workspaceFiles: filesFor(request.condition),
      expectLoaded: request.condition !== "baseline",
      note: "Flags follow the documented Claude Code print mode and have not been executed by this repo.",
    };
  }

  const missing = missingNames(!present(env.codexBin), "CODEX_BIN", !present(env.openaiApiKey), "OPENAI_API_KEY");
  if (missing) return { ok: false, error: missing };
  return {
    ok: true,
    flagsStatus: "unverified-contract",
    argv: [env.codexBin!.trim(), "exec", "--model", request.modelId, request.prompt],
    workspaceFiles: filesFor(request.condition),
    expectLoaded: request.condition !== "baseline",
    note: "Flags follow the documented Codex exec mode and have not been executed by this repo.",
  };
}

function validateRequest(request: RunRequest): string | null {
  if (!request.prompt.trim()) return "A run needs a task prompt.";
  if (!request.modelId.trim()) return "A run needs a model id.";
  if (!Number.isInteger(request.seed) || request.seed < 0) return "Seed must be an integer >= 0.";
  if (request.condition === "baseline") {
    if (request.artifactSha256 !== "none") return "A baseline run must pin artifact sha256 as none.";
    return null;
  }
  if (!SHA256.test(request.artifactSha256)) return "A treatment run must pin a 64-character hex artifact sha256.";
  return null;
}

function filesFor(condition: Condition): Array<{ path: string; description: string }> {
  if (condition === "baseline") return [];
  if (condition === "skill") {
    return [{ path: ".claude/skills/candidate/SKILL.md", description: "Write the pinned skill file here before execution." }];
  }
  if (condition === "agents") {
    return [{ path: "AGENTS.md", description: "Write the pinned AGENTS.md at the workspace root before execution." }];
  }
  return [{ path: "CLAUDE.md", description: "Write the pinned CLAUDE.md at the workspace root before execution." }];
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function missingNames(missingBin: boolean, binName: string, missingKey: boolean, keyName: string): string | null {
  const names: string[] = [];
  if (missingBin) names.push(binName);
  if (missingKey) names.push(keyName);
  if (names.length === 0) return null;
  return `Set ${names.join(" and ")} on the runner host. This planner does not download CLIs, read secret files, or invent a result.`;
}
