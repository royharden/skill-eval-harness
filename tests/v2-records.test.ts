import { describe, expect, it } from "vitest";
import type { AttemptRecord, RunRecords } from "../supabase/functions/publish-run/domain/contracts.ts";
import { verifySpecDigests } from "../supabase/functions/publish-run/domain/digests.ts";
import { pairRecords } from "../supabase/functions/publish-run/domain/pairing.ts";
import { buildSampleRecords } from "../supabase/functions/publish-run/domain/sample.ts";
import { parseRunRecords, parseSpec } from "../supabase/functions/publish-run/domain/validate.ts";
import { sha256 } from "./helpers/sha.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function sample(): Promise<RunRecords> {
  return buildSampleRecords(sha256);
}

describe("synthetic sample", () => {
  it("validates, carries a synthetic label and consistent digests", async () => {
    const r = await sample();
    const parsed = parseRunRecords(r.spec, r.ledger, r.attempts);
    expect(parsed.ok).toBe(true);
    expect(r.spec.notes).toMatch(/Synthetic/);
    expect(r.attempts.every((a) => a.attestation === "replay-synthetic")).toBe(true);
    expect(await verifySpecDigests(r.spec, sha256)).toEqual([]);
  });
  it("pairs with helpful and harmful flips, a timeout pair, a grader-error block and a missing side", async () => {
    const pairing = pairRecords(await sample());
    if (!pairing.ok) throw new Error(pairing.errors.join("; "));
    const v = pairing.value;
    expect(v.planned_sides).toBe(36);
    expect(v.not_started_sides).toBe(1);
    expect(v.pairs.some((p) => p.flip === "helpful")).toBe(true);
    expect(v.pairs.some((p) => p.flip === "harmful")).toBe(true);
    expect(v.pairs.some((p) => p.treatment.status === "timeout" && !p.treatment_pass)).toBe(true);
    expect(v.incomplete.map((b) => b.reasons.join(","))).toEqual(expect.arrayContaining(["treatment grader_error", "baseline not started"]));
    expect(v.pairs.length + v.incomplete.length).toBe(18);
  });
});

describe("validation", () => {
  it("rejects scalars, nulls and wrong shapes", () => {
    expect(parseSpec(null).ok).toBe(false);
    expect(parseSpec(42).ok).toBe(false);
    expect(parseSpec({}).ok).toBe(false);
  });
  it("refuses pass without passing grader evidence", async () => {
    const r = await sample();
    const a = clone(r.attempts.find((x) => x.status === "pass")!) as AttemptRecord;
    a.grade = null;
    const parsed = parseRunRecords(r.spec, r.ledger, r.attempts.map((x) => (x.attempt_id === a.attempt_id ? a : x)));
    expect(parsed.ok).toBe(false);
  });
  it("refuses duplicate attempt ids and unreferenced attempts", async () => {
    const r = await sample();
    expect(parseRunRecords(r.spec, r.ledger, [...r.attempts, r.attempts[0]!]).ok).toBe(false);
    const extra = clone(r.attempts[0]!);
    extra.attempt_id = "stray";
    expect(parseRunRecords(r.spec, r.ledger, [...r.attempts, extra]).ok).toBe(false);
  });
  it("refuses negative usage and fractional counters", async () => {
    const r = await sample();
    const a = clone(r.attempts[0]!);
    a.usage.input_tokens = -1;
    expect(parseRunRecords(r.spec, r.ledger, [a, ...r.attempts.slice(1)]).ok).toBe(false);
    a.usage.input_tokens = 1.5;
    expect(parseRunRecords(r.spec, r.ledger, [a, ...r.attempts.slice(1)]).ok).toBe(false);
  });
  it("refuses config differences under content-only intervention and CLAUDE.md under Codex", async () => {
    const r = await sample();
    const s = clone(r.spec);
    s.arms[1].config_differences = ["model override"];
    expect(parseSpec(s).ok).toBe(false);
    const c = clone(r.spec);
    c.harness_id = "codex";
    c.arms[1].artifact_kind = "claude-md";
    expect(parseSpec(c).ok).toBe(false);
  });
});

describe("pairing", () => {
  it("excludes a pin-mismatched attempt as a diagnostic instead of pairing it", async () => {
    const r = await sample();
    const target = r.attempts.find((a) => a.task_id === "neutral-fix-typo" && a.repeat_id === 0 && a.arm_id === "treatment")!;
    const changed = { ...target, requested_model_id: "other-model" };
    const pairing = pairRecords({ ...r, attempts: r.attempts.map((a) => (a === target ? changed : a)) });
    if (!pairing.ok) throw new Error("unexpected");
    expect(pairing.value.excluded.map((e) => e.attempt_id)).toContain(target.attempt_id);
    expect(pairing.value.pairs.some((p) => p.task_id === "neutral-fix-typo" && p.repeat_id === 0)).toBe(false);
  });
  it("excludes mismatched cross-arm configuration", async () => {
    const r = await sample();
    const target = r.attempts.find((a) => a.task_id === "neutral-fix-typo" && a.repeat_id === 1 && a.arm_id === "treatment")!;
    const changed = { ...target, effective_config_digest: "f".repeat(64) };
    const pairing = pairRecords({ ...r, attempts: r.attempts.map((a) => (a === target ? changed : a)) });
    if (!pairing.ok) throw new Error("unexpected");
    expect(pairing.value.incomplete.some((b) => b.reasons.includes("pin mismatch between arms"))).toBe(true);
  });
  it("refuses a ledger that selects a retry without qualified startup evidence", async () => {
    const r = await sample();
    const spec = { ...r.spec, retry_policy: { ...r.spec.retry_policy, startup_retries: 1 } };
    const first = r.attempts.find((a) => a.task_id === "changelog-heading" && a.repeat_id === 0 && a.arm_id === "baseline")!;
    const second: AttemptRecord = {
      ...first,
      attempt_id: `${first.attempt_id}-2`,
      attempt_no: 2,
      status: "pass",
      grade: { checks: [{ check_id: "c", kind: "file_exists", pass: true, detail: "" }], score: null, snapshot_digest: null },
    };
    const ledger = clone(r.ledger);
    const side = ledger.sides.find((s) => s.task_id === first.task_id && s.repeat_id === 0 && s.arm_id === "baseline")!;
    side.attempt_ids.push(second.attempt_id);
    side.selected_attempt_id = second.attempt_id;
    expect(pairRecords({ spec, ledger, attempts: [...r.attempts, second] }).ok).toBe(false);
  });
  it("is invariant to attempt input order", async () => {
    const r = await sample();
    const a = pairRecords(r);
    const b = pairRecords({ ...r, attempts: [...r.attempts].reverse() });
    if (!a.ok || !b.ok) throw new Error("unexpected");
    expect(b.value.pairs.map((p) => [p.task_id, p.repeat_id, p.flip])).toEqual(a.value.pairs.map((p) => [p.task_id, p.repeat_id, p.flip]));
  });
});
