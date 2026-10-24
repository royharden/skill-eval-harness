import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent } from "react";
import type { LoadedRun } from "../App.tsx";
import { deletePublication, listMyPublications, publishEdition, revokePublication, saveEdition, setVisibility, type MyPublication, type Publication, type SavedEdition } from "../lib/api.ts";

/**
 * Optional Bolt Database persistence. Offline analysis and local runs never depend on it.
 * Every async path releases busy in finally and reports failures instead of substituting demo behavior.
 */
export function PersistencePanel({ client, run }: { client: SupabaseClient | null; run: LoadedRun | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedEdition | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [mine, setMine] = useState<MyPublication[]>([]);
  // One idempotency key per (saved edition, visibility) request, so a retried click cannot duplicate it.
  const [requestKey, setRequestKey] = useState<string>(() => crypto.randomUUID());

  useEffect(() => {
    setSaved(null);
    setPublication(null);
    setRequestKey(crypto.randomUUID());
  }, [run]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    client.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session);
      })
      .catch(() => {
        if (active) setMessage("Could not read the current session.");
      });
    const { data } = client.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  async function guarded(action: () => Promise<string>) {
    setBusy(true);
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!client) {
    return (
      <section className="banner" aria-labelledby="persist-title">
        <h2 id="persist-title">Optional saving is not configured</h2>
        <p>
          Saving runs and creating snapshot links use an optional Bolt Database. Set <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code>, then reload. Loading, analysing and exporting work without them.
        </p>
      </section>
    );
  }

  const onSignIn = (event: FormEvent) => {
    event.preventDefault();
    void guarded(async () => {
      const { error } = await client.auth.signInWithPassword({ email, password });
      return error ? error.message : "Signed in.";
    });
  };

  const onSignUp = () =>
    guarded(async () => {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl() } });
      if (error) return error.message;
      return data.session ? "Signed in." : "Account created. If this project requires email confirmation, confirm it, then sign in.";
    });

  const onReset = () =>
    guarded(async () => {
      if (!email) return "Enter your email first.";
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
      return error ? error.message : "If that account exists, a reset link was sent.";
    });

  const onUpdatePassword = (event: FormEvent) => {
    event.preventDefault();
    void guarded(async () => {
      const { error } = await client.auth.updateUser({ password });
      if (error) return error.message;
      setRecovering(false);
      return "Password updated.";
    });
  };

  const onSignOut = () =>
    guarded(async () => {
      const { error } = await client.auth.signOut();
      if (!error) {
        setSaved(null);
        setPublication(null);
        setMine([]);
      }
      return error ? error.message : "Signed out.";
    });

  const onSave = () =>
    guarded(async () => {
      if (!run) return "Load a run first.";
      if (run.source === "sample") return "The synthetic sample is not saved. Import a runner bundle to save it.";
      const next = await saveEdition(client, run.records, saved?.suiteId ?? null);
      setSaved(next);
      setPublication(null);
      setRequestKey(crypto.randomUUID());
      return next.existing ? `This exact edition was already saved (edition ${next.editionId}).` : `Saved immutable edition ${next.editionId}.`;
    });

  const onPublish = () =>
    guarded(async () => {
      if (!saved) return "Save the edition first. Publishing recomputes the summary from the saved bytes.";
      const next = await publishEdition(client, saved, isPublic, requestKey);
      setPublication(next);
      return `${next.isPublic ? "Public" : "Private"} snapshot ${next.id} created from edition ${saved.editionId}; the server recomputed and sanitized it.`;
    });

  const onRefresh = () =>
    guarded(async () => {
      const list = await listMyPublications(client);
      setMine(list);
      return `${list.length} publication(s).`;
    });

  const onToggle = (id: string, next: boolean) =>
    guarded(async () => {
      await setVisibility(client, id, next);
      setMine(await listMyPublications(client));
      return next ? "Made public." : "Made private.";
    });

  const onRevoke = (id: string) =>
    guarded(async () => {
      await revokePublication(client, id);
      setMine(await listMyPublications(client));
      return "Revoked. The public link no longer loads.";
    });

  const onDelete = (id: string) =>
    guarded(async () => {
      await deletePublication(client, id);
      setMine(await listMyPublications(client));
      return "Deleted.";
    });

  return (
    <section aria-labelledby="persist-title">
      <h2 id="persist-title">Optional saving</h2>
      {recovering ? (
        <form className="grid" onSubmit={onUpdatePassword}>
          <div>
            <label htmlFor="new-password">New password</label>
            <input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          <button type="submit" disabled={busy}>
            Set new password
          </button>
        </form>
      ) : session ? (
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
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div className="row">
            <button type="submit" disabled={busy}>
              Sign in
            </button>
            <button type="button" className="secondary" onClick={onSignUp} disabled={busy}>
              Create account
            </button>
            <button type="button" className="secondary" onClick={onReset} disabled={busy}>
              Reset password
            </button>
          </div>
        </form>
      )}
      {session ? (
        <div>
          <p className="meta">
            {run ? `Loaded run: ${run.records.ledger.run_id}${run.source === "sample" ? " (synthetic sample; not saved)" : ""}` : "Load or import a run to save it."}
          </p>
          <div className="row">
            <button type="button" onClick={onSave} disabled={busy || !run || run.source === "sample"}>
              Save edition
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => {
                  setIsPublic(e.target.checked);
                  setRequestKey(crypto.randomUUID());
                }}
              />
              Public snapshot
            </label>
            <button type="button" className="secondary" onClick={onPublish} disabled={busy || !saved}>
              Publish snapshot
            </button>
            <button type="button" className="secondary" onClick={onRefresh} disabled={busy}>
              My publications
            </button>
          </div>
          {publication ? (
            <p>
              {publication.isPublic ? (
                <>
                  Public link: <a href={`${redirectUrl()}#pub=${publication.id}`}>{`${redirectUrl()}#pub=${publication.id}`}</a>
                </>
              ) : (
                `Private snapshot id: ${publication.id}`
              )}
            </p>
          ) : null}
          {mine.length > 0 ? (
            <ul>
              {mine.map((m) => (
                <li key={m.publication_id}>
                  {m.publication_id} · {m.revoked_at ? "revoked" : m.is_public ? "public" : "private"} · {m.created_at}{" "}
                  {!m.revoked_at ? (
                    <>
                      <button type="button" className="secondary" disabled={busy} onClick={() => onToggle(m.publication_id, !m.is_public)}>
                        {m.is_public ? "Make private" : "Make public"}
                      </button>{" "}
                      <button type="button" className="secondary" disabled={busy} onClick={() => onRevoke(m.publication_id)}>
                        Revoke
                      </button>{" "}
                    </>
                  ) : null}
                  <button type="button" className="secondary" disabled={busy} onClick={() => onDelete(m.publication_id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

function redirectUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}
