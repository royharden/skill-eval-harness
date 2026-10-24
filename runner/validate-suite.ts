// No-spend suite validation (PLAN.md §6): oracle-applied fixture must pass; untouched fixture must fail.
// Any invalid task fails the whole suite. Uses the same capture and pure graders as real runs.

import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateGraders } from "../supabase/functions/publish-run/domain/graders.ts";
import { DEFAULT_LIMITS } from "../supabase/functions/publish-run/domain/limits.ts";
import { captureSnapshot } from "./capture.ts";
import { copyTree, resolveUnder } from "./fsutil.ts";
import type { LoadedSuite, ResolvedTask } from "./suite.ts";

export interface TaskValidation {
  task_id: string;
  oracle: string;
  untouched: string;
  ok: boolean;
  reasons: string[];
}

async function overlay(task: ResolvedTask, dest: string): Promise<void> {
  for (const e of task.oracle) {
    const target = resolveUnder(dest, e.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(e.abs, target);
  }
}

export async function validateSuite(suite: LoadedSuite): Promise<{ ok: boolean; tasks: TaskValidation[] }> {
  const scratch = await mkdtemp(join(tmpdir(), "s20-validate-"));
  const results: TaskValidation[] = [];
  try {
    for (const task of suite.tasks) {
      const timeout = Math.min(task.grader_timeout_ms ?? DEFAULT_LIMITS.grader_timeout_ms, DEFAULT_LIMITS.grader_timeout_ms);
      const withOracle = join(scratch, task.descriptor.task_id, "oracle");
      const untouched = join(scratch, task.descriptor.task_id, "untouched");
      await copyTree(task.fixture, withOracle);
      await overlay(task, withOracle);
      await copyTree(task.fixture, untouched);
      const a = evaluateGraders(task.graders, await captureSnapshot(withOracle, task.dir, task.graders, task.expected, timeout));
      const b = evaluateGraders(task.graders, await captureSnapshot(untouched, task.dir, task.graders, task.expected, timeout));
      const reasons: string[] = [];
      if (a.status !== "pass") reasons.push(`oracle-applied fixture did not pass (${a.status}${a.errors.length ? `: ${a.errors.join("; ")}` : ""}; failing: ${a.checks.filter((c) => !c.pass).map((c) => c.check_id).join(", ") || "none"})`);
      if (b.status !== "fail") reasons.push(`untouched fixture must fail but was ${b.status}${b.errors.length ? `: ${b.errors.join("; ")}` : ""}`);
      results.push({ task_id: task.descriptor.task_id, oracle: a.status, untouched: b.status, ok: reasons.length === 0, reasons });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { ok: results.every((r) => r.ok), tasks: results };
}
