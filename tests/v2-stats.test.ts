import { describe, expect, it } from "vitest";
import { buildSampleRecords, buildSyntheticRecords, type SyntheticPlan } from "../supabase/functions/publish-run/domain/sample.ts";
import { clusterBootstrap, mcnemarTwoSided, percentileSorted } from "../supabase/functions/publish-run/domain/stats.ts";
import { analyze, type RunSummary } from "../supabase/functions/publish-run/domain/summary.ts";
import { wilsonInterval } from "../supabase/functions/publish-run/domain/wilson.ts";
import { sha256 } from "./helpers/sha.ts";

const ZERO = "0".repeat(64);

async function summaryOf(plan: SyntheticPlan): Promise<RunSummary> {
  const records = await buildSyntheticRecords(plan, sha256);
  const result = analyze(records, ZERO);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value.summary;
}

/** Independent exact check with BigInt arithmetic. */
function mcnemarBig(n01: number, n10: number): number {
  const d = BigInt(n01 + n10);
  const m = Math.min(n01, n10);
  let c = 1n;
  let sum = 1n;
  for (let k = 0; k < m; k += 1) {
    c = (c * (d - BigInt(k))) / BigInt(k + 1);
    sum += c;
  }
  const scale = 10n ** 30n;
  const ratio = (2n * sum * scale) / 2n ** d;
  return Math.min(1, Number(ratio) / 1e30);
}

describe("Wilson 95%", () => {
  it.each([
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [5, 10, 0.2366, 0.7634],
    [3, 4, 0.3006, 0.9544],
  ])("%i/%i", (k, n, low, high) => {
    const w = wilsonInterval(k, n)!;
    expect(w.low).toBeCloseTo(low, 4);
    expect(w.high).toBeCloseTo(high, 4);
  });
});

describe("exact McNemar", () => {
  it("matches the plan examples", () => {
    expect(mcnemarTwoSided(5, 1)).toBeCloseTo(14 / 64, 12);
    expect(mcnemarTwoSided(6, 0)).toBeCloseTo(2 / 64, 12);
    expect(mcnemarTwoSided(0, 0)).toBeNull();
    expect(mcnemarTwoSided(3, 3)).toBe(1);
  });
  it("is stable at large D against an independent BigInt calculation", () => {
    for (const [a, b] of [[520, 480], [700, 650], [40, 960]] as const) {
      expect(mcnemarTwoSided(a, b)!).toBeCloseTo(mcnemarBig(a, b), 9);
    }
  });
});

describe("percentile and bootstrap", () => {
  it("interpolates at (B-1)p", () => {
    expect(percentileSorted([0, 10], 0.25)).toBe(2.5);
    expect(percentileSorted([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
  it("is unavailable with fewer than two tasks and degenerate with identical deltas", () => {
    expect(clusterBootstrap([1], 1).status).toBe("unavailable-fewer-than-two-tasks");
    expect(clusterBootstrap([], 1).status).toBe("unavailable-no-pairs");
    const eight = clusterBootstrap(new Array(8).fill(1), 7);
    expect(eight.status).toBe("degenerate");
    expect(eight.low).toBe(1);
  });
  it("is reproducible for a fixed seed", () => {
    expect(clusterBootstrap([1, 0, -1, 0.5], 42)).toEqual(clusterBootstrap([1, 0, -1, 0.5], 42));
  });
});

describe("summary", () => {
  it("weights tasks equally: one +1 pair vs four 0 pairs -> primary 0.5, pooled 0.2", async () => {
    const s = await summaryOf({
      a: { label: "A", cost: "reported", cells: [["fail", "pass"], ["missing", "missing"], ["missing", "missing"], ["missing", "missing"]] },
      b: { label: "B", cost: "reported", cells: [["pass", "pass"], ["pass", "pass"], ["fail", "fail"], ["fail", "fail"]] },
    });
    expect(s.effect.primary_task_mean).toBeCloseTo(0.5, 12);
    expect(s.effect.pooled_descriptive).toBeCloseTo(0.2, 12);
    expect(s.effect.direction).toBe("favors-treatment");
    expect(s).not.toHaveProperty("winner");
  });
  it("keeps the observed effect for eight +1 tasks with degenerate uncertainty", async () => {
    const plan: SyntheticPlan = {};
    for (let i = 0; i < 8; i += 1) plan[`t${i}`] = { label: `T${i}`, cost: "reported", cells: [["fail", "pass"]] };
    const s = await summaryOf(plan);
    expect(s.effect.primary_task_mean).toBe(1);
    expect(s.uncertainty.status).toBe("degenerate");
    expect(s.mcnemar_repeat0.p_value).toBeCloseTo(2 / 256, 12);
  });
  it("uses only repeat 0 for McNemar and lists tasks without a repeat-0 pair", async () => {
    const s = await summaryOf({
      a: { label: "A", cost: "reported", cells: [["missing", "pass"], ["fail", "pass"]] },
      b: { label: "B", cost: "reported", cells: [["fail", "pass"], ["fail", "pass"]] },
    });
    expect(s.mcnemar_repeat0.pairs).toBe(1);
    expect(s.mcnemar_repeat0.tasks_without_repeat0_pair).toEqual(["a"]);
    expect(s.table.n01).toBe(3);
  });
  it("suppresses cost ratios under incomplete coverage and keeps known zero distinct from unknown", async () => {
    const sample = await buildSampleRecords(sha256);
    const r = analyze(sample, ZERO);
    if (!r.ok) throw new Error("unexpected");
    const t = r.value.summary.arms.treatment;
    expect(t.cost.complete).toBe(false);
    expect(t.cost.usd_per_passing_attempt).toBeNull();
    expect(t.cost.ratio_note).toMatch(/unknown/);
    const zero = await summaryOf({ a: { label: "A", cost: "reported", cells: [["fail", "fail"]] } });
    expect(zero.arms.baseline.cost.complete).toBe(true);
    expect(zero.arms.baseline.cost.usd_per_passing_attempt).toBeNull();
    expect(zero.arms.baseline.cost.ratio_note).toMatch(/no selected attempt passed/);
  });
  it("is invariant to attempt input order", async () => {
    const sample = await buildSampleRecords(sha256);
    const a = analyze(sample, ZERO);
    const b = analyze({ ...sample, attempts: [...sample.attempts].reverse(), spec: { ...sample.spec, tasks: [...sample.spec.tasks].reverse() } }, ZERO);
    if (!a.ok || !b.ok) throw new Error("unexpected");
    expect(b.value.summary).toEqual(a.value.summary);
  });
});
