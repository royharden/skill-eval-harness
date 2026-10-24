import { describe, expect, it } from "vitest";
import type { ArmDescriptor } from "../supabase/functions/publish-run/domain/contracts.ts";
import { buildSampleRecords } from "../supabase/functions/publish-run/domain/sample.ts";
import { replayParser } from "../runner/adapters/replay.ts";
import { planSides } from "../runner/schedule.ts";
import { parseFrontmatter } from "../runner/suite.ts";
import { sha256 } from "./helpers/sha.ts";

describe("seeded schedule", () => {
  it("plans every side once, deterministically for a seed", async () => {
    const { spec } = await buildSampleRecords(sha256);
    const a = planSides(spec);
    const b = planSides(spec);
    expect(a).toEqual(b);
    expect(a.length).toBe(spec.tasks.length * spec.repeats * 2);
    expect(new Set(a.map((s) => `${s.task_id}/${s.repeat_id}/${s.arm_id}`)).size).toBe(a.length);
    expect(a.map((s) => s.order_index)).toEqual(a.map((_, i) => i));
    const other = planSides({ ...spec, scheduling_seed: spec.scheduling_seed + 1 });
    expect(other.map((s) => s.order_index + s.task_id)).not.toEqual(a.map((s) => s.order_index + s.task_id));
  });
  it("keeps both sides of a block adjacent with order_in_pair 0 then 1", async () => {
    const { spec } = await buildSampleRecords(sha256);
    const sides = planSides(spec);
    for (let i = 0; i < sides.length; i += 2) {
      expect(sides[i]!.task_id).toBe(sides[i + 1]!.task_id);
      expect([sides[i]!.order_in_pair, sides[i + 1]!.order_in_pair]).toEqual([0, 1]);
    }
  });
});

describe("replay parser", () => {
  const treatment = { arm_id: "treatment" } as ArmDescriptor;
  const candidate = { kind: "skill", name: "acme-changelog", artifact_digest: "a".repeat(64) } as never;
  it("needs a start event, records exposure only for the treatment artifact and a terminal result", () => {
    const p = replayParser(treatment, candidate);
    expect(p.push('{"type":"exposure","mechanism":"native-invocation","artifact":"SKILL.md"}')).toBe(false);
    expect(p.push('{"type":"start","model":"replay-model","cli_version":"replay-1"}')).toBe(true);
    p.push('{"type":"usage","input_tokens":10,"output_tokens":2,"cost_usd":0.01}');
    p.push("not json");
    p.push('{"type":"result","status":"success"}');
    const s = p.state();
    expect(s.exposure.status).toBe("observed");
    expect(s.terminal?.ok).toBe(true);
    expect(s.malformed_lines).toBe(1);
    expect(s.usage.input_tokens).toBe(10);
  });
  it("leaves exposure unknown when no exposure event appears", () => {
    const p = replayParser(treatment, candidate);
    p.push('{"type":"start"}');
    expect(p.state().exposure.status).toBe("unknown");
  });
});

describe("skill frontmatter", () => {
  it("parses flat frontmatter and reports missing frontmatter", () => {
    expect(parseFrontmatter("---\nname: acme\ndescription: x\n---\nbody").fields).toEqual({ name: "acme", description: "x" });
    expect(parseFrontmatter("no frontmatter").error).not.toBeNull();
  });
});
