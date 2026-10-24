import { describe, expect, it } from "vitest";
import { trialFromStoredRow } from "../supabase/functions/publish-run/domain/stored.ts";
import { validateTrial } from "../supabase/functions/publish-run/domain/pins.ts";

describe("trialFromStoredRow", () => {
  it("accepts numeric columns that arrive as strings", () => {
    const trial = trialFromStoredRow({
      id: "t1",
      task_id: "alpha",
      task_slug: "alpha",
      harness: "claude-code",
      condition: "baseline",
      seed: "2",
      passed: false,
      instruction_loaded: null,
      input_tokens: "100",
      output_tokens: "40",
      cost_usd: "0.020000",
      cli_version: "claude 1.0.62-fixture",
      model_id: "claude-fixture-model",
      artifact_sha256: "none",
      grader_id: "parser-export-checks",
      grader_sha256: "c".repeat(64),
    });
    expect(trial.seed).toBe(2);
    expect(trial.costUsd).toBeCloseTo(0.02, 6);
    expect(validateTrial(trial)).toEqual([]);
  });

  it("rejects a fractional seed", () => {
    expect(() =>
      trialFromStoredRow({
        id: "t1",
        task_id: "alpha",
        task_slug: "alpha",
        harness: "codex",
        condition: "skill",
        seed: "1.5",
        passed: true,
        instruction_loaded: true,
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        cli_version: "codex",
        model_id: "model",
        artifact_sha256: "d".repeat(64),
        grader_id: "grader",
        grader_sha256: "e".repeat(64),
      }),
    ).toThrow(/seed/);
  });
});
