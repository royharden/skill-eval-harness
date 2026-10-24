// Owned child-process host (PLAN.md §7–§8): shell disabled, allowlisted env, first-event and total deadlines,
// combined output cap, process-tree termination with confirmed exit. A promise timeout alone is never cleanup.
// Validated OS/version combinations: none yet (Dirty Mode). Windows uses taskkill /T /F; POSIX uses process groups.

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface HostLimits {
  first_event_timeout_ms: number | null;
  total_timeout_ms: number;
  max_output_bytes: number;
  /** How long to wait for confirmed exit after a kill request. */
  kill_confirm_ms?: number;
}

export interface HostCallbacks {
  /** Called synchronously right after spawn with the child pid, before any output is read. */
  onSpawn?: (pid: number) => void;
  /** Called per complete stdout line. Return true once the adapter has seen its first meaningful event. */
  onStdoutLine?: (line: string) => boolean | void;
  onStderrLine?: (line: string) => void;
}

export type HostTermination = "exited" | "first_event_timeout" | "total_timeout" | "output_cap" | "cancelled" | "spawn_error";

export interface HostResult {
  termination: HostTermination;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  first_event_at: string | null;
  ended_at: string;
  duration_ms: number;
  /** Bounded raw capture; combined stdout+stderr bytes never exceed max_output_bytes. Private; never exported. */
  stdout: string;
  stderr: string;
  raw_bytes: number;
  truncated: boolean;
  cleanup: "confirmed" | "not_needed" | "cleanup_pending";
  spawn_error: string | null;
  pid: number | null;
}

export interface CancelToken {
  cancelled: boolean;
  /** Registers a handler; returns an unsubscribe function that must be called when the owner settles. */
  onCancel(fn: () => void): () => void;
}

export function makeCancelToken(): CancelToken & { cancel(): void } {
  const handlers = new Set<() => void>();
  const token = {
    cancelled: false,
    onCancel(fn: () => void) {
      if (token.cancelled) {
        fn();
        return () => undefined;
      }
      handlers.add(fn);
      return () => {
        handlers.delete(fn);
      };
    },
    cancel() {
      if (token.cancelled) return;
      token.cancelled = true;
      const list = [...handlers];
      handlers.clear();
      for (const fn of list) fn();
    },
  };
  return token;
}

function leaderExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** POSIX group state: "empty" (no members), "members", or "unknown" (cannot probe). */
function groupState(pgid: number): "empty" | "members" | "unknown" {
  try {
    process.kill(-pgid, 0);
    return "members";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "empty" : code === "EPERM" ? "members" : "unknown";
  }
}

/**
 * POSIX: SIGKILL the whole group and poll until it is empty. The leader exiting is not tree exit.
 * Returns "empty" if nothing was left, "reaped" if members were killed and confirmed gone, "stuck" otherwise.
 */
export async function reapGroup(pgid: number, confirmMs: number, isSettled: () => boolean = () => false): Promise<"empty" | "reaped" | "stuck"> {
  if (groupState(pgid) === "empty") return "empty";
  if (isSettled()) return "stuck";
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* raced to empty */
  }
  const deadline = Date.now() + confirmMs;
  while (Date.now() < deadline) {
    const state = groupState(pgid);
    if (state === "empty") return "reaped";
    if (state === "unknown") return "stuck";
    await new Promise((r) => setTimeout(r, 50));
  }
  return "stuck";
}

/** Terminates the whole owned process tree and reports whether exit was confirmed. */
export async function killTree(child: ChildProcess, confirmMs: number, isSettled: () => boolean = () => false): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return true;
  if (process.platform === "win32") {
    // Once the leader has exited its pid may already belong to an unrelated process: never taskkill it by pid.
    // The tree cannot be confirmed from here, so report unconfirmed (caller records cleanup_pending).
    if (leaderExited(child)) return false;
    // Bounded: a taskkill that never returns must not leave the attempt unsettled.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, confirmMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      killer.once("error", done);
      killer.once("exit", done);
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* group already gone */
    }
    await waitExit(child, Math.min(2000, confirmMs));
    // Confirm the whole group, not only the leader: SIGKILL survivors and poll until the group is empty.
    const group = await reapGroup(pid, confirmMs, isSettled);
    return (await waitExit(child, confirmMs)) && group !== "stuck";
  }
  // Windows: taskkill /T is best effort for the tree; only the leader's exit can be confirmed here (not validated).
  return waitExit(child, confirmMs);
}

