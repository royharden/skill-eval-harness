import { describe, expect, it } from "vitest";
import { fixturePayload } from "../supabase/functions/publish-run/domain/fixture.ts";
import { importLegacy } from "../supabase/functions/publish-run/domain/legacy.ts";

describe("legacy v1 importer", () => {
  it("marks pairing unverified and lists unavailable pins instead of inventing them", () => {
    const result = importLegacy(fixturePayload());
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.value.pairing).toBe("unverified");
    expect(result.value.attestation).toBe("imported");
    expect(result.value.unavailable_fields.length).toBeGreaterThan(0);
    expect(result.value.comparisons.map((c) => c.treatment)).toEqual(["skill", "agents"]);
  });
  it("rejects malformed legacy input", () => {
    expect(importLegacy({ tasks: [], trials: [{ task_slug: "x" }] }).ok).toBe(false);
    expect(importLegacy(null).ok).toBe(false);
  });
});
