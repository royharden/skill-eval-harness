import { describe, expect, it } from "vitest";
import { buildEnvelope, envelopeText, importEnvelopeText, type Envelope } from "../supabase/functions/publish-run/domain/manifest.ts";
import { buildSampleRecords } from "../supabase/functions/publish-run/domain/sample.ts";
import { sanitizeForExport, scrubText } from "../supabase/functions/publish-run/domain/sanitize.ts";
import { sha256 } from "./helpers/sha.ts";

async function privateEnvelope(): Promise<Envelope> {
  const records = await buildSampleRecords(sha256);
  const built = await buildEnvelope(records, sha256, { kind: "private", runtime: { os: "C:\\Users\\someone\\x" } });
  if (!built.ok) throw new Error(built.errors.join("; "));
  return built.value.envelope;
}

describe("envelope", () => {
  it("round-trips and recomputes the same summary", async () => {
    const env = await privateEnvelope();
    const result = await importEnvelopeText(envelopeText(env), sha256);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.value.summary.records_edition_digest).toBe(env.manifest.records_edition_digest);
    expect(JSON.parse(env.files["summary.json"]!)).toEqual(result.value.summary);
  });
  it("manifest files exclude the manifest itself", async () => {
    const env = await privateEnvelope();
    expect(Object.keys(env.manifest.files).some((p) => p.includes("manifest"))).toBe(false);
  });
  it("distinguishes JSON errors from schema and integrity errors", async () => {
    expect((await importEnvelopeText("{not json", sha256)).stage).toBe("json");
    expect((await importEnvelopeText("[]", sha256)).stage).toBe("schema");
    const env = await privateEnvelope();
    const changed = { ...env, files: { ...env.files, "ledger.json": env.files["ledger.json"]! + " " } };
    expect((await importEnvelopeText(JSON.stringify(changed), sha256)).stage).toBe("integrity");
  });
  it("rejects missing, extra and aliased files", async () => {
    const env = await privateEnvelope();
    const { ["ledger.json"]: _dropped, ...rest } = env.files;
    void _dropped;
    expect((await importEnvelopeText(JSON.stringify({ ...env, files: rest }), sha256)).ok).toBe(false);
    expect((await importEnvelopeText(JSON.stringify({ ...env, files: { ...env.files, "extra.txt": "x" } }), sha256)).ok).toBe(false);
    expect((await importEnvelopeText(JSON.stringify({ ...env, files: { ...env.files, "Ledger.json": "x" } }), sha256)).ok).toBe(false);
    expect((await importEnvelopeText(JSON.stringify({ ...env, files: { ...env.files, "../x": "x" } }), sha256)).ok).toBe(false);
  });
  it("refuses an envelope over the byte cap before parsing", async () => {
    const big = `"${"x".repeat(8 * 1024 * 1024 + 1)}"`;
    expect((await importEnvelopeText(big, sha256)).stage).toBe("size");
  });
});

describe("sanitized export", () => {
  it("withholds labels, paths, traces and event refs and records the transform", async () => {
    const records = await buildSampleRecords(sha256);
    const env = await privateEnvelope();
    const result = await sanitizeForExport(records, env.manifest, sha256);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const out = result.value;
    expect(out.envelope.manifest.manifest_kind).toBe("sanitized");
    expect(out.envelope.manifest.transform?.source_manifest_digest).toBe(env.manifest.content_digest);
    expect(out.records.spec.tasks.every((t) => /^Task \d+$/.test(t.display_label) && t.suite_path === "withheld")).toBe(true);
    expect(out.records.attempts.every((a) => a.exposure.event_ref === null && a.trace.digest === null)).toBe(true);
    expect(out.envelope.manifest.runtime.os).toBe("<path>");
    expect(out.records.spec.experiment_digest).not.toBe(records.spec.experiment_digest);
    const reimported = await importEnvelopeText(envelopeText(out.envelope), sha256);
    expect(reimported.ok).toBe(true);
    const original = await importEnvelopeText(envelopeText(env), sha256);
    if (!original.ok) throw new Error("unexpected");
    expect(out.summary.effect).toEqual({
      ...original.value.summary.effect,
      per_task: original.value.summary.effect.per_task.map((t, i) => ({ ...t, display_label: out.summary.effect.per_task[i]!.display_label })),
    });
  });
  it("scrubs paths, emails and secret-like tokens", () => {
    expect(scrubText("see C:\\Users\\roy\\x.txt and /home/roy/y")).toBe("see <path> and <path>");
    expect(scrubText("mail a@b.co")).toBe("mail <email>");
    expect(scrubText("ANTHROPIC_API_KEY=abc")).toBe("<env-assignment>");
  });
});
