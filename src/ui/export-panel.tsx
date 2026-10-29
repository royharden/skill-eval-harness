import { useState } from "react";
import type { RunRecords } from "../../supabase/functions/publish-run/domain/contracts.ts";
import { utf8Length } from "../../supabase/functions/publish-run/domain/limits.ts";
import { envelopeText, type RunManifest } from "../../supabase/functions/publish-run/domain/manifest.ts";
import { DEFAULT_SANITIZE, sanitizeForExport, type SanitizeOptions } from "../../supabase/functions/publish-run/domain/sanitize.ts";
import { downloadText } from "../lib/download.ts";
import { browserSha256 } from "../lib/hash.ts";

/** Sanitized export preview and download. Export is not publication: nothing leaves this browser. */
export function ExportPanel({ records, manifest }: { records: RunRecords; manifest: RunManifest }) {
  const [options, setOptions] = useState<SanitizeOptions>(DEFAULT_SANITIZE);
  const [preview, setPreview] = useState<{ text: string; filename: string } | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function onPreview() {
    setBusy(true);
    setPreview(null);
    try {
      const result = await sanitizeForExport(records, manifest, browserSha256, options);
      if (!result.ok) {
        setStatus(`Export refused: ${result.errors.slice(0, 5).join("; ")}`);
        return;
      }
      const text = envelopeText(result.value.envelope);
      setPreview({ text, filename: `${records.ledger.run_id}.sanitized.json` });
      setStatus(`Preview ready: ${utf8Length(text).toLocaleString("en-US")} bytes (UTF-8). These are the exact bytes the download writes.`);
    } catch (error) {
      setStatus(error instanceof Error ? `Export failed: ${error.message}` : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(key: keyof SanitizeOptions) {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    setPreview(null);
  }

  return (
    <section aria-labelledby="export-title">
      <h2 id="export-title">Sanitized export</h2>
      <p>
        Builds an allowlisted bundle with a sanitized manifest that records the transform, the private manifest digest and withheld inputs.
        Raw traces, private prompts and environment values are never included. Downloading is not publishing.
      </p>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={options.keepTaskLabels} onChange={() => toggle("keepTaskLabels")} />
          Keep task labels (I reviewed them)
        </label>
        <label className="check">
          <input type="checkbox" checked={options.keepCheckDetails} onChange={() => toggle("keepCheckDetails")} />
          Keep check details (I reviewed them)
        </label>
        <label className="check">
          <input type="checkbox" checked={options.keepNotes} onChange={() => toggle("keepNotes")} />
          Keep experiment notes
        </label>
      </div>
      <div className="row">
        <button type="button" onClick={onPreview} disabled={busy}>
          Preview export
        </button>
        <button type="button" className="secondary" disabled={busy || !preview} onClick={() => preview && downloadText(preview.filename, preview.text)}>
          Download previewed bytes
        </button>
      </div>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {preview ? (
        <>
          <label htmlFor="export-preview">Exact export bytes</label>
          <textarea id="export-preview" readOnly value={preview.text} spellCheck={false} />
        </>
      ) : null}
    </section>
  );
}
