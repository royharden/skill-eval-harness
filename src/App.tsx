import type { Session } from "@supabase/supabase-js";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fixturePayload } from "../supabase/functions/publish-run/domain/fixture.ts";
import { previewImport } from "../supabase/functions/publish-run/domain/preview.ts";
import type { ImportPayload, Summary } from "../supabase/functions/publish-run/domain/types.ts";
import { importSuite, loadPublicPublication, publishSuite } from "./lib/api.ts";
import { getSupabase } from "./lib/supabase.ts";
import { Report } from "./ui/report.tsx";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function App() {
  const client = useMemo(() => getSupabase(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [payload, setPayload] = useState<ImportPayload | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [paste, setPaste] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [saved, setSaved] = useState<{ suiteId: string; trialIds: string[] } | null>(null);
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const [publishedPublic, setPublishedPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [publicSummary, setPublicSummary] = useState<Summary | null>(null);
  const [publicNote, setPublicNote] = useState("");

  useEffect(() => {
    if (!client) return;
    let active = true;
    client.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = client.auth.onAuthStateChange((event, next) => {
      void event;
      setSession(next);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    const load = () => {
      const id = publicationIdFromHash();
      if (!id) {
        setPublicSummary(null);
        setPublicNote("");
        return;
      }
      if (!client) {
        setPublicSummary(null);
        setPublicNote("A public snapshot needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before it can load.");
        return;
      }
      setPublicNote("Loading snapshot.");
      loadPublicPublication(client, id)
        .then((next) => {
          setPublicSummary(next);
          setPublicNote(next ? "" : "That snapshot is not public, or it is not a version 1 record.");
        })
        .catch((error: unknown) => {
          setPublicSummary(null);
          setPublicNote(error instanceof Error ? error.message : "Could not load that snapshot.");
        });
    };
    load();
    window.addEventListener("hashchange", load);
    return () => window.removeEventListener("hashchange", load);
  }, [client]);

  function showPayload(next: ImportPayload) {
    const preview = previewImport(next);
    setPayload(next);
    setSaved(null);
    setPublicationId(null);
    setPublishedPublic(false);
    if (!preview.ok) {
      setSummary(null);
      setErrors(preview.errors);
      setMessage("The record did not pass validation.");
      return;
    }
    setErrors([]);
    setSummary(preview.summary);
    setMessage("Preview only. Nothing was saved and no agent was run.");
  }

  async function onSignIn(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    try {
      const { error } = await client.auth.signInWithPassword({ email, password });
      setMessage(error ? error.message : "Signed in.");
    } finally {
      setBusy(false);
    }
  }

  async function onSignUp() {
    if (!client) return;
    setBusy(true);
    try {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage(
        data.session
          ? "Signed in."
          : "Account created. If this project requires email confirmation, confirm it, then sign in. No suite was saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    if (!client) return;
    setBusy(true);
    const { error } = await client.auth.signOut();
    setBusy(false);
    setMessage(error ? error.message : "Signed out.");
  }

  async function onSave() {
    if (!client || !session) {
      setMessage("Sign in before saving. The preview stays on this page.");
      return;
    }
    if (!payload) {
      setMessage("Choose the sample or paste a record first.");
      return;
    }
    setBusy(true);
    try {
      const stored = await importSuite(client, payload);
      setSaved(stored);
      setPublicationId(null);
      setPublishedPublic(false);
      setMessage(`Saved suite ${stored.suiteId} with ${stored.trialIds.length} trials.`);
    } catch (error) {
      setSaved(null);
      setMessage(error instanceof Error ? error.message : "The suite was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function onPublish() {
    if (!client || !session) {
      setMessage("Sign in before publishing.");
      return;
    }
    if (!saved) {
      setMessage("Save the suite first. Publish recomputes the summary from stored rows.");
      return;
    }
    setBusy(true);
    const result = await publishSuite(client, saved.suiteId, saved.trialIds, isPublic);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    setPublicationId(result.id);
    setPublishedPublic(isPublic);
    setSummary(result.summary);
    setMessage(
      result.summary.attestation === "owner-supplied"
        ? isPublic
          ? "Published a public snapshot. The server recomputed it from stored trials."
          : "Published a private snapshot. The server recomputed it from stored trials."
        : "Published.",
    );
  }

  function onPaste() {
    try {
      const parsed = JSON.parse(paste) as ImportPayload;
      showPayload({ ...parsed, description: parsed.description ?? "" });
    } catch {
      setErrors(["That text is not JSON."]);
      setSummary(null);
      setMessage("The paste was not previewed.");
    }
  }

  const publicLink =
    publicationId && publishedPublic ? `${window.location.origin}${window.location.pathname}#pub=${publicationId}` : "";

  return (
    <div className="wrap">
      <header>
        <p className="kicker">S20 · skill eval harness</p>
        <h1>Paired instruction-file measurements</h1>
        <p>
          Compare a baseline with SKILL.md, AGENTS.md, or CLAUDE.md. The table shows Wilson intervals, exact McNemar
          tests, a task-level bootstrap, cost per passing trial, and whether the file was loaded.
        </p>
      </header>

      {publicNote ? <p className="banner">{publicNote}</p> : null}
      {publicSummary ? <Report summary={publicSummary} title="Public snapshot" /> : null}

      {client ? (
        <section>
          <h2>Account</h2>
          {session ? (
            <div className="row">
              <p>
                Signed in as <strong>{session.user.email}</strong>
              </p>
              <button type="button" className="secondary" onClick={onSignOut} disabled={busy}>
                Sign out
              </button>
            </div>
          ) : (
            <form className="grid" onSubmit={onSignIn}>
              <div>
                <label htmlFor="email">Email</label>
                <input id="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </div>
              <div>
                <label htmlFor="password">Password</label>
                <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </div>
              <div className="row">
                <button type="submit" disabled={busy}>
                  Sign in
                </button>
                <button type="button" className="secondary" onClick={onSignUp} disabled={busy}>
                  Create account
                </button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <section className="banner">
          <h2>Project not configured</h2>
          <p>
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then reload. Saving and
            publishing stay off until those values exist. The sample below is local and is not a live run.
          </p>
        </section>
      )}

      <section>
        <h2>Records</h2>
        <div className="row">
          <button type="button" onClick={() => showPayload(fixturePayload())} disabled={busy}>
            Show sample records
          </button>
          <button type="button" className="secondary" onClick={onSave} disabled={busy || !summary}>
            Save suite
          </button>
          <button type="button" className="secondary" onClick={onPublish} disabled={busy || !saved}>
            Publish snapshot
          </button>
          <label className="check">
            <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
            Public snapshot
          </label>
        </div>
        <label htmlFor="paste">Paste a run record</label>
        <textarea id="paste" value={paste} onChange={(event) => setPaste(event.target.value)} spellCheck={false} placeholder='{"name":"...","tasks":[],"trials":[]}' />
        <button type="button" className="secondary" onClick={onPaste} disabled={busy || paste.trim() === ""}>
          Preview pasted JSON
        </button>
        {message ? <p className="banner">{message}</p> : null}
        {errors.length > 0 ? (
          <ul className="warnings">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
        {publicLink ? (
          <p>
            Public link: <a href={publicLink}>{publicLink}</a>
          </p>
        ) : null}
        {publicationId && !publishedPublic ? <p>Private snapshot id: {publicationId}</p> : null}
      </section>

      {summary && payload ? <Report summary={summary} title={payload.name} /> : null}
      {payload ? (
        <details>
          <summary>Record JSON</summary>
          <pre>{JSON.stringify(payload, null, 2)}</pre>
        </details>
      ) : null}

      <footer>
        <p>Dirty Mode construction. Runtime is unverified. Statistics on a preview are computed in this browser.</p>
      </footer>
    </div>
  );
}

function publicationIdFromHash(): string | null {
  const match = /^#pub=([0-9a-f-]{36})$/i.exec(window.location.hash);
  if (!match?.[1] || !UUID.test(match[1])) return null;
  return match[1];
}
