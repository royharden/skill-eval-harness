// Trusted suite loader (PLAN.md §6). Reads suite.yaml, tasks/<id>/task.yaml, fixture/oracle/graders and the
// candidate artifact with bounds; records every digest before scheduling. YAML is a runner-only dependency.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { digestOf, utf8 } from "../supabase/functions/publish-run/domain/canonical.ts";
import type { ArtifactKind, Digest, TaskDescriptor } from "../supabase/functions/publish-run/domain/contracts.ts";
import { graderDefErrors, type GraderDef } from "../supabase/functions/publish-run/domain/graders.ts";
import { isSafeId, relativePathError } from "../supabase/functions/publish-run/domain/limits.ts";
import { assertPlain, decodeUtf8, FsBoundError, nodeSha256, readTrustedFile, resolveUnder, sha256Hex, treeDigestOf, walkTree, type TreeEntry } from "./fsutil.ts";

const MAX_YAML_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;

export interface ResolvedTask {
  descriptor: TaskDescriptor;
  dir: string;
  prompt: string;
  fixture: TreeEntry[];
  oracle: TreeEntry[];
  graders: GraderDef[];
  /** file_equals grader id -> trusted expected text. */
  expected: Record<string, string>;
  grader_timeout_ms: number | null;
}

export interface CandidateArtifact {
  kind: Exclude<ArtifactKind, "none">;
  /** Skill: directory name; context files: file name. */
  name: string;
  files: TreeEntry[];
  /** Digest of the primary file (SKILL.md / AGENTS.md / CLAUDE.md). */
  artifact_digest: Digest;
  bundle_files_digest: Digest;
  /** Exact primary file text, for forced-content mode. */
  primary_text: string;
  frontmatter: Record<string, string>;
}

export interface LoadedSuite {
  root: string;
  suite_id: string;
  version: string;
  description: string;
  digest: Digest;
  tasks: ResolvedTask[];
  candidate: CandidateArtifact;
}

export class SuiteError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join("\n"));
  }
}

function yamlObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  const text = decodeUtf8(bytes);
  if (text === null) throw new SuiteError([`${label} is not UTF-8`]);
  let value: unknown;
  try {
    value = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    throw new SuiteError([`${label}: ${error instanceof Error ? error.message : "invalid YAML"}`]);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SuiteError([`${label} must be a mapping`]);
  return value as Record<string, unknown>;
}

