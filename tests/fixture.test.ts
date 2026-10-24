import { describe, expect, it } from "vitest";
import { fixturePayload } from "../supabase/functions/publish-run/domain/fixture.ts";
import { validateTrial } from "../supabase/functions/publish-run/domain/pins.ts";
import { previewImport } from "../supabase/functions/publish-run/domain/preview.ts";
import type { TrialRecord } from "../supabase/functions/publish-run/domain/types.ts";

describe("sample fixture", () => {
  it("validates and warns that one skill trial did not load", () => {
    const preview = previewImport(fixturePayload(), { draws: 50, seed: 20261023 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.trials.every((trial) => validateTrial(trial).length === 0)).toBe(true);
    const skill = preview.summary.harnesses[0]?.conditions.find((condition) => condition.condition === "skill");
    expect(skill?.loaded.notLoaded).toBe(1);
    expect(skill?.warnings.some((warning) => warning.includes("did not load"))).toBe(true);
    expect(skill?.pairedTrials).toBe(4);
    expect(preview.summary.attestation).toBe("owner-supplied");
  });
});

describe("pins", () => {
  it("rejects a baseline hash and a baseline loaded flag", () => {
    const errors = validateTrial(base({ artifactSha256: "a".repeat(64), instructionLoaded: true }));
    expect(errors.some((error) => error.includes("artifact sha"))).toBe(true);
    expect(errors.some((error) => error.includes("instructionLoaded"))).toBe(true);
  });

  it("rejects a treatment pin of none and a missing loaded flag", () => {
    const errors = validateTrial(
      base({
        condition: "skill",
        artifactSha256: "none",
        instructionLoaded: null,
      }),
    );
    expect(errors.some((error) => error.includes("64 hex"))).toBe(true);
    expect(errors.some((error) => error.includes("instructionLoaded"))).toBe(true);
  });
});

function base(overrides: Partial<TrialRecord>): TrialRecord {
  return {
    id: "t1",
    taskId: "alpha",
    taskSlug: "alpha",
    harness: "claude-code",
    condition: "baseline",
    seed: 1,
    passed: false,
    instructionLoaded: null,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    cliVersion: "cli",
    modelId: "model",
    artifactSha256: "none",
    graderId: "grader",
    graderSha256: "c".repeat(64),
    ...overrides,
  };
}