export async function runHosted(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; stdin: string | null },
  limits: HostLimits,
  callbacks: HostCallbacks,
  cancel: CancelToken,
): Promise<HostResult> {
  const startedMs = Date.now();
  const started_at = new Date(startedMs).toISOString();
  const confirmMs = limits.kill_confirm_ms ?? 10_000;
  let stdout = "";
  let stderr = "";
  let rawBytes = 0;
  let truncated = false;
  let firstEventAt: string | null = null;
  let termination: HostTermination = "exited";
  let child: ChildProcess;

  const finish = (partial: Partial<HostResult>): HostResult => {
    const endedMs = Date.now();
    return {
      termination,
      exit_code: null,
      signal: null,
      started_at,
      first_event_at: firstEventAt,
      ended_at: new Date(endedMs).toISOString(),
      duration_ms: endedMs - startedMs,
      stdout,
      stderr,
      raw_bytes: rawBytes,
      truncated,
      cleanup: "not_needed",
      spawn_error: null,
      pid: null,
      ...partial,
    };
  };

  if (argv.length === 0 || !argv[0]) {
    termination = "spawn_error";
    return finish({ spawn_error: "empty argv" });
  }
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [options.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    termination = "spawn_error";
    return finish({ spawn_error: error instanceof Error ? error.message : String(error) });
  }

  if (child.pid !== undefined) {
    try {
      callbacks.onSpawn?.(child.pid);
    } catch {
      /* the caller records its own failure; the process is still owned and is cleaned up below */
    }
  }

  return new Promise<HostResult>((resolvePromise) => {
    let settled = false;
    let killing: Promise<boolean> | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let spawnError: string | null = null;

    let closed = false;
    let exitPathActive = false;
    let unsubscribe: () => void = () => undefined;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    const settle = (result: HostResult) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (watchdog) clearInterval(watchdog);
      unsubscribe();
      resolvePromise(result);
    };
    const releasePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };

    const stop = (why: HostTermination) => {
      // Never signal after this attempt settled (its pid may be reused), nor once the leader has exited and
      // settlement is under way through the close or leader-exit path (that path reaps the group itself).
      if (killing || settled || closed || exitPathActive) return;
      termination = why;
      killing = killTree(child, confirmMs, () => settled);
    };

    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const capture = (tag: "o" | "e", chunk: Buffer) => {
      if (truncated) return;
      const remaining = limits.max_output_bytes - rawBytes;
      const kept = chunk.length > remaining ? chunk.subarray(0, Math.max(0, remaining)) : chunk;
      if (tag === "o") stdout += outDecoder.write(kept);
      else stderr += errDecoder.write(kept);
      rawBytes += kept.length;
      if (chunk.length > remaining) {
        truncated = true;
        stop("output_cap");
      }
    };

    const lineSplitter = (onLine: (line: string) => void) => {
      let buf = "";
      const decoder = new StringDecoder("utf8");
      return (chunk: Buffer) => {
        buf += decoder.write(chunk);
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          onLine(line);
        }
        if (buf.length > 1024 * 1024) buf = buf.slice(-1024 * 1024);
      };
    };

    const onOut = lineSplitter((line) => {
      const first = callbacks.onStdoutLine?.(line);
      if (first && firstEventAt === null) firstEventAt = new Date().toISOString();
    });
    const onErr = lineSplitter((line) => callbacks.onStderrLine?.(line));
    child.stdout?.on("data", (c: Buffer) => {
      capture("o", c);
      if (!truncated) onOut(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      capture("e", c);
      if (!truncated) onErr(c);
    });
    if (options.stdin !== null && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }

    if (limits.first_event_timeout_ms !== null) {
      timers.push(setTimeout(() => {
        if (firstEventAt === null) stop("first_event_timeout");
      }, limits.first_event_timeout_ms));
    }
    timers.push(setTimeout(() => stop("total_timeout"), limits.total_timeout_ms));
    unsubscribe = cancel.onCancel(() => stop("cancelled"));

    child.once("error", (error) => {
      spawnError = error.message;
    });
    let exitPathReaped = false;
    child.once("close", (code, signal) => {
      if (settled || closed) return;
      closed = true;
      for (const t of timers) clearTimeout(t);
      const done = async () => {
        let cleanup: HostResult["cleanup"] = "not_needed";
        if (killing) cleanup = (await killing) ? "confirmed" : "cleanup_pending";
        else if (process.platform !== "win32" && child.pid !== undefined) {
          // POSIX: after a normal exit, a detached descendant could outlive the leader; reap and confirm the group.
          const group = await reapGroup(child.pid, confirmMs, () => settled);
          cleanup = group === "stuck" ? "cleanup_pending" : group === "reaped" || exitPathReaped ? "confirmed" : "not_needed";
        }
        if (spawnError && child.pid === undefined) termination = "spawn_error";
        settle(finish({ exit_code: code, signal: signal ?? null, cleanup, spawn_error: spawnError, pid: child.pid ?? null }));
      };
      void done();
    });
    // Leader exited but "close" does not follow: only a descendant can still hold the pipes, so something is alive.
    // Best effort: reap the POSIX group (escaped descendants are invisible to it), then give "close" one more short
    // window. If close arrives, the close handler settles (confirmed when the reap killed members). Otherwise the
    // holder is still alive: release our pipe ends and settle cleanup_pending, never "confirmed".
    child.once("exit", (code, signal) => {
      const grace = Math.min(2000, confirmMs);
      setTimeout(() => {
        if (settled || closed || killing) return;
        exitPathActive = true;
        for (const t of timers) clearTimeout(t);
        const finishExit = async () => {
          if (process.platform !== "win32" && child.pid !== undefined) {
            const group = await reapGroup(child.pid, confirmMs, () => settled);
            if (group === "reaped") exitPathReaped = true;
          }
          await new Promise((r) => setTimeout(r, grace));
          // A cancel/deadline that started meanwhile owns settlement through the kill/watchdog path.
          if (settled || closed || killing) return;
          releasePipes();
          settle(finish({ exit_code: code, signal: signal ?? null, cleanup: "cleanup_pending", spawn_error: spawnError, pid: child.pid ?? null }));
        };
        void finishExit();
      }, grace);
    });
    // After a kill, "close" may never fire (unconfirmed exit, or a surviving descendant still holds the pipes).
    // Settle with cleanup_pending after one more confirmation window so scheduling stops instead of hanging.
    let watching = false;
    watchdog = setInterval(() => {
      if (settled || !killing || watching) return;
      watching = true;
      void killing.then(() => {
        setTimeout(() => {
          if (settled || closed) return;
          // Release our ends so a descendant holding the pipes cannot keep the runner alive.
          releasePipes();
          settle(finish({ exit_code: child.exitCode, cleanup: "cleanup_pending", pid: child.pid ?? null }));
        }, confirmMs);
      });
    }, 250);
  });
}
