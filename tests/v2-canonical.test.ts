import { describe, expect, it } from "vitest";
import { CanonicalError, canonicalJson, compareAttempts, treeDigest } from "../supabase/functions/publish-run/domain/canonical.ts";
import type { AttemptRecord } from "../supabase/functions/publish-run/domain/contracts.ts";
import { relativePathError, shapeBoundsErrors, utf8Length } from "../supabase/functions/publish-run/domain/limits.ts";
import { sha256 } from "./helpers/sha.ts";

describe("canonical JSON", () => {
  it("sorts keys by code unit and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [3, 1], A: null })).toBe('{"A":null,"a":[3,1],"b":1}');
  });
  it("rejects undefined, non-finite numbers and class instances", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(CanonicalError);
  });
  it("writes -0 as 0", () => {
    expect(canonicalJson([-0])).toBe("[0]");
  });
  it("tree digest is input-order invariant and refuses duplicate paths", async () => {
    const a = await treeDigest([{ path: "b", digest: "1".repeat(64) }, { path: "a", digest: "2".repeat(64) }], sha256);
    const b = await treeDigest([{ path: "a", digest: "2".repeat(64) }, { path: "b", digest: "1".repeat(64) }], sha256);
    expect(a).toBe(b);
    await expect(treeDigest([{ path: "a", digest: "1".repeat(64) }, { path: "a", digest: "2".repeat(64) }], sha256)).rejects.toThrow();
  });
  it("orders attempts by task, repeat, arm, attempt_no, id", () => {
    const later = { task_id: "t", repeat_id: 0, arm_id: "treatment", attempt_no: 1, attempt_id: "x" } as unknown as AttemptRecord;
    const earlier = { task_id: "t", repeat_id: 0, arm_id: "baseline", attempt_no: 1, attempt_id: "y" } as unknown as AttemptRecord;
    expect(compareAttempts(earlier, later)).toBeLessThan(0);
  });
});

describe("bounds", () => {
  it("rejects unsafe relative paths", () => {
    for (const bad of ["/abs", "C:/x", "a/../b", "a//b", "a\\b", "./a", "a\u0000b", "con.", ""]) {
      expect(relativePathError(bad)).not.toBeNull();
    }
    expect(relativePathError("attempts/a.json")).toBeNull();
  });
  it("enforces depth", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(shapeBoundsErrors(deep).length).toBeGreaterThan(0);
  });
  it("counts UTF-8 bytes", () => {
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("😀")).toBe(4);
  });
});
