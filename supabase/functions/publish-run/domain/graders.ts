// Deterministic grader definitions and pure evaluation over a captured WorkspaceSnapshot (PLAN.md §6).
// Capture (runner, Node-only) and evaluation (here) are separate. Missing task output is a valid fail;
// malformed definitions, patterns, commands or grader output are grader_error.

import type { CheckResult } from "./contracts.ts";
import { isSafeId, relativePathError } from "./limits.ts";
import { compilePattern, PatternError } from "./safe-regex.ts";

export type GraderDef =
  | { id: string; kind: "file_exists"; path: string }
  | { id: string; kind: "file_contains"; path: string; pattern: string; flags: string }
  | { id: string; kind: "file_equals"; path: string; expected: string; normalize_line_endings: boolean }
  | { id: string; kind: "command_exit"; argv: string[]; expect_exit: number }
  | { id: string; kind: "json_score"; argv: string[]; threshold: number };

export type CapturedFile =
  | { kind: "file"; bytes: number; text: string | null; digest: string }
  | { kind: "missing" }
  | { kind: "not-regular" };

export interface CapturedCommand {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  spawn_error: string | null;
}

export interface WorkspaceSnapshot {
  files: Record<string, CapturedFile>;
  commands: Record<string, CapturedCommand>;
  /** Trusted expected file texts for file_equals, keyed by grader id (never from the agent workspace). */
  expected: Record<string, string>;
}

export interface GradeOutcome {
  status: "pass" | "fail" | "grader_error";
  checks: CheckResult[];
  score: number | null;
  errors: string[];
}