/** Parses "---\nkey: value\n---" frontmatter (flat string values only). */
export function parseFrontmatter(text: string): { fields: Record<string, string>; error: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: {}, error: "SKILL.md needs YAML frontmatter with name and description" };
  let value: unknown;
  try {
    value = parseYaml(m[1]!, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    return { fields: {}, error: "SKILL.md frontmatter is not valid YAML" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { fields: {}, error: "SKILL.md frontmatter must be a mapping" };
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields[k] = typeof v === "string" ? v : JSON.stringify(v);
  return { fields, error: null };
}

/** Frontmatter keys that would change tools/model/permissions/hooks; refused under content-only intervention. */
const ACTIVE_FRONTMATTER = new Set(["allowed-tools", "allowed_tools", "tools", "model", "effort", "hooks", "permissions", "dependencies", "context", "agent", "fork", "subagent", "disable-model-invocation"]);

async function loadCandidate(root: string, raw: unknown, reasons: string[]): Promise<CandidateArtifact | null> {
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== "object") {
    reasons.push("suite.candidate must be a mapping with kind and path");
    return null;
  }
  const kind = c.kind;
  if (kind !== "skill" && kind !== "agents-md" && kind !== "claude-md") {
    reasons.push("suite.candidate.kind must be skill, agents-md or claude-md");
    return null;
  }
  if (typeof c.path !== "string" || relativePathError(c.path)) {
    reasons.push("suite.candidate.path must be a safe relative path");
    return null;
  }
  const abs = resolveUnder(root, c.path);
  if (kind === "skill") {
    const files = await walkTree(abs);
    const skill = files.find((f) => f.path === "SKILL.md");
    if (!skill) {
      reasons.push("skill directory must contain SKILL.md");
      return null;
    }
    const text = decodeUtf8(await readTrustedFile(abs, "SKILL.md"));
    if (text === null) {
      reasons.push("SKILL.md is not UTF-8");
      return null;
    }
    const name = c.path.split("/").pop()!;
    const fm = parseFrontmatter(text);
    if (fm.error) reasons.push(fm.error);
    if (fm.fields.name !== name) reasons.push(`SKILL.md frontmatter name must equal the folder name "${name}"`);
    if (!fm.fields.description) reasons.push("SKILL.md frontmatter needs a description");
    for (const key of Object.keys(fm.fields)) {
      if (ACTIVE_FRONTMATTER.has(key.toLowerCase())) reasons.push(`SKILL.md frontmatter "${key}" changes tools/model/permissions and is refused under content-only intervention`);
      else if (key !== "name" && key !== "description" && key !== "license" && key !== "metadata") reasons.push(`SKILL.md frontmatter "${key}" is not supported in this version`);
    }
    return { kind, name, files, artifact_digest: skill.digest, bundle_files_digest: await treeDigestOf(abs), primary_text: text, frontmatter: fm.fields };
  }
  const expectedName = kind === "agents-md" ? "AGENTS.md" : "CLAUDE.md";
  const fileName = c.path.split("/").pop()!;
  if (fileName !== expectedName) reasons.push(`a ${kind} candidate must be a file named ${expectedName}`);
  await assertPlain(abs, "file");
  const bytes = await readTrustedFile(root, c.path);
  const text = decodeUtf8(bytes);
  if (text === null) {
    reasons.push(`${expectedName} is not UTF-8`);
    return null;
  }
  const digest = sha256Hex(bytes);
  const entry: TreeEntry = { path: expectedName, abs, bytes: bytes.length, digest };
  return { kind, name: expectedName, files: [entry], artifact_digest: digest, bundle_files_digest: await digestOf([[expectedName, digest]], nodeSha256), primary_text: text, frontmatter: {} };
}

async function loadTask(root: string, id: string, reasons: string[]): Promise<ResolvedTask | null> {
  const dir = resolveUnder(root, `tasks/${id}`);
  const at = `tasks/${id}`;
  const y = yamlObject(await readTrustedFile(dir, "task.yaml", MAX_YAML_BYTES), `${at}/task.yaml`);
  const local: string[] = [];
  if (y.id !== id) local.push(`${at}: id must equal the folder name`);
  if (typeof y.label !== "string" || !y.label.trim() || y.label.length > 200) local.push(`${at}: label must be 1-200 characters`);
  for (const key of ["prompt_file", "fixture", "oracle"]) if (typeof y[key] !== "string" || relativePathError(y[key])) local.push(`${at}: ${key} must be a safe relative path`);
  const gErrors = graderDefErrors(y.graders);
  local.push(...gErrors.map((e) => `${at}: ${e}`));
  const timeout = y.grader_timeout_ms;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1)) local.push(`${at}: grader_timeout_ms must be a positive integer`);
  if (local.length) {
    reasons.push(...local);
    return null;
  }
  const promptBytes = await readTrustedFile(dir, y.prompt_file as string, MAX_PROMPT_BYTES);
  const prompt = decodeUtf8(promptBytes);
  if (prompt === null || !prompt.trim()) {
    reasons.push(`${at}: prompt must be non-empty UTF-8`);
    return null;
  }
  const fixtureDir = resolveUnder(dir, y.fixture as string);
  const oracleDir = resolveUnder(dir, y.oracle as string);
  const fixture = await walkTree(fixtureDir);
  const oracle = await walkTree(oracleDir);
  const graders = (y.graders as Array<Record<string, unknown>>).map((g) => normalizeGrader(g));
  const expected: Record<string, string> = {};
  const expectedDigests: Record<string, Digest> = {};
  for (const g of graders) {
    if (g.kind !== "file_equals") continue;
    const bytes = await readTrustedFile(dir, g.expected);
    const text = decodeUtf8(bytes);
    if (text === null) {
      reasons.push(`${at}: expected file for ${g.id} is not UTF-8`);
      return null;
    }
    expected[g.id] = text;
    expectedDigests[g.id] = sha256Hex(bytes);
  }
  const gradersDir = resolve(dir, "graders");
  const graderScripts = existsSync(gradersDir) ? await treeDigestOf(gradersDir) : "none";
  const graderDigest = await digestOf({ graders, expected: expectedDigests, scripts: graderScripts, timeout_ms: timeout ?? null }, nodeSha256);
  return {
    descriptor: {
      task_id: id,
      display_label: (y.label as string).trim(),
      prompt_digest: sha256Hex(promptBytes),
      fixture_tree_digest: await treeDigestOf(fixtureDir),
      grader_digest: graderDigest,
      oracle_digest: await treeDigestOf(oracleDir),
      suite_path: `tasks/${id}`,
    },
    dir,
    prompt,
    fixture,
    oracle,
    graders,
    expected,
    grader_timeout_ms: typeof timeout === "number" ? timeout : null,
  };
}

