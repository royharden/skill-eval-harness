# Bolt infrastructure handoff: skill-eval harness (v2)

Dirty Mode construction — runtime unverified. This is a provisioning inventory, not a receipt. Updated 2026-10-24.

## Target and readiness

- Repository / branch: local git only, branch `main`, no remote. App root: this folder.
- Database: **optional** Bolt Database (Supabase-compatible). The offline report and the local runner work without it.
- Target: a fresh empty database, or an existing one only after its migration history is inspected. No remote
  baseline has been verified; a file on disk is not an applied migration.
- Hosting/publication: prepare only. Do not publish the site, push, or deploy without a separate instruction naming
  the destination, content and access.
- Status: source written; no install, lockfile, typecheck, test, build, migration, deploy or browser check has run.
- The native runner is a **local external CLI**, never part of the Bolt deploy. No model key is needed for the web app.

## Build and connection

| Item | Exact command or name |
|---|---|
| Runtime / package manager | Node ≥ 20 with npm. Ranges in `package.json`; no lockfile yet. |
| Install | Later, when authorized: `npm install`, commit `package-lock.json`, then `npm ci`. |
| Browser build | `npm run build` (Vite → `dist/`). Dev: `npm run dev` (assign a port via agent-ports first). |
| Runner build | `npm run build:runner` (esbuild → `dist-runner/cli.mjs`). Excluded from browser and Edge bundles. |
| Checks | `npm run typecheck` (browser + domain), `npm run typecheck:runner` (runner + domain + tests, Node types), `npm test` (vitest). Deno handler is checked separately (e.g. `deno check supabase/functions/publish-run/index.ts`). |
| Public env names | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` only (`src/lib/supabase.ts`). |
| Missing config | The page shows "Optional saving is not configured" and still loads the sample, imports and exports. It never invents a URL or swaps a failed call for demo data. |

## Database

| Order | Migration | Resources | Applied |
|---|---|---|---|
| 1 | `supabase/migrations/20261023190000_create_skill_eval.sql` | legacy `suites`, `tasks`, `trials`, `publications`, triggers, `import_suite`, forced RLS | pending |
| 2 | `supabase/migrations/20261024000000_v2_editions_and_publications.sql` | `suite_editions` (immutable v2 input + digest), `publication_artifacts` (sanitized bytes + recomputed summary), `publication_controls` (private owner/visibility/idempotency), triggers, `save_suite_edition`, `record_publication` (service_role only), `get_public_publication` (anon/authenticated), `delete_my_publication`, forced RLS, column grants | pending |

- Apply only pending files in order, preserve data, report drift instead of dropping tables.
- Access model: editions private to `auth.uid()`; owners may change only `is_public`/`revoked_at` on their controls;
  nobody writes artifacts directly; public reads go only through `get_public_publication`, which returns sanitized
  columns and no owner identity. Source suite/edition deletion sets control references to null and never touches
  copied artifact bytes; owner deletion via `delete_my_publication` removes access (permanence is not promised).
- Activation risk to verify: the SECURITY DEFINER functions assume their owner role bypasses RLS under FORCE ROW
  LEVEL SECURITY (true for Supabase's `postgres` role as commonly configured; confirm on the target).
- Seeds: none. The synthetic sample stays in the browser.

## Function

| Name / source | Caller + auth | Input → output | Secrets |
|---|---|---|---|
| `publish-run` (`supabase/functions/publish-run/index.ts`, domain in `./domain/`) | Signed-in user JWT; gateway `verify_jwt = true` (`supabase/config.toml`); handler re-verifies with `auth.getUser()` | POST `{suiteId, editionId, expectedContentDigest, isPublic, idempotencyKey}` (≤ 16 KiB) → `{publication: {id, isPublic, createdAt, sourceEditionDigest, contentDigest, schemaVersion, summary}}`; default private | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only, never `VITE_`) |

Order inside the handler: bounded body → caller JWT → suite and edition ownership → edition digest equals
`expectedContentDigest` and the stored bytes re-hash to it → shared v2 validation → recompute → sanitize →
`record_publication` (transactional idempotency: same key + same request returns the existing row; changed request
→ 409). CORS `*` is not authorization. If the Bolt bundler does not follow `./domain/*.ts`, vendor those modules
next to `index.ts`; never import `src/` from the function.

## Auth

Email/password sign-in, sign-up (confirmation per project setting; the UI says when no session is returned),
sign-out, password reset email and recovery (`PASSWORD_RECOVERY` → set new password). Set Site URL and allowed
redirect to the app origin; reset/confirmation links return to the same page. No fabricated auth success.

## Not used

Buckets, Realtime, schedules, hosted workers, web model calls, Docker, CI.

## Provisioning prompt (inspect and prepare; do not publish)

> Import this repository. Do not publish. Inspect the connected Bolt Database's migration history. If it is empty,
> apply `20261023190000_create_skill_eval.sql` then `20261024000000_v2_editions_and_publications.sql`; otherwise
> report which are applied and apply only pending ones in order without dropping data. Deploy `publish-run` with its
> `domain/` folder and `verify_jwt = true`. Confirm `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
> `SUPABASE_SERVICE_ROLE_KEY` exist as function secrets (names only). Configure email/password auth with Site URL
> and redirect set to the app origin. Report every step's real result; do not mark anything working that was not
> exercised.

## Acceptance checks still owed (none run)

1. `npm install` → commit lockfile → `npm run typecheck`, `npm run typecheck:runner`, `npm test`, `npm run build`,
   `npm run build:runner`; `deno check` the handler.
2. No-env page: setup notice, sample report, import of a runner bundle, sanitized export preview/download.
3. Runner: `validate examples/acme-changelog`; `run examples/experiments/acme-replay.yaml --dry-run`; replay run;
   import its bundle; interrupt + `--resume`; hang/cleanup behavior on the advertised OS.
4. Database on an authorized target: anon / owner A / owner B matrix for editions, controls and artifacts; denied
   direct writes; idempotency conflict; source deletion does not mutate artifacts; public read hides owner identity.
5. Native adapters: only after Roy pins models, account, auth channel and spend/attempt limits — canaries first.
