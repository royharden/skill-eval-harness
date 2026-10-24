import { describe, expect, it } from "vitest";
import { planRun } from "../supabase/functions/publish-run/domain/runners.ts";

const secret = "super-secret-value";

describe("planRun", () => {
  it("refuses a live plan when the binary or key is missing", () => {
    const missing = planRun(request("claude-code", "skill"), { claudeBin: "claude", anthropicApiKey: "" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain("ANTHROPIC_API_KEY");
    expect(missing.error).not.toContain(secret);

    const hidden = planRun(request("codex", "baseline"), { openaiApiKey: secret });
    expect(hidden.ok).toBe(false);
    if (hidden.ok) return;
    expect(hidden.error).toContain("CODEX_BIN");
    expect(hidden.error).not.toContain(secret);
  });

  it("returns an unverified contract without placing the key on the command", () => {
    const plan = planRun(request("claude-code", "agents"), {
      claudeBin: "claude",
      anthropicApiKey: secret,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.flagsStatus).toBe("unverified-contract");
    expect(plan.argv[0]).toBe("claude");
    expect(plan.argv.join(" ")).not.toContain(secret);
    expect(plan.workspaceFiles.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(plan.expectLoaded).toBe(true);
  });

  it("does not place an instruction file on a baseline plan", () => {
    const plan = planRun(request("codex", "baseline"), { codexBin: "codex", openaiApiKey: "present" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.workspaceFiles).toEqual([]);
    expect(plan.expectLoaded).toBe(false);
    expect(plan.argv.slice(1, 3)).toEqual(["exec", "--model"]);
  });

  it("rejects a treatment plan whose artifact pin is none", () => {
    const plan = planRun(
      { ...request("claude-code", "skill"), artifactSha256: "none" },
      { claudeBin: "claude", anthropicApiKey: "present" },
    );
    expect(plan.ok).toBe(false);
  });
});

function request(harness: "claude-code" | "codex", condition: "baseline" | "skill" | "agents" | "claude") {
  return {
    harness,
    condition,
    prompt: "Fix the parser.",
    seed: 1,
    modelId: "model-test",
    artifactSha256: condition === "baseline" ? "none" : "a".repeat(64),
  };
}
