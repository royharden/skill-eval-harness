export type GradeCheck =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; pattern: string; flags?: string }
  | { type: "command_exit"; commandId: string; exitCode: number }
  | { type: "json_score"; commandId: string; minScore: number };

export interface WorkspaceSnapshot {
  files: Record<string, string>;
  commands: Record<string, { exitCode: number; stdout: string; stderr: string }>;
}

export interface CheckResult {
  type: GradeCheck["type"];
  pass: boolean;
  detail: string;
}

const FLAG_OK = /^[ims]*$/;

/** Headline grader. Every check must pass. An empty check list fails closed. */
export function gradeSnapshot(snapshot: WorkspaceSnapshot, checks: GradeCheck[]): {
  pass: boolean;
  checks: CheckResult[];
} {
  if (checks.length === 0) {
    return { pass: false, checks: [{ type: "file_exists", pass: false, detail: "no checks were declared" }] };
  }
  const results = checks.map((check) => runCheck(snapshot, check));
  return { pass: results.every((result) => result.pass), checks: results };
}

function runCheck(snapshot: WorkspaceSnapshot, check: GradeCheck): CheckResult {
  if (check.type === "file_exists") {
    const present = Object.prototype.hasOwnProperty.call(snapshot.files, check.path);
    return {
      type: check.type,
      pass: present,
      detail: present ? `${check.path} is present` : `${check.path} is missing`,
    };
  }
  if (check.type === "file_contains") {
    if (check.flags && !FLAG_OK.test(check.flags)) {
      return { type: check.type, pass: false, detail: "flags must be a subset of i, m, s" };
    }
    const text = snapshot.files[check.path];
    if (text === undefined) return { type: check.type, pass: false, detail: `${check.path} is missing` };
    let regex: RegExp;
    try {
      regex = new RegExp(check.pattern, check.flags ?? "");
    } catch {
      return { type: check.type, pass: false, detail: "pattern is not a valid regular expression" };
    }
    const pass = regex.test(text);
    return { type: check.type, pass, detail: pass ? `${check.path} matched` : `${check.path} did not match` };
  }
  if (check.type === "command_exit") {
    const command = snapshot.commands[check.commandId];
    if (!command) return { type: check.type, pass: false, detail: `command ${check.commandId} was not recorded` };
    const pass = command.exitCode === check.exitCode;
    return {
      type: check.type,
      pass,
      detail: pass ? `${check.commandId} exited ${check.exitCode}` : `${check.commandId} exited ${command.exitCode}`,
    };
  }
  const command = snapshot.commands[check.commandId];
  if (!command) return { type: check.type, pass: false, detail: `command ${check.commandId} was not recorded` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(command.stdout);
  } catch {
    return { type: check.type, pass: false, detail: "stdout is not JSON" };
  }
  const score = parsed && typeof parsed === "object" && "score" in parsed ? (parsed as { score: unknown }).score : undefined;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return { type: check.type, pass: false, detail: "stdout JSON has no numeric score" };
  }
  const pass = score >= check.minScore;
  return { type: check.type, pass, detail: pass ? `score ${score} met ${check.minScore}` : `score ${score} was below ${check.minScore}` };
}
