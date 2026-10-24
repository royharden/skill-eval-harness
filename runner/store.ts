// Run directory and immutable writer (PLAN.md §5 "Authoritative local files", §8 recovery).
// Layout under <output_root>/<run_id>/:
//   experiment.json, ledger/edition-NNNN.json (append-only), attempts/<attempt_id>.json (immutable),
//   inflight/<attempt_id>.json (dispatch markers), traces/ and snapshots/ (private, never exported),
//   workspaces/<attempt_id>/, homes/<attempt_id>/, records.jsonl (regenerated index), manifest.private.json,
//   bundle.private.json, LOCK.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, digestOf, sortAttempts } from "../supabase/functions/publish-run/domain/canonical.ts";
import type { AttemptRecord, Digest, ExperimentSpec, LedgerEdition } from "../supabase/functions/publish-run/domain/contracts.ts";
import { parseAttempt, parseLedger, parseSpec } from "../supabase/functions/publish-run/domain/validate.ts";
import { FsBoundError, nodeSha256, writeAtomic, writeImmutable, writeNew } from "./fsutil.ts";

export interface InflightMarker {
  attempt_id: string;
  task_id: string;
  repeat_id: number;
  arm_id: string;
  attempt_no: number;
  pid: number | null;
  dispatched_at: string;
}

export class RunStore {
  constructor(public readonly dir: string) {}

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  workspace(attemptId: string): string {
    return this.path("workspaces", attemptId);
  }

  home(attemptId: string): string {
    return this.path("homes", attemptId);
  }

  async lock(): Promise<void> {
    try {
      await writeNew(this.path("LOCK"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch {
      throw new FsBoundError(`${this.path("LOCK")} exists: another runner may be using this run (remove it only after confirming no runner process is alive)`);
    }
  }

  async unlock(): Promise<void> {
    await rm(this.path("LOCK"), { force: true });
  }

  async writeSpec(spec: ExperimentSpec): Promise<void> {
    await writeImmutable(this.path("experiment.json"), canonicalJson(spec));
  }

  async readSpec(): Promise<ExperimentSpec> {
    const parsed = parseSpec(JSON.parse(await readFile(this.path("experiment.json"), "utf8")));
    if (!parsed.ok) throw new FsBoundError(`experiment.json is invalid: ${parsed.errors.join("; ")}`);
    return parsed.value;
  }

  async writeLedger(ledger: LedgerEdition): Promise<Digest> {
    await writeImmutable(this.path("ledger", `edition-${String(ledger.edition).padStart(4, "0")}.json`), canonicalJson(ledger));
    return digestOf(ledger, nodeSha256);
  }

  async latestLedger(): Promise<{ ledger: LedgerEdition; digest: Digest } | null> {
    const dir = this.path("ledger");
    if (!existsSync(dir)) return null;
    const names = (await readdir(dir)).filter((n) => /^edition-\d{4}\.json$/.test(n)).sort();
    const last = names[names.length - 1];
    if (!last) return null;
    const parsed = parseLedger(JSON.parse(await readFile(join(dir, last), "utf8")));
    if (!parsed.ok) throw new FsBoundError(`${last} is invalid: ${parsed.errors.join("; ")}`);
    if (`edition-${String(parsed.value.edition).padStart(4, "0")}.json` !== last) throw new FsBoundError(`${last} does not match its edition number`);
    return { ledger: parsed.value, digest: await digestOf(parsed.value, nodeSha256) };
  }

  async writeAttempt(record: AttemptRecord): Promise<void> {
    const parsed = parseAttempt(record);
    if (!parsed.ok) throw new FsBoundError(`refusing to write an invalid attempt: ${parsed.errors.join("; ")}`);
    await writeImmutable(this.path("attempts", `${record.attempt_id}.json`), canonicalJson(record));
  }

  async readAttempts(): Promise<AttemptRecord[]> {
    const dir = this.path("attempts");
    if (!existsSync(dir)) return [];
    const out: AttemptRecord[] = [];
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
      const parsed = parseAttempt(JSON.parse(await readFile(join(dir, name), "utf8")), name);
      if (!parsed.ok) throw new FsBoundError(`${name} is invalid: ${parsed.errors.join("; ")}`);
      if (`${parsed.value.attempt_id}.json` !== name) throw new FsBoundError(`${name} does not match its attempt_id`);
      out.push(parsed.value);
    }
    return out;
  }

  async markInflight(marker: InflightMarker): Promise<void> {
    await writeImmutable(this.path("inflight", `${marker.attempt_id}.json`), canonicalJson(marker));
  }

  /** Synchronous so the pid is on disk before the runner reads any child output or can crash. */
  recordInflightPid(marker: InflightMarker): void {
    mkdirSync(this.path("inflight"), { recursive: true });
    writeFileSync(this.path("inflight", `${marker.attempt_id}.pid.json`), canonicalJson(marker), { encoding: "utf8", flag: "wx" });
  }

  /** Immutable record that cleanup for a cleanup_pending attempt was established at a recovery edition. */
  async markCleanupEstablished(attemptId: string, edition: number, evidence: string): Promise<void> {
    await writeImmutable(this.path("cleanup", `${attemptId}.json`), canonicalJson({ attempt_id: attemptId, recovery_edition: edition, evidence }));
  }

  cleanupEstablished(attemptId: string): boolean {
    return existsSync(this.path("cleanup", `${attemptId}.json`));
  }

  async readInflight(): Promise<InflightMarker[]> {
    const dir = this.path("inflight");
    if (!existsSync(dir)) return [];
    const byId = new Map<string, InflightMarker>();
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const m = JSON.parse(await readFile(join(dir, name), "utf8")) as InflightMarker;
      const prior = byId.get(m.attempt_id);
      if (!prior || (m.pid !== null && prior.pid === null)) byId.set(m.attempt_id, m);
    }
    return [...byId.values()];
  }

  async writePrivate(kind: "traces" | "snapshots", attemptId: string, text: string): Promise<void> {
    await writeImmutable(this.path(kind, `${attemptId}.${kind === "traces" ? "log" : "json"}`), text);
  }

  async regenerateIndex(attempts: AttemptRecord[]): Promise<void> {
    await writeAtomic(this.path("records.jsonl"), sortAttempts(attempts).map((a) => canonicalJson(a)).join("\n") + "\n");
  }

  async writeText(name: string, text: string): Promise<void> {
    await writeFile(this.path(name), text, "utf8");
  }
}
