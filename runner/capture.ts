// Trusted capture after confirmed agent exit (PLAN.md §6): reads the files graders name and runs trusted grader
// commands (shell disabled, bounded time/output). Pure evaluation happens in domain/graders.ts.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import type { CapturedCommand, CapturedFile, GraderDef, WorkspaceSnapshot } from "../supabase/functions/publish-run/domain/graders.ts";
import { MAX_TEXT_CHARS } from "../supabase/functions/publish-run/domain/safe-regex.ts";
import { assertNoLinkedAncestors, decodeUtf8, FsBoundError, resolveUnder, sha256Hex } from "./fsutil.ts";
import { makeCancelToken, runHosted } from "./process-host.ts";

const GRADER_OUTPUT_BYTES = 1024 * 1024;
const CAPTURE_FILE_BYTES = 512 * 1024;

/** Minimal environment for trusted grader commands; no provider credentials. */
export function graderEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  env.NO_COLOR = "1";
  return env;
}

export function expandArgv(argv: string[], vars: { task: string; workspace: string }): string[] {
  return argv.map((a) => a.replaceAll("{node}", process.execPath).replaceAll("{task}", vars.task).replaceAll("{workspace}", vars.workspace));
}

async function streamDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function captureFile(workspace: string, rel: string): Promise<CapturedFile> {
  let abs: string;
  try {
    abs = resolveUnder(workspace, rel);
  } catch {
    return { kind: "not-regular" };
  }
  try {
    const st = await lstat(abs);
    if (!st.isFile() || st.isSymbolicLink()) return { kind: "not-regular" };
    await assertNoLinkedAncestors(workspace, abs);
    if (st.size > CAPTURE_FILE_BYTES) return { kind: "file", bytes: st.size, text: null, digest: await streamDigest(abs) };
    const bytes = new Uint8Array(await readFile(abs));
    const text = decodeUtf8(bytes);
    return { kind: "file", bytes: bytes.length, text: text !== null && text.length <= MAX_TEXT_CHARS ? text : null, digest: sha256Hex(bytes) };
  } catch (error) {
    if (error instanceof FsBoundError) return { kind: "not-regular" };
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return { kind: "missing" };
    return { kind: "not-regular" };
  }
}

export async function captureSnapshot(
  workspace: string,
  taskDir: string,
  graders: GraderDef[],
  expected: Record<string, string>,
  graderTimeoutMs: number,
  onCleanupPending?: (pid: number | null) => void,
): Promise<WorkspaceSnapshot> {
  const files: Record<string, CapturedFile> = {};
  const commands: Record<string, CapturedCommand> = {};
  for (const g of graders) {
    if (g.kind === "file_exists" || g.kind === "file_contains" || g.kind === "file_equals") {
      if (!(g.path in files)) files[g.path] = await captureFile(workspace, g.path);
      continue;
    }
    const argv = expandArgv(g.argv, { task: taskDir, workspace });
    const result = await runHosted(
      argv,
      { cwd: workspace, env: graderEnv(), stdin: null },
      { first_event_timeout_ms: null, total_timeout_ms: graderTimeoutMs, max_output_bytes: GRADER_OUTPUT_BYTES },
      {},
      makeCancelToken(),
    );
    if (result.cleanup === "cleanup_pending") onCleanupPending?.(result.pid);
    commands[g.id] = {
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr.slice(0, 4096),
      timed_out: result.termination === "total_timeout",
      truncated: result.truncated,
      spawn_error: result.spawn_error ?? (result.termination === "spawn_error" ? "spawn failed" : result.cleanup === "cleanup_pending" ? "grader process cleanup was not confirmed" : null),
    };
  }
  return { files, commands, expected: { ...expected } };
}
