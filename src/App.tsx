import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { RunRecords } from "../supabase/functions/publish-run/domain/contracts.ts";
import { importLegacy, isLegacyPayload, type LegacyView } from "../supabase/functions/publish-run/domain/legacy.ts";
import { buildEnvelope, importEnvelopeText, importEnvelopeValue, type RunManifest } from "../supabase/functions/publish-run/domain/manifest.ts";
import { buildSampleRecords } from "../supabase/functions/publish-run/domain/sample.ts";
import type { RunSummary } from "../supabase/functions/publish-run/domain/summary.ts";
import { LIMITS, utf8Length } from "../supabase/functions/publish-run/domain/limits.ts";
import { loadPublicSnapshot } from "./lib/api.ts";
import { browserSha256 } from "./lib/hash.ts";
import { getSupabase } from "./lib/supabase.ts";
import { ExportPanel } from "./ui/export-panel.tsx";
import { LegacyReport } from "./ui/legacy-report.tsx";
import { PersistencePanel } from "./ui/persistence-panel.tsx";
import { RunReport } from "./ui/run-report.tsx";

export interface LoadedRun {
  source: "sample" | "import";
  records: RunRecords;
  manifest: RunManifest;
  summary: RunSummary;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicationIdFromHash(): string | null {
  const match = /^#pub=([0-9a-f-]{36})$/i.exec(window.location.hash);
  return match?.[1] && UUID.test(match[1]) ? match[1] : null;
}

const STAGE_TEXT: Record<string, string> = {
  size: "Too large",
  json: "Not valid JSON",
  schema: "Schema error",
  integrity: "Integrity check failed",
  "file-json": "A bundle file is not valid JSON",
  records: "Record validation failed",
};

export function App() {
  const client = useMemo(() => getSupabase(), []);
  const [run, setRun] = useState<LoadedRun | null>(null);
  const [legacy, setLegacy] = useState<LegacyView | null>(null);
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<{ id: string; records: RunRecords; manifest: RunManifest; summary: RunSummary } | null>(null);
  const [snapshotNote, setSnapshotNote] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      const id = publicationIdFromHash();
      setSnapshot(null);
      if (!id) {
        setSnapshotNote("");
        return;
      }
      if (!client) {
        setSnapshotNote("A snapshot link needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before it can load.");
        return;
      }
      setSnapshotNote("Loading snapshot.");
      try {
        const row = await loadPublicSnapshot(client, id);
        if (!active) return;
        if (!row) {
          setSnapshotNote("That snapshot is not public, was revoked, or does not exist.");
          return;
        }
        const verified = await importEnvelopeText(row.artifact, browserSha256);
        if (!active) return;
        if (!verified.ok || verified.value.manifest.content_digest !== row.contentDigest) {
          setSnapshotNote("The snapshot bytes did not verify against their manifest; it is not shown.");
          return;
        }
        setSnapshot({ id, records: verified.value.records, manifest: verified.value.manifest, summary: verified.value.summary });
        setSnapshotNote(`Public snapshot ${id}, created ${row.createdAt}. Sanitized bytes verified and summary recomputed in this browser.`);
      } catch (error) {
        if (active) setSnapshotNote(error instanceof Error ? error.message : "Could not load that snapshot.");
      }
    };
    void load();
    const onHash = () => void load();
    window.addEventListener("hashchange", onHash);
    return () => {
      active = false;
      window.removeEventListener("hashchange", onHash);
    };
  }, [client]);

  function fail(heading: string, list: string[]) {
    setRun(null);
    setLegacy(null);
    setStatus(heading);
    setErrors(list.slice(0, 50));
  }

  async function onSample() {
    setBusy(true);
    try {
      const records = await buildSampleRecords(browserSha256);
      const built = await buildEnvelope(records, browserSha256, { kind: "private", runtime: { origin: "in-browser synthetic sample" } });
      if (!built.ok) {
        fail("The sample did not build.", built.errors);
        return;
      }
      setLegacy(null);
      setErrors([]);
      setRun({ source: "sample", records, manifest: built.value.envelope.manifest, summary: built.value.summary });
      setStatus("Loaded the synthetic sample. These records are fabricated for demonstration; no agent ran.");
    } catch (error) {
      fail("The sample did not build.", [error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function importText(text: string) {
    if (utf8Length(text) > LIMITS.envelopeBytes) {
      fail(`${STAGE_TEXT.size}: the bundle exceeds ${LIMITS.envelopeBytes.toLocaleString("en-US")} bytes.`, []);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(`${STAGE_TEXT.json}: the text could not be parsed.`, []);
      return;
    }
    if (isLegacyPayload(parsed)) {
      const view = importLegacy(parsed);
      if (!view.ok) {
        fail(`${STAGE_TEXT.schema}: the legacy record did not validate.`, view.errors);
        return;
      }
      setRun(null);
      setErrors([]);
      setLegacy(view.value);
      setStatus("Imported a legacy v1 record. Pairing is unverified.");
      return;
    }
    const result = await importEnvelopeValue(parsed, browserSha256);
    if (!result.ok) {
      fail(`${STAGE_TEXT[result.stage ?? "schema"] ?? "Import failed"}.`, result.errors);
      return;
    }
    setLegacy(null);
    setErrors([]);
    setRun({ source: "import", records: result.value.records, manifest: result.value.manifest, summary: result.value.summary });
    setStatus("Imported and verified the bundle. The summary was recomputed in this browser from the verified records.");
  }

  async function onPaste() {
    setBusy(true);
    try {
      await importText(paste);
    } catch (error) {
      fail("Import failed.", [error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > LIMITS.envelopeBytes) {
      fail(`${STAGE_TEXT.size}: ${file.name} exceeds ${LIMITS.envelopeBytes.toLocaleString("en-US")} bytes.`, []);
      return;
    }
    setBusy(true);
    try {
      await importText(await file.text());
    } catch (error) {
      fail("Import failed.", [error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <header>
        <p className="kicker">S20 · skill eval harness</p>
        <h1>Does this instruction file change a coding agent's results?</h1>
        <p>
          Paired comparison of a no-artifact baseline against one SKILL.md, AGENTS.md or CLAUDE.md treatment on your own tasks, with
          task-weighted effects, honest uncertainty, operational failures, exposure evidence and cost coverage. This page never runs an agent
          or calls a model; runs come from the separate local runner.
        </p>
      </header>

      {snapshotNote ? (
        <p className="banner" role="status" aria-live="polite">
          {snapshotNote}
        </p>
      ) : null}
      {snapshot ? <RunReport key={`snapshot-${snapshot.manifest.content_digest}`} idPrefix="snapshot" summary={snapshot.summary} records={snapshot.records} manifest={snapshot.manifest} /> : null}

      <section aria-labelledby="load-title">
        <h2 id="load-title">Load records</h2>
        <div className="row">
          <button type="button" onClick={onSample} disabled={busy}>
            Load synthetic sample
          </button>
          <button type="button" className="secondary" onClick={() => fileInput.current?.click()} disabled={busy}>
            Import bundle file
          </button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={onFile} />
        </div>
        <label htmlFor="paste">Or paste a bundle (JSON envelope with manifest and files, or a legacy v1 record)</label>
        <textarea id="paste" value={paste} onChange={(event) => setPaste(event.target.value)} spellCheck={false} placeholder='{"manifest":{...},"files":{...}}' />
        <button type="button" className="secondary" onClick={onPaste} disabled={busy || paste.trim() === ""}>
          Import pasted JSON
        </button>
        <p role="status" aria-live="polite" className={status ? "banner" : undefined}>
          {status}
        </p>
        {errors.length > 0 ? (
          <ul className="warnings" aria-label="Import errors">
            {errors.map((error, i) => (
              <li key={`${i}-${error}`}>{error}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {run ? <RunReport key={`report-${run.manifest.content_digest}`} summary={run.summary} records={run.records} manifest={run.source === "import" ? run.manifest : null} /> : null}
      {legacy ? <LegacyReport view={legacy} /> : null}
      {run ? <ExportPanel key={`export-${run.manifest.content_digest}`} records={run.records} manifest={run.manifest} /> : null}

      <PersistencePanel client={client} run={run} />

      <footer>
        <p>Dirty Mode construction: source written, not yet built, tested or run. Statistics are computed in this browser from loaded records.</p>
      </footer>
    </div>
  );
}
