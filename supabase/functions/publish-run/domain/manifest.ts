// Run manifest, records-edition digest and the browser import envelope (PLAN.md §5).
// No self-hash cycles: manifest.files excludes the manifest; content_digest hashes the manifest without itself;
// the summary references records_edition_digest (normalized inputs + selection), never a manifest digest.

import { canonicalJson, compareCodeUnits, digestOf, sortAttempts, sortTasks, utf8 } from "./canonical.ts";
import { METHOD_VERSION, SCHEMA_VERSION, TOOL_VERSION, type Attestation, type Digest, type Result, type RunRecords, type Sha256Port } from "./contracts.ts";
import { verifySpecDigests } from "./digests.ts";
import { isDigest, isSafeId, LIMITS, pathAliasKey, relativePathError, shapeBoundsErrors, utf8Length } from "./limits.ts";
import { analyze, type RunSummary } from "./summary.ts";
import { BOOTSTRAP_PRNG, BOOTSTRAP_RESAMPLES, PERCENTILE_METHOD } from "./stats.ts";
import { parseRunRecords } from "./validate.ts";

export const SOURCE_REF_KINDS = ["withheld-trace", "withheld-prompt", "withheld-source", "withheld-snapshot", "private-manifest"] as const;
export type SourceRefKind = (typeof SOURCE_REF_KINDS)[number];

/** Typed reference to an input that is NOT distributed. Unverifiable metadata, never a required file. */
export interface SourceRef {
  kind: SourceRefKind;
  ref: string;
  digest: Digest | null;
  note: string;
}

export interface Transform {
  version: string;
  rules: string[];
  source_manifest_digest: Digest;
  source_experiment_digest: Digest;
}

export interface RunManifest {
  schema_version: typeof SCHEMA_VERSION;
  manifest_kind: "private" | "sanitized";
  tool_version: string;
  method_version: typeof METHOD_VERSION;
  run_id: string;
  experiment_id: string;
  experiment_digest: Digest;
  arm_digests: { baseline: Digest; treatment: Digest };
  task_hashes: Array<{ task_id: string; prompt_digest: Digest; fixture_tree_digest: Digest; grader_digest: Digest; oracle_digest: Digest }>;
  ledger: { edition: number; kind: string; selected_attempt_ids: string[]; not_started: Array<{ task_id: string; repeat_id: number; arm_id: string }> };
  excluded: Array<{ attempt_id: string; reasons: string[] }>;
  bootstrap: { resamples: number; seed: number; prng: string; percentile: string };
  runtime: Record<string, string>;
  attestation: Attestation[];
  records_edition_digest: Digest;
  /** Relative distributable path -> SHA-256 of its exact UTF-8 bytes. Excludes the manifest itself. */
  files: Record<string, Digest>;
  source_refs: SourceRef[];
  transform: Transform | null;
  derivation: string;
  content_digest: Digest;
}

export interface Envelope {
  manifest: RunManifest;
  /** Relative path -> UTF-8 text. */
  files: Record<string, string>;
}

export const FILE_EXPERIMENT = "experiment.json";
export const FILE_LEDGER = "ledger.json";
export const FILE_SUMMARY = "summary.json";
export const attemptPath = (attemptId: string) => `attempts/${attemptId}.json`;

/** Normalized edition input: spec (tasks sorted), ledger and canonically sorted attempts. */
export function recordsEditionInput(records: RunRecords): { spec: RunRecords["spec"]; ledger: RunRecords["ledger"]; attempts: RunRecords["attempts"] } {
  return { spec: { ...records.spec, tasks: sortTasks(records.spec.tasks) }, ledger: records.ledger, attempts: sortAttempts(records.attempts) };
}

/** Exact canonical text persisted as a suite edition; its SHA-256 is the records_edition_digest. */
export function recordsEditionText(records: RunRecords): string {
  return canonicalJson(recordsEditionInput(records));
}

/** Digest of normalized inputs and selection: spec, ledger and canonically sorted attempts. */
export async function recordsEditionDigest(records: RunRecords, sha256: Sha256Port): Promise<Digest> {
  return digestOf(recordsEditionInput(records), sha256);
}

export async function manifestContentDigest(manifest: Omit<RunManifest, "content_digest"> | RunManifest, sha256: Sha256Port): Promise<Digest> {
  const { content_digest: _omit, ...rest } = manifest as RunManifest;
  void _omit;
  return digestOf(rest, sha256);
}

export interface BuildOptions {
  kind: "private" | "sanitized";
  runtime?: Record<string, string>;
  sourceRefs?: SourceRef[];
  transform?: Transform | null;
  derivation?: string;
}