function normalizeGrader(g: Record<string, unknown>): GraderDef {
  const id = g.id as string;
  switch (g.kind) {
    case "file_exists":
      return { id, kind: "file_exists", path: g.path as string };
    case "file_contains":
      return { id, kind: "file_contains", path: g.path as string, pattern: g.pattern as string, flags: typeof g.flags === "string" ? g.flags : "" };
    case "file_equals":
      return { id, kind: "file_equals", path: g.path as string, expected: g.expected as string, normalize_line_endings: g.normalize_line_endings as boolean };
    case "command_exit":
      return { id, kind: "command_exit", argv: g.argv as string[], expect_exit: g.expect_exit as number };
    default:
      return { id, kind: "json_score", argv: g.argv as string[], threshold: g.threshold as number };
  }
}

/** Loads and digests a suite; throws SuiteError with every reason when anything is invalid. */
export async function loadSuite(suiteDir: string): Promise<LoadedSuite> {
  const root = resolve(suiteDir);
  const reasons: string[] = [];
  try {
    await assertPlain(root, "dir");
    const y = yamlObject(await readTrustedFile(root, "suite.yaml", MAX_YAML_BYTES), "suite.yaml");
    if (!isSafeId(y.suite_id)) reasons.push("suite.suite_id must be a safe id");
    if (typeof y.version !== "string" || !y.version.trim()) reasons.push('suite.version must be a string such as "1"');
    const ids = y.tasks;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 256 || !ids.every(isSafeId)) reasons.push("suite.tasks must list 1-256 safe task ids");
    else if (new Set(ids).size !== ids.length) reasons.push("suite.tasks has duplicates");
    const candidate = await loadCandidate(root, y.candidate, reasons);
    const tasks: ResolvedTask[] = [];
    if (Array.isArray(ids) && reasons.length === 0) {
      for (const id of [...(ids as string[])].sort()) {
        const t = await loadTask(root, id, reasons);
        if (t) tasks.push(t);
      }
    }
    if (reasons.length || !candidate) throw new SuiteError(reasons.length ? reasons : ["candidate could not be loaded"]);
    return {
      root,
      suite_id: y.suite_id as string,
      version: y.version as string,
      description: typeof y.description === "string" ? y.description : "",
      digest: await treeDigestOf(root),
      tasks,
      candidate,
    };
  } catch (error) {
    if (error instanceof SuiteError) throw error;
    if (error instanceof FsBoundError) throw new SuiteError([...reasons, error.message]);
    throw new SuiteError([...reasons, error instanceof Error ? error.message : String(error)]);
  }
}

/** Recomputes the suite digest to confirm the trusted suite is unchanged since scheduling. */
export async function suiteUnchanged(suite: LoadedSuite): Promise<boolean> {
  return (await treeDigestOf(suite.root)) === suite.digest;
}

export function promptBytesDigest(prompt: string): Digest {
  return sha256Hex(utf8(prompt));
}
