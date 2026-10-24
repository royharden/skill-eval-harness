// s20 runner CLI (PLAN.md §7): validate, preflight, run --dry-run, run, run --resume, report, export.
// No static-publish command: export writes a private staging bundle, which is not publication.

import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { canonicalJson } from "../supabase/functions/publish-run/domain/canonical.ts";
import { buildEnvelope, envelopeText, recordsEditionDigest } from "../supabase/functions/publish-run/domain/manifest.ts";
import { DEFAULT_SANITIZE, sanitizeForExport } from "../supabase/functions/publish-run/domain/sanitize.ts";
import { analyze, type RunSummary } from "../supabase/functions/publish-run/domain/summary.ts";
import { parseRunRecords } from "../supabase/functions/publish-run/domain/validate.ts";
import { insideGitWorkTree, nodeSha256, writeImmutable } from "./fsutil.ts";
import { makeCancelToken } from "./process-host.ts";
import { replayAgentMain } from "./replay-agent.ts";
import { dryRunReport, executeRun, prepare, RunError } from "./run.ts";
import { RunStore } from "./store.ts";
import { loadSuite, SuiteError } from "./suite.ts";
import { validateSuite } from "./validate-suite.ts";
import { ExperimentError } from "./experiment.ts";

const USAGE = `s20 runner
  validate <suite-dir>                        no-spend oracle/null check of every task
  preflight <experiment.yaml>                 resolve binary, version, pins and capabilities
  run <experiment.yaml> --dry-run             print resolved hashes, limits, capabilities and schedule
  run <experiment.yaml> [--out DIR] [--run-id ID]
  run <experiment.yaml> --resume --run-id ID [--out DIR]
  report <run-dir>                            recompute and print the summary
  export <run-dir> [--keep-labels] [--keep-check-details] [--out DIR]
                                              write a sanitized private staging bundle (not publication)`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : null;
}

