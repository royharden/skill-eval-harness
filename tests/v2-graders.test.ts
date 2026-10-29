import { describe, expect, it } from "vitest";
import { evaluateGraders, type GraderDef, type WorkspaceSnapshot } from "../supabase/functions/publish-run/domain/graders.ts";
import { compilePattern, PatternError } from "../supabase/functions/publish-run/domain/safe-regex.ts";

const file = (text: string) => ({ kind: "file" as const, bytes: text.length, text, digest: "0".repeat(64) });
const cmd = (exit_code: number | null, stdout = "") => ({ exit_code, stdout, stderr: "", timed_out: false, truncated: false, spawn_error: null });

describe("linear-time pattern subset", () => {
  it.each([
    ["^## \\[1\\.4\\.0\\] - 2026-10-23$", "m", "# Changelog\n\n## [1.4.0] - 2026-10-23\n", true],
    ["^## \\[1\\.4\\.0\\]", "", "x\n## [1.4.0]", false],
    ["colou?r", "", "color", true],
    ["(ab|cd)+e", "", "xxabcdabe", true],
    ["[0-9]+-[0-9]+", "", "v1-22", true],
    ["[^a-z]", "", "abc", false],
    ["HELLO", "i", "say hello", true],
    ["a.c", "", "a\nc", false],
    ["\\d\\d\\d\\d-\\d\\d-\\d\\d", "", "2026-10-23", true],
  ])("%s /%s on %j -> %s", (pattern, flags, text, expected) => {
    expect(compilePattern(pattern, flags).test(text)).toBe(expected);
  });
  it.each(["a{2}", "(?=a)", "a*?", "\\1", "(?<n>a)", "\\b"])("refuses unsupported %s", (pattern) => {
    expect(() => compilePattern(pattern)).toThrow(PatternError);
  });
  it("refuses unsupported flags", () => {
    expect(() => compilePattern("a", "g")).toThrow(PatternError);
  });
  it("stays linear on a classic catastrophic-backtracking input", () => {
    const started = Date.now();
    expect(compilePattern("(a+)+$").test(`${"a".repeat(5000)}!`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("grader evaluation", () => {
  const snap = (over: Partial<WorkspaceSnapshot>): WorkspaceSnapshot => ({ files: {}, commands: {}, expected: {}, ...over });

  it("fails (not grader_error) when expected task output is missing", () => {
    const defs: GraderDef[] = [{ id: "c", kind: "file_exists", path: "OUT.md" }];
    expect(evaluateGraders(defs, snap({ files: { "OUT.md": { kind: "missing" } } })).status).toBe("fail");
  });
  it("is grader_error for an empty definition list or an invalid pattern", () => {
    expect(evaluateGraders([], snap({})).status).toBe("grader_error");
    const bad: GraderDef[] = [{ id: "c", kind: "file_contains", path: "a", pattern: "a{2}", flags: "" }];
    expect(evaluateGraders(bad, snap({ files: { a: file("aa") } })).status).toBe("grader_error");
  });
  it("compares file_equals exactly unless LF normalization is pinned", () => {
    const strict: GraderDef[] = [{ id: "eq", kind: "file_equals", path: "a", expected: "x", normalize_line_endings: false }];
    const lf: GraderDef[] = [{ id: "eq", kind: "file_equals", path: "a", expected: "x", normalize_line_endings: true }];
    const s = snap({ files: { a: file("l1\r\nl2\r\n") }, expected: { eq: "l1\nl2\n" } });
    expect(evaluateGraders(strict, s).status).toBe("fail");
    expect(evaluateGraders(lf, s).status).toBe("pass");
  });
  it("treats a valid low json_score as fail and invalid JSON as grader_error", () => {
    const defs: GraderDef[] = [{ id: "s", kind: "json_score", argv: ["x"], threshold: 0.8 }];
    expect(evaluateGraders(defs, snap({ commands: { s: cmd(0, '{"score":0.5}') } })).status).toBe("fail");
    expect(evaluateGraders(defs, snap({ commands: { s: cmd(0, '{"score":0.9}') } })).status).toBe("pass");
    expect(evaluateGraders(defs, snap({ commands: { s: cmd(0, "not json") } })).status).toBe("grader_error");
    expect(evaluateGraders(defs, snap({ commands: { s: cmd(0, '{"score":2}') } })).status).toBe("grader_error");
  });
  it("treats a nonzero command_exit as a failed check and a timeout as grader_error", () => {
    const defs: GraderDef[] = [{ id: "t", kind: "command_exit", argv: ["x"], expect_exit: 0 }];
    expect(evaluateGraders(defs, snap({ commands: { t: cmd(1) } })).status).toBe("fail");
    expect(evaluateGraders(defs, snap({ commands: { t: { ...cmd(null), timed_out: true } } })).status).toBe("grader_error");
  });
});