/** Static authoring checks shared by the suite loader and evaluation. */
export function graderDefErrors(defs: unknown): string[] {
  if (!Array.isArray(defs) || defs.length === 0) return ["graders must be a non-empty list"];
  const errors: string[] = [];
  const ids = new Set<string>();
  defs.forEach((raw, i) => {
    const d = raw as Record<string, unknown>;
    const at = `graders[${i}]`;
    if (!d || typeof d !== "object") return void errors.push(`${at} must be an object`);
    if (!isSafeId(d.id)) errors.push(`${at}.id must be a safe id`);
    else if (ids.has(d.id as string)) errors.push(`${at}.id is duplicated`);
    else ids.add(d.id as string);
    const pathCheck = () => {
      const e = relativePathError(d.path);
      if (e) errors.push(`${at}.path: ${e}`);
    };
    const argvCheck = () => {
      if (!Array.isArray(d.argv) || d.argv.length === 0 || d.argv.length > 64 || !d.argv.every((a) => typeof a === "string" && a.length > 0 && a.length <= 4096)) {
        errors.push(`${at}.argv must be 1-64 non-empty strings`);
      }
    };
    switch (d.kind) {
      case "file_exists":
        pathCheck();
        break;
      case "file_contains":
        pathCheck();
        if (typeof d.pattern !== "string" || d.pattern.length === 0) errors.push(`${at}.pattern must be a non-empty string`);
        else
          try {
            compilePattern(d.pattern, typeof d.flags === "string" ? d.flags : "");
          } catch (error) {
            errors.push(`${at}.pattern: ${error instanceof PatternError ? error.message : "invalid"}`);
          }
        if (d.flags !== undefined && typeof d.flags !== "string") errors.push(`${at}.flags must be a string`);
        break;
      case "file_equals":
        pathCheck();
        if (typeof d.normalize_line_endings !== "boolean") errors.push(`${at}.normalize_line_endings must be true or false`);
        break;
      case "command_exit":
        argvCheck();
        if (typeof d.expect_exit !== "number" || !Number.isInteger(d.expect_exit) || d.expect_exit < 0 || d.expect_exit > 255) errors.push(`${at}.expect_exit must be 0-255`);
        break;
      case "json_score":
        argvCheck();
        if (typeof d.threshold !== "number" || !(d.threshold >= 0 && d.threshold <= 1)) errors.push(`${at}.threshold must be in [0,1]`);
        break;
      default:
        errors.push(`${at}.kind is not a supported grader`);
    }
  });
  return errors;
}

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** All checks must pass. Any grader_error makes the attempt grader_error regardless of other checks. */
export function evaluateGraders(defs: GraderDef[], snapshot: WorkspaceSnapshot): GradeOutcome {
  const authoring = graderDefErrors(defs);
  if (authoring.length) return { status: "grader_error", checks: [], score: null, errors: authoring };
  const checks: CheckResult[] = [];
  const errors: string[] = [];
  const scores: number[] = [];
  const pass = (d: GraderDef, ok: boolean, detail: string) => checks.push({ check_id: d.id, kind: d.kind, pass: ok, detail });

  for (const d of defs) {
    if (d.kind === "file_exists" || d.kind === "file_contains" || d.kind === "file_equals") {
      const f = snapshot.files[d.path];
      if (!f) {
        errors.push(`${d.id}: ${d.path} was not captured`);
        continue;
      }
      if (f.kind === "missing") {
        pass(d, false, `${d.path} is missing`);
        continue;
      }
      if (f.kind === "not-regular") {
        pass(d, false, `${d.path} is not a regular file`);
        continue;
      }
      if (d.kind === "file_exists") {
        pass(d, true, `${d.path} exists`);
        continue;
      }
      if (f.text === null) {
        errors.push(`${d.id}: ${d.path} is too large or not UTF-8 text to evaluate`);
        continue;
      }
      if (d.kind === "file_contains") {
        try {
          const ok = compilePattern(d.pattern, d.flags).test(f.text);
          pass(d, ok, ok ? `${d.path} matched` : `${d.path} did not match`);
        } catch (error) {
          errors.push(`${d.id}: ${error instanceof Error ? error.message : "pattern failed"}`);
        }
        continue;
      }
      const expected = snapshot.expected[d.id];
      if (expected === undefined) {
        errors.push(`${d.id}: trusted expected content was not loaded`);
        continue;
      }
      const ok = d.normalize_line_endings ? lf(f.text) === lf(expected) : f.text === expected;
      pass(d, ok, ok ? `${d.path} equals the expected file` : `${d.path} differs from the expected file`);
      continue;
    }
    const cmd = snapshot.commands[d.id];
    if (!cmd) {
      errors.push(`${d.id}: command result was not recorded`);
      continue;
    }
    if (cmd.spawn_error) {
      errors.push(`${d.id}: grader command could not start (${cmd.spawn_error})`);
      continue;
    }
    if (cmd.timed_out) {
      errors.push(`${d.id}: grader command timed out`);
      continue;
    }
    if (cmd.truncated) {
      errors.push(`${d.id}: grader output exceeded the capture limit`);
      continue;
    }
    if (d.kind === "command_exit") {
      if (cmd.exit_code === null) {
        errors.push(`${d.id}: grader command ended without an exit code`);
        continue;
      }
      const ok = cmd.exit_code === d.expect_exit;
      pass(d, ok, ok ? `exited ${cmd.exit_code}` : `exited ${cmd.exit_code}, expected ${d.expect_exit}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cmd.stdout.trim());
    } catch {
      errors.push(`${d.id}: grader output is not JSON`);
      continue;
    }
    const score = (parsed as { score?: unknown } | null)?.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      errors.push(`${d.id}: grader JSON needs a finite score in [0,1]`);
      continue;
    }
    if (cmd.exit_code !== 0) {
      errors.push(`${d.id}: score command exited ${cmd.exit_code}`);
      continue;
    }
    scores.push(score);
    const ok = score >= d.threshold;
    pass(d, ok, ok ? `score ${score} >= ${d.threshold}` : `score ${score} < ${d.threshold}`);
  }

  if (errors.length) return { status: "grader_error", checks, score: null, errors };
  return { status: checks.every((c) => c.pass) ? "pass" : "fail", checks, score: scores.length ? Math.min(...scores) : null, errors: [] };
}
