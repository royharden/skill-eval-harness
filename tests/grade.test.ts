import { describe, expect, it } from "vitest";
import { gradeSnapshot, type WorkspaceSnapshot } from "../supabase/functions/publish-run/domain/grade.ts";

const snapshot: WorkspaceSnapshot = {
  files: { "out/report.txt": "status: ok\n" },
  commands: {
    check: { exitCode: 0, stdout: '{"score": 1}', stderr: "" },
    weak: { exitCode: 2, stdout: '{"score": 0.2}', stderr: "nope" },
  },
};

describe("gradeSnapshot", () => {
  it("fails closed when no checks are declared", () => {
    expect(gradeSnapshot(snapshot, []).pass).toBe(false);
  });

  it("passes only when every check passes", () => {
    const graded = gradeSnapshot(snapshot, [
      { type: "file_exists", path: "out/report.txt" },
      { type: "file_contains", path: "out/report.txt", pattern: "status: ok" },
      { type: "command_exit", commandId: "check", exitCode: 0 },
      { type: "json_score", commandId: "check", minScore: 1 },
    ]);
    expect(graded.pass).toBe(true);
  });

  it("fails the task when one member fails", () => {
    const graded = gradeSnapshot(snapshot, [
      { type: "file_exists", path: "out/report.txt" },
      { type: "command_exit", commandId: "weak", exitCode: 0 },
    ]);
    expect(graded.pass).toBe(false);
    expect(graded.checks[1]?.pass).toBe(false);
  });

  it("records a bad pattern as a failed check", () => {
    const graded = gradeSnapshot(snapshot, [{ type: "file_contains", path: "out/report.txt", pattern: "(", flags: "i" }]);
    expect(graded.pass).toBe(false);
    expect(graded.checks[0]?.detail).toMatch(/regular expression/);
  });

  it("rejects flag letters outside i, m, and s", () => {
    const graded = gradeSnapshot(snapshot, [
      { type: "file_contains", path: "out/report.txt", pattern: "ok", flags: "g" },
    ]);
    expect(graded.checks[0]?.detail).toMatch(/flags/);
  });

  it("rejects a score that is not a number", () => {
    const graded = gradeSnapshot(
      { files: {}, commands: { check: { exitCode: 0, stdout: '{"score":"high"}', stderr: "" } } },
      [{ type: "json_score", commandId: "check", minScore: 1 }],
    );
    expect(graded.checks[0]?.detail).toMatch(/numeric score/);
  });
});