/** Serializes records + recomputed summary into distributable files and seals a manifest over their exact bytes. */
export async function buildEnvelope(records: RunRecords, sha256: Sha256Port, options: BuildOptions): Promise<Result<{ envelope: Envelope; summary: RunSummary }>> {
  const editionDigest = await recordsEditionDigest(records, sha256);
  const analysed = analyze(records, editionDigest);
  if (!analysed.ok) return analysed;
  const { pairing, summary } = analysed.value;

  const files: Record<string, string> = {};
  files[FILE_EXPERIMENT] = canonicalJson(records.spec);
  files[FILE_LEDGER] = canonicalJson(records.ledger);
  for (const a of sortAttempts(records.attempts)) files[attemptPath(a.attempt_id)] = canonicalJson(a);
  files[FILE_SUMMARY] = canonicalJson(summary);

  const digests: Record<string, Digest> = {};
  for (const path of Object.keys(files).sort(compareCodeUnits)) digests[path] = await sha256(utf8(files[path]!));

  const { spec, ledger } = records;
  const unsealed: Omit<RunManifest, "content_digest"> = {
    schema_version: SCHEMA_VERSION,
    manifest_kind: options.kind,
    tool_version: TOOL_VERSION,
    method_version: METHOD_VERSION,
    run_id: ledger.run_id,
    experiment_id: spec.experiment_id,
    experiment_digest: spec.experiment_digest,
    arm_digests: { baseline: spec.arms[0].arm_digest, treatment: spec.arms[1].arm_digest },
    task_hashes: sortTasks(spec.tasks).map((t) => ({
      task_id: t.task_id,
      prompt_digest: t.prompt_digest,
      fixture_tree_digest: t.fixture_tree_digest,
      grader_digest: t.grader_digest,
      oracle_digest: t.oracle_digest,
    })),
    ledger: {
      edition: ledger.edition,
      kind: ledger.kind,
      selected_attempt_ids: pairing.selected.map((a) => a.attempt_id),
      not_started: ledger.sides.filter((s) => s.state === "not_started").map((s) => ({ task_id: s.task_id, repeat_id: s.repeat_id, arm_id: s.arm_id })),
    },
    excluded: pairing.excluded,
    bootstrap: { resamples: BOOTSTRAP_RESAMPLES, seed: spec.scheduling_seed, prng: BOOTSTRAP_PRNG, percentile: PERCENTILE_METHOD },
    runtime: options.runtime ?? {},
    attestation: summary.attestations,
    records_edition_digest: editionDigest,
    files: digests,
    source_refs: options.sourceRefs ?? [],
    transform: options.transform ?? null,
    derivation: options.derivation ?? "summary.json recomputed from experiment.json, ledger.json and attempts/*.json by the shared domain",
  };
  const manifest: RunManifest = { ...unsealed, content_digest: await manifestContentDigest(unsealed, sha256) };
  return { ok: true, value: { envelope: { manifest, files }, summary } };
}

/** Exact distributable bytes of an envelope (what preview shows and download writes). */
export function envelopeText(envelope: Envelope): string {
  return canonicalJson(envelope);
}

function manifestShapeErrors(m: unknown): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest must be an object"];
  const r = m as Record<string, unknown>;
  if (r.schema_version !== SCHEMA_VERSION) errors.push(`manifest.schema_version must be ${SCHEMA_VERSION}`);
  if (r.manifest_kind !== "private" && r.manifest_kind !== "sanitized") errors.push("manifest.manifest_kind must be private or sanitized");
  if (r.method_version !== METHOD_VERSION) errors.push(`manifest.method_version must be ${METHOD_VERSION}`);
  if (!isSafeId(r.run_id)) errors.push("manifest.run_id must be a safe id");
  for (const key of ["experiment_digest", "records_edition_digest", "content_digest"]) if (!isDigest(r[key])) errors.push(`manifest.${key} must be a digest`);
  if (!r.files || typeof r.files !== "object" || Array.isArray(r.files)) errors.push("manifest.files must be an object");
  else if (!Object.values(r.files).every(isDigest)) errors.push("manifest.files values must be digests");
  if (!Array.isArray(r.source_refs)) errors.push("manifest.source_refs must be an array");
  else
    r.source_refs.forEach((s, i) => {
      const ref = s as Partial<SourceRef> | null;
      if (!ref || !(SOURCE_REF_KINDS as readonly string[]).includes(String(ref.kind)) || typeof ref.ref !== "string" || typeof ref.note !== "string" || !(ref.digest === null || isDigest(ref.digest))) {
        errors.push(`manifest.source_refs[${i}] is not a typed source reference`);
      }
    });
  return errors;
}

export interface VerifiedImport {
  manifest: RunManifest;
  records: RunRecords;
  summary: RunSummary;
}

/**
 * Bounded browser/server import: size check before parsing, shape bounds, exact path/byte verification against
 * manifest.files BEFORE parsing records, then record validation, digest checks and summary recomputation.
 * A matching hash proves integrity against the supplied manifest, not agent execution or honesty.
 */
