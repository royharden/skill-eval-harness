// Run orchestration (PLAN.md §7–§8): suite -> resolved experiment -> scheduler -> adapter/process host ->
// trusted capture/grader -> immutable writer -> shared summary. Serial dispatch only.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { resolve } from "node:path";
import { canonicalJson, digestOf, utf8 } from "../supabase/functions/publish-run/domain/canonical.ts";
import { SCHEMA_VERSION, type ArmDescriptor, type AttemptRecord, type AttemptStatus, type ExperimentSpec, type LedgerEdition, type PlanSide } from "../supabase/functions/publish-run/domain/contracts.ts";
import { evaluateGraders } from "../supabase/functions/publish-run/domain/graders.ts";
import { buildEnvelope, envelopeText } from "../supabase/functions/publish-run/domain/manifest.ts";
import type { RunSummary } from "../supabase/functions/publish-run/domain/summary.ts";
import { captureSnapshot } from "./capture.ts";
import { loadExperimentFile, resolveExperiment, type ExperimentFile, type ResolvedExperiment } from "./experiment.ts";
import { copyTree, insideGitWorkTree, isWithin, nodeSha256, resolveUnder, sha256Hex } from "./fsutil.ts";
import { makeCancelToken, runHosted, type CancelToken, type HostResult } from "./process-host.ts";
import { initialLedger } from "./schedule.ts";
import { RunStore } from "./store.ts";
import { loadSuite, suiteUnchanged, type LoadedSuite, type ResolvedTask } from "./suite.ts";
import { adapterFor } from "./adapters/index.ts";
import type { Adapter, ParsedState } from "./adapters/types.ts";

export class RunError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join("\n"));
  }
}

export interface RunOptions {
  experimentPath: string;
  outputRoot?: string | null;
  runId?: string | null;
  dryRun?: boolean;
  resume?: boolean;
  /** Attempt ids the operator confirms have no running process (needed when no pid was ever recorded). */
  confirmStopped?: string[];
  cancel?: CancelToken;
  log?: (line: string) => void;
}

export interface Prepared {
  file: ExperimentFile;
  suite: LoadedSuite;
  resolved: ResolvedExperiment;
  binary: string;
  ambient: Record<string, unknown>;
}

const now = () => new Date().toISOString();