const pct = (v: number | null) => (v === null ? "unavailable" : `${(v * 100).toFixed(1)}%`);
const pp = (v: number | null) => (v === null ? "unavailable" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)} pp`);

export function formatSummary(s: RunSummary): string {
  const c = s.counts;
  const lines = [
    `run ${s.run_id}  experiment ${s.experiment_id}  harness ${s.harness_id}  attestation ${s.attestations.join(", ")}`,
    `sides planned ${c.planned_sides}, attempted ${c.attempted_sides}, not started ${c.not_started_sides}; attempts ${c.finalized_attempts}`,
    `complete pairs ${c.complete_pairs} across ${c.contributing_tasks}/${c.tasks} tasks, ${c.repeats} repeats; incomplete blocks ${c.incomplete_blocks}; excluded ${c.excluded_attempts}`,
    `pairs: n11 ${s.table.n11}, n00 ${s.table.n00}, helpful ${s.table.n01}, harmful ${s.table.n10}`,
    `observed effect (task-weighted): ${pp(s.effect.primary_task_mean)} -> ${s.effect.direction}; pooled descriptive ${pp(s.effect.pooled_descriptive)}`,
    `task-cluster bootstrap 95%: ${s.uncertainty.low === null ? "unavailable" : `${pp(s.uncertainty.low)} to ${pp(s.uncertainty.high)}`} (${s.uncertainty.status}) ${s.uncertainty.note}`,
    `McNemar repeat 0: ${s.mcnemar_repeat0.pairs} pairs, discordant ${s.mcnemar_repeat0.discordant}, p ${s.mcnemar_repeat0.p_value === null ? "undefined" : s.mcnemar_repeat0.p_value.toPrecision(4)}`,
  ];
  for (const arm of [s.arms.baseline, s.arms.treatment]) {
    lines.push(
      `${arm.arm_id}: pass ${arm.passes}/${arm.eligible_denominator} (${pct(arm.pass_rate)}), operational ${pct(arm.operational_success)}, known USD ${arm.cost.known_total.toFixed(4)} (${arm.cost.known_attempts}/${arm.cost.executed_attempts} known)` +
        `, USD/pass ${arm.cost.usd_per_passing_attempt === null ? `— (${arm.cost.ratio_note})` : arm.cost.usd_per_passing_attempt.toFixed(4)}`,
    );
  }
  lines.push("No winner label is computed. Results apply only to this suite and recorded environment.");
  return lines.join("\n");
}

async function loadRun(runDir: string) {
  const store = new RunStore(resolve(runDir));
  const spec = await store.readSpec();
  const latest = await store.latestLedger();
  if (!latest) throw new RunError(["no ledger edition found"]);
  const attempts = await store.readAttempts();
  const records = parseRunRecords(spec, latest.ledger, attempts);
  if (!records.ok) throw new RunError(records.errors);
  return { store, records: records.value };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const err = (s: string) => process.stderr.write(`${s}\n`);
  try {
    switch (command) {
      case "__replay-agent":
        return await replayAgentMain(args[0] ?? "", args[1] ?? "");
      case "validate": {
        const suite = await loadSuite(args[0] ?? ".");
        const result = await validateSuite(suite);
        for (const t of result.tasks) out(`${t.ok ? "ok  " : "FAIL"} ${t.task_id}: oracle ${t.oracle}, untouched ${t.untouched}${t.reasons.length ? ` — ${t.reasons.join("; ")}` : ""}`);
        out(result.ok ? `suite ${suite.suite_id} v${suite.version} valid (digest ${suite.digest})` : "suite INVALID: fix the tasks; corrections create a new suite digest");
        return result.ok ? 0 : 1;
      }
      case "preflight": {
        const p = await prepare(args[0] ?? "", false);
        out(dryRunReport(p).split("\nschedule")[0]!.replace("DRY RUN — no native or model process is started.", "PREFLIGHT — version probe only; no model run."));
        out(`binary: ${p.binary ? basename(p.binary) : "(unset)"}; value of credentials and env vars are never printed`);
        return 0;
      }
      case "run": {
        const cancel = makeCancelToken();
        const onSigint = () => {
          err("cancel requested: terminating the current attempt and stopping new work");
          cancel.cancel();
        };
        process.once("SIGINT", onSigint);
        try {
          const result = await executeRun({
            experimentPath: args[0] ?? "",
            outputRoot: option(args, "--out"),
            runId: option(args, "--run-id"),
            dryRun: flag(args, "--dry-run"),
            resume: flag(args, "--resume"),
            cancel,
            log: out,
          });
          if ("dryRun" in result) {
            out(result.dryRun);
            return 0;
          }
          out(`run directory: ${result.runDir}`);
          if (result.stopReason) out(`stopped: ${result.stopReason}`);
          if (result.summary) out(formatSummary(result.summary));
          else out("run is not final; resume with --resume after resolving the stop reason");
          return result.summary ? 0 : 2;
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      }
      case "report": {
        const { records } = await loadRun(args[0] ?? "");
        const analysed = analyze(records, await recordsEditionDigest(records, nodeSha256));
        if (!analysed.ok) throw new RunError(analysed.errors);
        if (records.ledger.kind !== "final") out(`note: ledger edition ${records.ledger.edition} is ${records.ledger.kind}, not final`);
        out(formatSummary(analysed.value.summary));
        return 0;
      }
      case "export": {
        const { store, records } = await loadRun(args[0] ?? "");
        if (records.ledger.kind !== "final") throw new RunError(["export needs a final ledger edition"]);
        const priv = await buildEnvelope(records, nodeSha256, { kind: "private" });
        if (!priv.ok) throw new RunError(priv.errors);
        const sanitized = await sanitizeForExport(records, priv.value.envelope.manifest, nodeSha256, { ...DEFAULT_SANITIZE, keepTaskLabels: flag(args, "--keep-labels"), keepCheckDetails: flag(args, "--keep-check-details") });
        if (!sanitized.ok) throw new RunError(sanitized.errors);
        const root = option(args, "--out") ?? resolve(dirname(store.dir), "exports");
        const target = resolve(root, records.ledger.run_id);
        const repo = insideGitWorkTree(target);
        if (repo) throw new RunError([`export target ${target} is inside the git work tree ${repo}; exports stage outside the product repo`]);
        const text = envelopeText(sanitized.value.envelope);
        const file = resolve(target, "bundle.sanitized.json");
        if (existsSync(file)) throw new RunError([`${file} already exists; exports are never overwritten`]);
        await writeImmutable(resolve(target, "manifest.private.json"), canonicalJson(priv.value.envelope.manifest));
        await writeImmutable(file, text);
        out(`sanitized bundle: ${file} (${Buffer.byteLength(text)} bytes). Review the exact bytes before sharing; export is not publication.`);
        return 0;
      }
      default:
        out(USAGE);
        return command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof SuiteError || error instanceof RunError || error instanceof ExperimentError) {
      for (const r of error.reasons) err(`error: ${r}`);
    } else err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (/cli\.(m?js|ts)$/.test(invoked)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
