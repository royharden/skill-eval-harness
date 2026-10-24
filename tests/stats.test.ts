import { describe, expect, it } from "vitest";
import { bootstrapPairedDifference, makeRng, pairedDifference } from "../supabase/functions/publish-run/domain/bootstrap.ts";
import { compareTrials } from "../supabase/functions/publish-run/domain/compare.ts";
import { costOf } from "../supabase/functions/publish-run/domain/cost.ts";
import { mcnemarExact } from "../supabase/functions/publish-run/domain/mcnemar.ts";
import type { TrialRecord } from "../supabase/functions/publish-run/domain/types.ts";
import { decideVerdict } from "../supabase/functions/publish-run/domain/verdict.ts";
import { wilsonInterval } from "../supabase/functions/publish-run/domain/wilson.ts";

describe("wilsonInterval", () => {
  it("returns null when nothing was run", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("clamps an all-fail sample to a zero lower bound", () => {
    expect(wilsonInterval(0, 10)?.low).toBe(0);
  });

  it("clamps an all-pass sample to an upper bound of one", () => {
    expect(wilsonInterval(10, 10)?.high).toBe(1);
  });

  it("puts 3 of 4 inside a 95% Wilson interval", () => {
    const interval = wilsonInterval(3, 4);
    expect(interval).not.toBeNull();
    expect(interval!.low).toBeGreaterThan(0.3);
    expect(interval!.low).toBeLessThan(0.31);
    expect(interval!.high).toBeGreaterThan(0.95);
    expect(interval!.high).toBeLessThan(0.96);
    expect(interval!.low).toBeLessThan(0.75);
    expect(interval!.high).toBeGreaterThan(0.75);
  });

  it("rejects impossible counts", () => {
    expect(() => wilsonInterval(5, 4)).toThrow(/between 0/);
    expect(() => wilsonInterval(1.5, 4)).toThrow(/integers/);
  });
});

describe("mcnemarExact", () => {
  it("matches the two-sided binomial tail for 5 versus 1", () => {
    expect(mcnemarExact(5, 1)).toEqual({ discordant: 6, pValue: 14 / 64 });
  });

  it("matches the two-sided tail when every discordant pair favors treatment", () => {
    expect(mcnemarExact(6, 0).pValue).toBeCloseTo(2 / 64, 12);
  });

  it("leaves the p-value unset when there are no discordant pairs", () => {
    expect(mcnemarExact(0, 0)).toEqual({ discordant: 0, pValue: null });
  });
});

describe("decideVerdict", () => {
  it("calls no winner when the interval includes zero", () => {
    expect(decideVerdict({ low: -0.1, high: 0.2, degenerate: false }, 0.05).verdict).toBe("no-winner");
  });

  it("names the treatment when a non-degenerate interval is entirely above zero", () => {
    expect(decideVerdict({ low: 0.1, high: 0.4, degenerate: false }, 0.2)).toEqual({
      verdict: "winner",
      winner: "treatment",
    });
  });

  it("names the baseline when a non-degenerate interval is entirely below zero", () => {
    expect(decideVerdict({ low: -0.4, high: -0.1, degenerate: false }, -0.2).winner).toBe("baseline");
  });

  it("stays uninformative when a collapsed interval excludes zero", () => {
    expect(decideVerdict({ low: 0.5, high: 0.5, degenerate: true }, 0.5).verdict).toBe("uninformative");
  });

  it("calls no winner when the collapsed interval is exactly zero", () => {
    expect(decideVerdict({ low: 0, high: 0, degenerate: true }, 0).verdict).toBe("no-winner");
  });
});

describe("bootstrapPairedDifference", () => {
  it("is deterministic for a fixed seed", () => {
    const firstRng = makeRng(7);
    const againRng = makeRng(7);
    const first = [firstRng(), firstRng(), firstRng()];
    const again = [againRng(), againRng(), againRng()];
    expect(first).toEqual(again);
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("resamples whole tasks and collapses when every draw picks the same task", () => {
    const clusters = [
      { taskId: "a", pairs: [{ baselinePassed: false, treatmentPassed: true }] },
      { taskId: "b", pairs: [{ baselinePassed: true, treatmentPassed: false }] },
    ];
    const interval = bootstrapPairedDifference(clusters, 4, () => 0);
    expect(pairedDifference(clusters)).toBe(0);
    expect(interval).toEqual({ estimate: 0, low: 1, high: 1, degenerate: true });
  });

  it("marks a single task as degenerate", () => {
    const interval = bootstrapPairedDifference(
      [{ taskId: "only", pairs: [{ baselinePassed: false, treatmentPassed: true }] }],
      20,
      () => 0.2,
    );
    expect(interval?.degenerate).toBe(true);
    expect(interval?.estimate).toBe(1);
  });
});

describe("compareTrials", () => {
  it("keeps harnesses separate and reports null cost when nothing passes", () => {
    const trials = [
      trial("c1", "claude-code", "baseline", "alpha", 1, true),
      trial("c2", "claude-code", "skill", "alpha", 1, false),
      trial("c3", "claude-code", "baseline", "beta", 1, true),
      trial("c4", "claude-code", "skill", "beta", 1, false),
      trial("x1", "codex", "baseline", "alpha", 1, false),
      trial("x2", "codex", "skill", "alpha", 1, false),
      trial("x3", "codex", "baseline", "beta", 1, false),
      trial("x4", "codex", "skill", "beta", 1, false),
    ];
    const result = compareTrials(trials, { draws: 20, seed: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.harnesses.map((item) => item.harness)).toEqual(["claude-code", "codex"]);
    expect(result.summary.attestation).toBe("owner-supplied");
    const codex = result.summary.harnesses[1]!.conditions[0]!;
    expect(codex.cost.usdPerPass).toBeNull();
    expect(codex.warnings.some((warning) => warning.includes("undefined"))).toBe(true);
    expect(costOf(trials.filter((item) => item.id.startsWith("x") && item.condition === "skill")).usdPerPass).toBeNull();
  });

  it("rejects a treatment that has no baseline", () => {
    const result = compareTrials([trial("s1", "claude-code", "skill", "alpha", 1, true)]);
    expect(result.ok).toBe(false);
  });
});

function trial(
  id: string,
  harness: TrialRecord["harness"],
  condition: TrialRecord["condition"],
  task: string,
  seed: number,
  passed: boolean,
): TrialRecord {
  return {
    id,
    taskId: task,
    taskSlug: task,
    harness,
    condition,
    seed,
    passed,
    instructionLoaded: condition === "baseline" ? null : true,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
    cliVersion: "cli-test",
    modelId: "model-test",
    artifactSha256: condition === "baseline" ? "none" : "d".repeat(64),
    graderId: "grade-test",
    graderSha256: "e".repeat(64),
  };
}
