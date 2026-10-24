import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent } from "react";
import type { LoadedRun } from "../App.tsx";

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
      return error ? error.message : "Signed out.";
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
      {session && run ? <p className="meta">Loaded run: {run.records.ledger.run_id}</p> : null}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

function redirectUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}