/** Resolves binary + CLI version (preflight) without starting a model run. Dry run never spawns the CLI. */
async function detectCli(adapter: Adapter, dryRun: boolean): Promise<{ binary: string; version: string | null; problems: string[] }> {
  if (adapter.harness_id === "replay") return { binary: process.execPath, version: "replay-1", problems: [] };
  const problems: string[] = [];
  const binary = adapter.binary_env ? (process.env[adapter.binary_env] ?? "").trim() : "";
  if (!binary) problems.push(`Set ${adapter.binary_env} to the pinned ${adapter.harness_id} executable. The runner never downloads CLIs.`);
  else if (/\.(cmd|bat|ps1)$/i.test(binary)) problems.push(`${adapter.binary_env} points at a shell shim; the shell is disabled, so point it at the real executable`);
  for (const name of adapter.auth_env_names) if (!process.env[name]) problems.push(`${name} is not set for the child (name checked only; values are never read into records)`);
  if (dryRun || !binary) return { binary, version: null, problems };
  const argv = adapter.version_argv(binary);
  if (!argv) return { binary, version: null, problems };
  const r = await runHosted(argv, { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" }, stdin: null }, { first_event_timeout_ms: null, total_timeout_ms: 20_000, max_output_bytes: 64 * 1024 }, {}, makeCancelToken());
  const version = r.exit_code === 0 ? (r.stdout.trim().split(/\s+/).find((t) => /\d+\.\d+/.test(t)) ?? r.stdout.trim().slice(0, 64)) : null;
  if (!version) problems.push(`${binary} did not report a version`);
  return { binary, version, problems };
}

export async function prepare(experimentPath: string, dryRun: boolean): Promise<Prepared> {
  const { file, dir } = await loadExperimentFile(experimentPath);
  const suite = await loadSuite(resolve(dir, file.suite));
  const adapter = adapterFor(file.harness);
  const cli = await detectCli(adapter, dryRun);
  if (cli.problems.length && !dryRun) throw new RunError(cli.problems);
  const ambient: Record<string, unknown> = {
    harness: file.harness,
    cli_version: cli.version ?? (dryRun ? "unverified (dry run)" : "unknown"),
    os: platform(),
    os_release: release(),
    arch: arch(),
    node: process.version,
    env_names: [...file.environment_allowlist].sort(),
    capabilities: adapter.capabilities,
    discovery_locations: Object.fromEntries(adapter.discovery_locations.map((rel) => [rel, existsSync(resolve(homedir(), rel)) ? "present" : "absent"])),
    ambient_note: "per-run isolation is proposed, not proof that ancestor/system/plugin/enterprise context was excluded",
  };
  const resolved = await resolveExperiment(file, suite, ambient);
  return { file, suite, resolved, binary: cli.binary, ambient };
}

export function dryRunReport(p: Prepared): string {
  const { spec } = p.resolved;
  const sides = initialLedger(spec, "dry-run", now()).sides;
  const lines = [
    `DRY RUN — no native or model process is started.`,
    `experiment ${spec.experiment_id}  digest ${spec.experiment_digest}`,
    `suite ${spec.suite.suite_id} v${spec.suite.version}  digest ${spec.suite.digest}`,
    `harness ${spec.harness_id}  model ${spec.requested_model_id}  cli ${spec.pinned_cli_version}`,
    `arms: baseline ${spec.arms[0].arm_digest}; treatment ${spec.arms[1].artifact_kind}/${spec.arms[1].exposure_mode} ${spec.arms[1].arm_digest}`,
    `artifact ${spec.arms[1].artifact_digest}  bundle ${spec.arms[1].bundle_files_digest}`,
    `capabilities: discovery ${JSON.stringify(p.resolved.adapter.capabilities.discovery)} exposure ${JSON.stringify(p.resolved.adapter.capabilities.exposure_observation)}`,
    `limits ${canonicalJson(spec.limits)}`,
    `retry policy ${canonicalJson(spec.retry_policy)}  max attempts ${spec.limits.max_attempts}`,
    `env names passed to the child (values never shown): ${spec.environment_allowlist_names.join(", ")}`,
    `tasks:`,
    ...spec.tasks.map((t) => `  ${t.task_id}  prompt ${t.prompt_digest.slice(0, 12)} fixture ${t.fixture_tree_digest.slice(0, 12)} grader ${t.grader_digest.slice(0, 12)}`),
    `schedule (${sides.length} planned sides):`,
    ...sides.map((s) => `  #${s.order_index} ${s.task_id} r${s.repeat_id} ${s.arm_id}`),
  ];
  return lines.join("\n");
}

function attemptIdFor(side: PlanSide, attemptNo: number): string {
  return `${side.task_id}.r${side.repeat_id}.${side.arm_id}.a${attemptNo}`;
}

function childEnv(spec: ExperimentSpec, adapter: Adapter, paths: { workspace: string; home: string }): Record<string, string> {
  const env: Record<string, string> = {};
  const wanted = new Set(spec.environment_allowlist_names.map((n) => n.toUpperCase()));
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && wanted.has(k.toUpperCase())) env[k] = v;
  return { ...env, ...adapter.isolation_env(paths), NO_COLOR: "1" };
}

interface SideOutcome {
  record: AttemptRecord;
  stopReason: string | null;
}

async function runAttempt(p: Prepared, store: RunStore, runId: string, side: PlanSide, attemptNo: number, cancel: CancelToken): Promise<SideOutcome> {
  const { spec, adapter } = p.resolved;
  const task = p.suite.tasks.find((t) => t.descriptor.task_id === side.task_id) as ResolvedTask;
  const arm: ArmDescriptor = side.arm_id === "baseline" ? spec.arms[0] : spec.arms[1];
  const attemptId = attemptIdFor(side, attemptNo);
  const planned_at = now();
  const workspace = store.workspace(attemptId);
  const home = store.home(attemptId);
  const errors: string[] = [];
  const marker = { attempt_id: attemptId, task_id: side.task_id, repeat_id: side.repeat_id, arm_id: side.arm_id, attempt_no: attemptNo, pid: null as number | null, dispatched_at: now() };
  // Marker first: a crash during materialization is still visible to resume.
  await store.markInflight(marker);

  await copyTree(task.fixture, workspace);
  await mkdir(home, { recursive: true });
  // Give the workspace its own git root so harness project discovery stops here (best effort, recorded).
  const git = await runHosted(["git", "init", "-q"], { cwd: workspace, env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" }, stdin: null }, { first_event_timeout_ms: null, total_timeout_ms: 15_000, max_output_bytes: 64 * 1024 }, {}, makeCancelToken());
  if (git.exit_code !== 0) errors.push("workspace git init was unavailable; the workspace has no git root of its own");
  // Forced-content injects exact bounded content through the prompt and is distinct from native discovery.
  if (arm.arm_id === "treatment" && arm.exposure_mode !== "forced-content") {
    const place = adapter.placement(p.suite.candidate);
    const root = place.root === "workspace" ? workspace : home;
    const dest = place.dir === "." ? root : resolveUnder(root, place.dir);
    await copyTree(p.suite.candidate.files, dest);
  }
  const materialized_at = now();
  const overlay = arm.arm_id === "treatment" ? p.resolved.overlay : null;
  const prompt = overlay === null ? task.prompt : `${overlay}\n\n${task.prompt}`;
  const effectivePromptDigest = sha256Hex(utf8(prompt));
  const env = childEnv(spec, adapter, { workspace, home });
  // Create per-attempt isolation dirs (e.g. CLAUDE_CONFIG_DIR, CODEX_HOME) that live under the attempt home.
  for (const dir of Object.values(adapter.isolation_env({ workspace, home }))) if (isWithin(home, dir)) await mkdir(dir, { recursive: true });
  const invocation = adapter.invocation({ spec, suite_root: p.suite.root, task, arm, candidate: p.suite.candidate, paths: { workspace, home }, repeat_id: side.repeat_id, attempt_id: attemptId, prompt, env, binary: p.binary });
  const parser = adapter.parser(arm, arm.arm_id === "treatment" ? p.suite.candidate : null, workspace);
  const host: HostResult = await runHosted(
    invocation.argv,
    { cwd: invocation.cwd, env: invocation.env, stdin: invocation.stdin },
    { first_event_timeout_ms: spec.limits.first_event_timeout_ms, total_timeout_ms: spec.limits.agent_timeout_ms, max_output_bytes: spec.limits.max_output_bytes },
    {
      onSpawn: (pid) => {
        try {
          store.recordInflightPid({ ...marker, pid });
        } catch (error) {
          errors.push(`pid ${pid} could not be recorded (${error instanceof Error ? error.message : String(error)}); a resume after a crash will require --confirm-stopped`);
        }
      },
      onStdoutLine: (line) => parser.push(line),
    },
    cancel,
  );
  const parsed: ParsedState = parser.state();
  const traceText = `# private raw capture for ${attemptId}; never exported\n## stdout\n${host.stdout}\n## stderr\n${host.stderr}\n`;
  await store.writePrivate("traces", attemptId, traceText);

  let status: AttemptStatus;
  let reason: string;
  let retryQualified = false;
  let stopReason: string | null = null;
  let grade: AttemptRecord["grade"] = null;
  let graderTerminal: string | null = null;
  let graderCleanupPending = false;

  if (host.cleanup === "cleanup_pending") {
    status = "cancelled";
    reason = "owned process tree exit could not be confirmed (cleanup pending)";
    stopReason = "cleanup pending: resolve the leftover process before resuming";
  } else if (host.termination === "spawn_error" || invocation.argv.length === 0) {
    status = "agent_error";
    reason = invocation.argv.length === 0 ? "no invocation could be built (missing replay script or binary)" : `process could not start: ${host.spawn_error ?? "spawn error"}`;
    // Affirmative no-action evidence: the process never started.
    retryQualified = host.pid === null;
  } else if (host.termination === "cancelled") {
    status = "cancelled";
    reason = "cancelled by the operator";
    stopReason = "cancelled";
  } else if (host.termination === "first_event_timeout") {
    status = "agent_error";
    reason = `no first event within ${spec.limits.first_event_timeout_ms} ms`;
  } else if (host.termination === "output_cap") {
    status = "agent_error";
    reason = `output exceeded ${spec.limits.max_output_bytes} bytes; process terminated`;
  } else if (host.termination === "total_timeout") {
    status = parsed.first_event ? "timeout" : "agent_error";
    reason = parsed.first_event ? `agent deadline ${spec.limits.agent_timeout_ms} ms reached after productive startup` : "deadline reached before any event";
  } else if (!parsed.terminal) {
    status = "agent_error";
    reason = `no trustworthy terminal event (exit ${host.exit_code ?? "none"}); final text alone is not completion`;
  } else if (!parsed.terminal.ok) {
    status = "agent_error";
    reason = `harness reported an error result: ${parsed.terminal.reason}`;
  } else {
    if (!(await suiteUnchanged(p.suite))) throw new RunError(["the trusted suite changed during the run; refusing to grade (start a new run)"]);
    const snapshot = await captureSnapshot(workspace, task.dir, task.graders, task.expected, Math.min(task.grader_timeout_ms ?? spec.limits.grader_timeout_ms, spec.limits.grader_timeout_ms), (pid) => {
      graderCleanupPending = true;
      errors.push(`grader process cleanup unconfirmed (pid ${pid ?? "unknown"}); confirm it is gone before resuming`);
    });
    await store.writePrivate("snapshots", attemptId, canonicalJson(snapshot));
    const outcome = evaluateGraders(task.graders, snapshot);
    graderTerminal = now();
    status = outcome.status;
    reason = outcome.status === "grader_error" ? `grader error: ${outcome.errors.join("; ").slice(0, 900)}` : `agent completed; graders ${outcome.status === "pass" ? "passed" : "failed"}`;
    grade = { checks: outcome.checks, score: outcome.score, snapshot_digest: await digestOf(snapshot, nodeSha256) };
    if (outcome.status === "grader_error") errors.push(...outcome.errors.slice(0, 8));
    if (graderCleanupPending) stopReason = "cleanup pending: a trusted grader process could not be confirmed stopped";
  }
  if (parsed.malformed_lines > 0) errors.push(`${parsed.malformed_lines} malformed event line(s) kept in the private trace`);
  if (parsed.unknown_events > 0) errors.push(`${parsed.unknown_events} unknown optional event(s) kept in the private trace`);
  errors.push(...parsed.errors.slice(0, 8));
  if (parsed.action_observed) retryQualified = false;

  const record: AttemptRecord = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    experiment_id: spec.experiment_id,
    experiment_digest: spec.experiment_digest,
    task_id: side.task_id,
    repeat_id: side.repeat_id,
    arm_id: side.arm_id,
    arm_digest: arm.arm_digest,
    attempt_id: attemptId,
    attempt_no: attemptNo,
    order_in_pair: side.order_in_pair,
    cli_reported_version: parsed.cli_version ?? (typeof p.ambient.cli_version === "string" && p.ambient.cli_version !== "unknown" ? p.ambient.cli_version : null),
    requested_model_id: spec.requested_model_id,
    reported_model_id: parsed.reported_model,
    effective_config_digest: p.resolved.effective_config_digest,
    ambient_context_digest: spec.ambient_context_digest,
    base_prompt_digest: task.descriptor.prompt_digest,
    effective_prompt_digest: effectivePromptDigest,
    fixture_digest: task.descriptor.fixture_tree_digest,
    grader_digest: task.descriptor.grader_digest,
    artifact_digest: arm.artifact_digest,
    lifecycle: {
      planned_at,
      materialized_at,
      agent_started_at: host.termination === "spawn_error" ? null : host.started_at,
      first_event_at: host.first_event_at,
      agent_terminal_at: host.ended_at,
      grader_terminal_at: graderTerminal,
      finalized_at: now(),
    },
    status,
    terminal_reason: reason.slice(0, 1000),
    exit_code: host.exit_code,
    grade,
    trace: { digest: sha256Hex(utf8(traceText)), bytes: host.raw_bytes, truncated: host.truncated },
    exposure: parsed.exposure,
    usage: parsed.usage,
    cost: parsed.cost,
    turns: parsed.turns,
    duration_ms: host.duration_ms,
    cleanup: graderCleanupPending ? "cleanup_pending" : host.cleanup,
    retry_qualified: status === "agent_error" && retryQualified,
    errors: errors.map((e) => e.slice(0, 2000)).slice(0, 32),
    attestation: spec.harness_id === "replay" ? "replay-synthetic" : "runner",
  };
  await store.writeAttempt(record);
  return { record, stopReason };
}

interface Budget {
  usd: number;
  tokens: number;
  attempts: number;
}

interface Spent extends Budget {
  /** Executed attempts whose USD or token usage is unknown. */
  unknown_usd: number;
  unknown_tokens: number;
}

/** Known spend; unknown-cost attempts are charged the pinned per-side estimate so a cap cannot be bypassed. */
function spent(attempts: AttemptRecord[], estimate: number | null): Spent {
  let usd = 0;
  let tokens = 0;
  let unknownUsd = 0;
  let unknownTokens = 0;
  for (const a of attempts) {
    // Affirmative no-start evidence (process never started): nothing was spent.
    if (a.lifecycle.agent_started_at === null && (a.retry_qualified || a.status === "cancelled")) continue;
    if (a.cost.usd === null) {
      unknownUsd += 1;
      usd += estimate ?? 0;
    } else usd += a.cost.usd;
    if (a.usage.input_tokens === null || a.usage.output_tokens === null) unknownTokens += 1;
    tokens += (a.usage.input_tokens ?? 0) + (a.usage.output_tokens ?? 0);
  }
  return { usd, tokens, attempts: attempts.length, unknown_usd: unknownUsd, unknown_tokens: unknownTokens };
}

/** Returns a stop reason if a known cap forbids starting one more side (stop-new-work; overshoot possible in flight). */
function capStop(spec: ExperimentSpec, file: ExperimentFile, used: Spent, sidesAhead: number, cancel: CancelToken): string | null {
  if (cancel.cancelled) return "cancelled";
  if (used.attempts >= spec.limits.max_attempts) return `attempt cap ${spec.limits.max_attempts} reached`;
  if (spec.limits.run_deadline && Date.now() >= Date.parse(spec.limits.run_deadline)) return "run deadline reached";
  if (spec.limits.max_tokens !== null && used.unknown_tokens > 0) return `token cap is set but usage is unknown for ${used.unknown_tokens} executed attempt(s); the cap cannot be enforced, so new work stops`;
  if (spec.limits.max_tokens !== null && used.tokens >= spec.limits.max_tokens) return `token cap ${spec.limits.max_tokens} reached (known usage)`;
  if (spec.limits.max_usd !== null && spec.harness_id !== "replay") {
    const est = file.estimate_usd_per_side;
    if (est === null) return "max_usd is set but no pinned per-side estimate exists; paid dispatch refused";
    if (used.usd + est * sidesAhead > spec.limits.max_usd) {
      return `USD cap ${spec.limits.max_usd} would be exceeded by the estimate (${used.unknown_usd} unknown-cost attempt(s) charged at the pinned estimate)`;
    }
  }
  return null;
}

/** Budget inputs pinned in budget.json at run start (the estimate is not part of the experiment digest). */
function budgetPin(p: Prepared): Record<string, unknown> {
  const l = p.resolved.spec.limits;
  return { estimate_usd_per_side: p.file.estimate_usd_per_side, max_usd: l.max_usd, max_tokens: l.max_tokens, max_attempts: l.max_attempts, enforcement: l.enforcement };
}

function nextEdition(prev: LedgerEdition, prevDigest: string, kind: LedgerEdition["kind"], sides: PlanSide[], note: string): LedgerEdition {
  return { ...prev, edition: prev.edition + 1, kind, predecessor_digest: prevDigest, created_at: now(), sides, note };
}

export interface RunOutcome {
  runDir: string;
  summary: RunSummary | null;
  stopReason: string | null;
}

function outputRootFor(opts: RunOptions, p: Prepared, experimentDir: string): string {
  const root = opts.outputRoot ?? p.file.output_root ?? process.env.S20_OUTPUT_ROOT ?? null;
  if (!root) throw new RunError(["Set an output root (--out, output_root in the experiment file, or S20_OUTPUT_ROOT). Private run output stays outside the product repo."]);
  const abs = resolve(experimentDir, root);
  const repo = insideGitWorkTree(abs);
  if (repo) throw new RunError([`output root ${abs} is inside the git work tree ${repo}; agent workspaces must be outside existing repositories`]);
  if (isWithin(p.suite.root, abs)) throw new RunError(["output root must not be inside the trusted suite"]);
  return abs;
}

export async function executeRun(opts: RunOptions): Promise<RunOutcome | { dryRun: string }> {
  const log = opts.log ?? (() => undefined);
  const cancel = opts.cancel ?? makeCancelToken();
  const p = await prepare(opts.experimentPath, opts.dryRun === true);
  if (opts.dryRun) return { dryRun: dryRunReport(p) };
  const { spec } = p.resolved;
  const experimentDir = resolve(opts.experimentPath, "..");
  const root = outputRootFor(opts, p, experimentDir);
  const runId = opts.runId ?? `${spec.experiment_id}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}`;
  const store = new RunStore(resolve(root, runId));

  if (opts.resume && !existsSync(store.dir)) throw new RunError([`${store.dir} does not exist; nothing to resume`]);
  if (!opts.resume && existsSync(store.dir)) throw new RunError([`${store.dir} already exists; use --resume or a new run id`]);
  if (!opts.resume) await mkdir(store.dir, { recursive: true });
  await store.lock();
  let ledger: LedgerEdition;
  let ledgerDigest: string;
  let stopReason: string | null = null;
  try {
    if (opts.resume) {
      const pinned = await store.readBudget();
      if (pinned !== null && canonicalJson(pinned) !== canonicalJson(budgetPin(p))) {
        throw new RunError(["budget inputs (estimate_usd_per_side or caps) differ from those pinned at run start; changed configuration requires a new run"]);
      }
      const recovered = await recover(store, p, runId, opts.confirmStopped ?? []);
      ledger = recovered.ledger;
      ledgerDigest = recovered.digest;
    } else {
      await store.writeSpec(spec);
      await store.writeBudget(budgetPin(p));
      ledger = initialLedger(spec, runId, now());
      ledgerDigest = await store.writeLedger(ledger);
    }
    const attempts = await store.readAttempts();
    const sides = ledger.sides.map((s) => ({ ...s, attempt_ids: [...s.attempt_ids] }));
    const order = [...sides].sort((a, b) => a.order_index - b.order_index);
    for (let i = 0; i < order.length && !stopReason; i += 1) {
      const side = order[i]!;
      if (side.state !== "planned") continue;
      // Admission for a fresh block estimates both sides; each side is still rechecked before dispatch.
      const partner = sides.find((s) => s.task_id === side.task_id && s.repeat_id === side.repeat_id && s.arm_id !== side.arm_id);
      const ahead = side.order_in_pair === 0 && partner?.state === "planned" ? 2 : 1;
      const stop = capStop(spec, p.file, spent(attempts, p.file.estimate_usd_per_side), ahead, cancel);
      if (stop) {
        stopReason = stop;
        break;
      }
      let attemptNo = side.attempt_ids.length + 1;
      for (;;) {
        log(`dispatch ${attemptIdFor(side, attemptNo)}`);
        const outcome = await runAttempt(p, store, runId, side, attemptNo, cancel);
        attempts.push(outcome.record);
        side.attempt_ids.push(outcome.record.attempt_id);
        side.state = "attempted";
        side.selected_attempt_id = outcome.record.attempt_id;
        log(`  ${outcome.record.status}: ${outcome.record.terminal_reason}`);
        const canRetry = outcome.record.retry_qualified && attemptNo <= spec.retry_policy.startup_retries && !outcome.stopReason && !capStop(spec, p.file, spent(attempts, p.file.estimate_usd_per_side), 1, cancel);
        const edition = nextEdition(ledger, ledgerDigest, "plan", sides.map((s) => ({ ...s, attempt_ids: [...s.attempt_ids] })), `after ${outcome.record.attempt_id}`);
        ledgerDigest = await store.writeLedger(edition);
        ledger = edition;
        if (outcome.stopReason) stopReason = outcome.stopReason;
        if (!canRetry) break;
        attemptNo += 1;
      }
    }

    const cleanupPending = attempts.some((a) => a.cleanup === "cleanup_pending" && !store.cleanupEstablished(a.attempt_id));
    const canFinalize = !cleanupPending && stopReason !== "cancelled";
    if (canFinalize) {
      const finalSides = ledger.sides.map((s) => (s.state === "planned" ? { ...s, state: "not_started" as const } : s));
      const final = nextEdition(ledger, ledgerDigest, "final", finalSides, stopReason ? `finalized early: ${stopReason}` : "all planned sides dispatched");
      ledgerDigest = await store.writeLedger(final);
      ledger = final;
    }
    await store.regenerateIndex(attempts);
    if (ledger.kind !== "final") return { runDir: store.dir, summary: null, stopReason: stopReason ?? "interrupted" };
    const built = await buildEnvelope({ spec, ledger, attempts }, nodeSha256, { kind: "private", runtime: { os: String(p.ambient.os), node: String(p.ambient.node), cli: String(p.ambient.cli_version) } });
    if (!built.ok) throw new RunError(built.errors);
    await store.writeText("manifest.private.json", canonicalJson(built.value.envelope.manifest));
    await store.writeText("bundle.private.json", envelopeText(built.value.envelope));
    return { runDir: store.dir, summary: built.value.summary, stopReason };
  } finally {
    await store.unlock();
  }
}

/** POSIX: true if no process remains in group `pgid`, false if some do; null where groups cannot be probed (Windows). */
function processGroupGone(pgid: number): boolean | null {
  if (process.platform === "win32") return null;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    return code === "EPERM" ? false : null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Resume: pins must match exactly; interrupted evidence is preserved; a recovery edition references its
 * predecessor. Attempts dispatched but never finalized are recorded as cancelled (unknown action history, no
 * automatic retry). A still-running owned process blocks resume (cleanup first).
 */
async function recover(store: RunStore, p: Prepared, runId: string, confirmStopped: string[]): Promise<{ ledger: LedgerEdition; digest: string }> {
  const stored = await store.readSpec();
  const spec = p.resolved.spec;
  const mismatches: string[] = [];
  if (stored.experiment_digest !== spec.experiment_digest) mismatches.push("experiment digest changed (suite, tasks, graders, model, limits or runtime pins)");
  if (stored.arms[0].arm_digest !== spec.arms[0].arm_digest || stored.arms[1].arm_digest !== spec.arms[1].arm_digest) mismatches.push("arm digests changed");
  if (stored.suite.digest !== p.suite.digest) mismatches.push("suite digest changed");
  if (mismatches.length) throw new RunError([...mismatches, "changed configuration requires a new run"]);
  const latest = await store.latestLedger();
  if (!latest) throw new RunError(["no ledger edition found"]);
  if (latest.ledger.kind === "final") throw new RunError(["this run is already final"]);
  if (latest.ledger.run_id !== runId) throw new RunError(["ledger run id does not match"]);

  const attempts = await store.readAttempts();
  const known = new Set(attempts.map((a) => a.attempt_id));
  const inflight = await store.readInflight();
  const confirmed = new Set(confirmStopped);
  // Establish cleanup first: a live (or unidentifiable) owned process blocks resume.
  const evidence = new Map<string, string>();
  // A dead leader pid is not proof: a descendant can outlive it (that is exactly how cleanup_pending arises).
  // POSIX children are spawned detached, so the pid is also the process-group id and the whole group can be probed.
  // Windows has no equivalent probe here, so the operator must confirm.
  const check = (attemptId: string, pid: number | null, what: string) => {
    const confirmHint = `confirm nothing for it is still running (including child processes), then resume with --confirm-stopped ${attemptId}`;
    if (confirmed.has(attemptId)) {
      evidence.set(
        attemptId,
        pid !== null && pidAlive(pid)
          ? `pid ${pid} was alive at resume; the operator confirmed it is not the owned process tree (--confirm-stopped)`
          : "the operator confirmed no process for this attempt is running (--confirm-stopped)",
      );
      return;
    }
    if (pid === null) throw new RunError([`${what} ${attemptId}: no process id was recorded, so it cannot be checked; ${confirmHint}`]);
    if (pidAlive(pid)) throw new RunError([`${what} ${attemptId}: process ${pid} may still be running; stop it and its children, or if the pid was reused by an unrelated process, ${confirmHint}`]);
    const group = processGroupGone(pid);
    if (group === true) evidence.set(attemptId, `process group ${pid} has no members at resume (POSIX group probe)`);
    else if (group === false) throw new RunError([`${what} ${attemptId}: process group ${pid} still has members; stop them before resuming`]);
    else throw new RunError([`${what} ${attemptId}: the leader ${pid} exited, but descendants cannot be verified on this OS; ${confirmHint}`]);
  };
  for (const m of inflight) if (!known.has(m.attempt_id)) check(m.attempt_id, m.pid, "interrupted attempt");
  for (const a of attempts) {
    if (a.cleanup !== "cleanup_pending" || store.cleanupEstablished(a.attempt_id)) continue;
    const m = inflight.find((x) => x.attempt_id === a.attempt_id);
    const graderLeftover = a.errors.some((e) => e.startsWith("grader process cleanup unconfirmed"));
    check(a.attempt_id, graderLeftover ? null : (m?.pid ?? null), graderLeftover ? "cleanup-pending grader for attempt" : "cleanup-pending attempt");
  }

  const sides = latest.ledger.sides.map((s) => ({ ...s, attempt_ids: [...s.attempt_ids] }));
  const notes: string[] = [];
  for (const m of inflight) {
    if (known.has(m.attempt_id)) {
      const side = sides.find((s) => s.attempt_ids.includes(m.attempt_id));
      if (!side) {
        const target = sides.find((s) => s.task_id === m.task_id && s.repeat_id === m.repeat_id && s.arm_id === m.arm_id);
        if (target) {
          target.attempt_ids.push(m.attempt_id);
          target.state = "attempted";
          target.selected_attempt_id = m.attempt_id;
          notes.push(`adopted finalized ${m.attempt_id} written after the last edition`);
        }
      }
      continue;
    }
    const target = sides.find((s) => s.task_id === m.task_id && s.repeat_id === m.repeat_id && s.arm_id === m.arm_id);
    if (!target) continue;
    const record: AttemptRecord = interruptedRecord(spec, p, runId, target, m.attempt_id, m.attempt_no, m.dispatched_at, evidence.get(m.attempt_id) ?? "unverified");
    await store.writeAttempt(record);
    target.attempt_ids.push(m.attempt_id);
    target.state = "attempted";
    target.selected_attempt_id = m.attempt_id;
    notes.push(`recorded interrupted ${m.attempt_id} as cancelled`);
  }
  const editionNo = latest.ledger.edition + 1;
  for (const a of attempts.filter((x) => x.cleanup === "cleanup_pending" && !store.cleanupEstablished(x.attempt_id))) {
    const why = evidence.get(a.attempt_id) ?? "unverified";
    await store.markCleanupEstablished(a.attempt_id, editionNo, why);
    notes.push(`cleanup for ${a.attempt_id} established: ${why}`);
  }
  const edition: LedgerEdition = { ...latest.ledger, edition: editionNo, kind: "recovery", predecessor_digest: latest.digest, created_at: now(), sides, note: notes.join("; ") || "resumed with no interrupted attempts" };
  return { ledger: edition, digest: await store.writeLedger(edition) };
}

function interruptedRecord(spec: ExperimentSpec, p: Prepared, runId: string, side: PlanSide, attemptId: string, attemptNo: number, dispatchedAt: string, cleanupEvidence: string): AttemptRecord {
  const task = p.suite.tasks.find((t) => t.descriptor.task_id === side.task_id)!;
  const arm = side.arm_id === "baseline" ? spec.arms[0] : spec.arms[1];
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    experiment_id: spec.experiment_id,
    experiment_digest: spec.experiment_digest,
    task_id: side.task_id,
    repeat_id: side.repeat_id,
    arm_id: side.arm_id,
    arm_digest: arm.arm_digest,
    attempt_id: attemptId,
    attempt_no: attemptNo,
    order_in_pair: side.order_in_pair,
    cli_reported_version: null,
    requested_model_id: spec.requested_model_id,
    reported_model_id: null,
    effective_config_digest: p.resolved.effective_config_digest,
    ambient_context_digest: spec.ambient_context_digest,
    base_prompt_digest: task.descriptor.prompt_digest,
    effective_prompt_digest: task.descriptor.prompt_digest,
    fixture_digest: task.descriptor.fixture_tree_digest,
    grader_digest: task.descriptor.grader_digest,
    artifact_digest: arm.artifact_digest,
    lifecycle: { planned_at: dispatchedAt, materialized_at: null, agent_started_at: null, first_event_at: null, agent_terminal_at: null, grader_terminal_at: null, finalized_at: now() },
    status: "cancelled",
    terminal_reason: "interrupted: the runner stopped before this attempt was finalized; action history unknown; partial evidence preserved",
    exit_code: null,
    grade: null,
    trace: { digest: null, bytes: null, truncated: false },
    exposure: { status: "unknown", mechanism: "none", artifact_digest: null, event_ref: null },
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, semantics: null },
    cost: { usd: null, source: "unknown", pricing_snapshot: null },
    turns: null,
    duration_ms: null,
    cleanup: "confirmed",
    retry_qualified: false,
    errors: [cleanupEvidence],
    attestation: spec.harness_id === "replay" ? "replay-synthetic" : "runner",
  };
}