export async function importEnvelopeText(text: string, sha256: Sha256Port): Promise<Result<VerifiedImport> & { stage?: "size" | "json" | "schema" | "integrity" | "records" }> {
  if (utf8Length(text) > LIMITS.envelopeBytes) return { ok: false, stage: "size", errors: [`envelope exceeds ${LIMITS.envelopeBytes} bytes`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, stage: "json", errors: ["the text is not valid JSON"] };
  }
  return importEnvelopeValue(parsed, sha256);
}

export async function importEnvelopeValue(parsed: unknown, sha256: Sha256Port): Promise<Result<VerifiedImport> & { stage?: "size" | "json" | "schema" | "integrity" | "records" }> {
  const bounds = shapeBoundsErrors(parsed);
  if (bounds.length) return { ok: false, stage: "schema", errors: bounds };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, stage: "schema", errors: ["envelope must be an object with manifest and files"] };
  const env = parsed as { manifest?: unknown; files?: unknown };
  const shape = manifestShapeErrors(env.manifest);
  if (!env.files || typeof env.files !== "object" || Array.isArray(env.files)) shape.push("files must be an object of relative path -> text");
  if (shape.length) return { ok: false, stage: "schema", errors: shape };
  const manifest = env.manifest as RunManifest;
  const files = env.files as Record<string, unknown>;

  const errors: string[] = [];
  const paths = Object.keys(files);
  if (paths.length > LIMITS.files) return { ok: false, stage: "integrity", errors: [`at most ${LIMITS.files} files`] };
  const aliases = new Map<string, string>();
  for (const path of [...paths, ...Object.keys(manifest.files)]) {
    const err = relativePathError(path);
    if (err) errors.push(`${path}: ${err}`);
    const alias = pathAliasKey(path);
    const prior = aliases.get(alias);
    if (prior !== undefined && prior !== path) errors.push(`${path}: aliases ${prior}`);
    aliases.set(alias, path);
  }
  for (const path of paths) {
    const body = files[path];
    if (typeof body !== "string") errors.push(`${path}: file content must be UTF-8 text`);
    else if (utf8Length(body) > LIMITS.fileBytes) errors.push(`${path}: exceeds ${LIMITS.fileBytes} bytes`);
    if (!(path in manifest.files)) errors.push(`${path}: extra file not listed in the manifest`);
  }
  for (const path of Object.keys(manifest.files)) if (!(path in files)) errors.push(`${path}: listed in the manifest but missing`);
  if (errors.length) return { ok: false, stage: "integrity", errors };
  for (const path of paths) {
    if ((await sha256(utf8(files[path] as string))) !== manifest.files[path]) errors.push(`${path}: bytes do not match the manifest digest`);
  }
  if ((await manifestContentDigest(manifest, sha256)) !== manifest.content_digest) errors.push("manifest content_digest does not match its fields");
  if (errors.length) return { ok: false, stage: "integrity", errors };

  const parseFile = (path: string): unknown => {
    try {
      return JSON.parse(files[path] as string);
    } catch {
      errors.push(`${path}: not valid JSON`);
      return null;
    }
  };
  for (const required of [FILE_EXPERIMENT, FILE_LEDGER]) if (!(required in files)) errors.push(`${required} is required`);
  if (errors.length) return { ok: false, stage: "records", errors };
  const spec = parseFile(FILE_EXPERIMENT);
  const ledger = parseFile(FILE_LEDGER);
  const attempts: unknown[] = [];
  for (const path of paths.sort(compareCodeUnits)) {
    if (!path.startsWith("attempts/")) continue;
    const value = parseFile(path);
    const id = (value as { attempt_id?: unknown } | null)?.attempt_id;
    if (typeof id !== "string" || attemptPath(id) !== path) errors.push(`${path}: file name does not match its attempt_id`);
    attempts.push(value);
  }
  if (errors.length) return { ok: false, stage: "records", errors };
  const records = parseRunRecords(spec, ledger, attempts);
  if (!records.ok) return { ok: false, stage: "records", errors: records.errors };
  const r = records.value;
  const digestErrors = await verifySpecDigests(r.spec, sha256);
  if (r.spec.experiment_digest !== manifest.experiment_digest) digestErrors.push("manifest experiment_digest does not match experiment.json");
  if (r.ledger.run_id !== manifest.run_id) digestErrors.push("manifest run_id does not match ledger.json");
  const edition = await recordsEditionDigest(r, sha256);
  if (edition !== manifest.records_edition_digest) digestErrors.push("records_edition_digest does not match the supplied records");
  if (digestErrors.length) return { ok: false, stage: "records", errors: digestErrors };

  const analysed = analyze(r, edition);
  if (!analysed.ok) return { ok: false, stage: "records", errors: analysed.errors };
  const recomputedSelection = analysed.value.pairing.selected.map((a) => a.attempt_id);
  if (canonicalJson(recomputedSelection) !== canonicalJson(manifest.ledger?.selected_attempt_ids ?? null)) {
    return { ok: false, stage: "records", errors: ["manifest selected attempts disagree with the recomputed policy selection"] };
  }
  return { ok: true, value: { manifest, records: r, summary: analysed.value.summary } };
}
