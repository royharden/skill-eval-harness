# Bolt infrastructure handoff: skill-eval harness

Dirty Mode construction — runtime unverified. This file is the provisioning inventory. It is not a receipt.

## Target and readiness

- Repository / branch / prepared revision: local git only, branch `main`, no remote.
- App root: repository root (the inner `skill-eval-harness` folder).
- Database: Bolt Database.
- Target: fresh empty database. Do not attach or replace an existing project.
- Existing baseline / applied migrations: none. The SQL file has not been applied. A file on disk is not an applied migration.
- Hosting: Bolt hosting, not requested yet.
- Publication: prepare only. Do not publish the site.
- Bolt action: provision the backend when authorized. Do not publish.
- Status: implementation written, infrastructure pending. Local install, typecheck, tests, and Vite build were not run.
- Owner prerequisites: Bolt GitHub import when Roy wants it, a fresh Bolt Database, and email/password auth settings. No model-provider key is required for the web demo.

## Build and connection

| Item | Exact command or configuration name |
|---|---|
| Runtime / package manager | Node with npm. Ranges are in `package.json`. There is no lockfile yet, so versions are not frozen. |
| Frozen install / dev | Later: generate the lockfile with `npm install`, commit it, then use `npm ci`. Dev command: `npm run dev`. |
| Build / output | `npm run build`. Vite writes `dist/`. Not run. |
| Type/lint/tests | `npm run typecheck` (`tsc --noEmit`). `npm test` (`vitest run`). Neither has been run. No ESLint config. The edge function is excluded from `tsconfig.json` because it runs on Deno. |
| Client file / public env names | `src/lib/supabase.ts`. `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. |
| Missing config behavior | The page shows a setup panel and still lets the user open the local sample. It does not invent a URL or silently switch a live call into the sample. |

## Database

| Order | Exact migration file | Resources / dependencies | Applied status |
|---|---|---|---|
| 1 | `supabase/migrations/20261023190000_create_skill_eval.sql` | `suites`, `tasks`, `trials`, `publications`; checks; triggers; `import_suite`; forced RLS | pending |

- Access model: suites, tasks, and trials are private to `auth.uid()`. Publications have no client insert, update, or delete policy. Authenticated users can read their own rows and public rows. Anonymous users can read `is_public` rows only.
- Ownership checks: trial and publication triggers require the owner to own the suite and the trials to belong to that suite. `publish-run` checks the JWT user against `suites.owner_id` before using the service role.
- Extensions/RPC permissions/Realtime: `import_suite(jsonb)` is executable by `authenticated` only. Realtime is not required. No extra extensions.
- Seeds: none in SQL. The sample record is `supabase/functions/publish-run/domain/fixture.ts` and stays out of the database until a signed-in user saves it.
- Retry rule: inspect migration tracking, apply only this pending file, preserve data, and report drift instead of dropping tables.

The service role bypasses row-level security, including `FORCE ROW LEVEL SECURITY`. That is why `publish-run` must keep its owner check. Do not add a browser insert policy on `publications` to "fix" a publish error.

## Functions

| Name / source | Caller + auth | Input / output | Resources + secret names | Deploy config |
|---|---|---|---|---|
| `publish-run`; `supabase/functions/publish-run/index.ts` | Signed-in user JWT. Gateway `verify_jwt = true`. Handler calls `auth.getUser()` and rejects a missing user. | POST `{ suiteId, trialIds, isPublic }` → `{ publication: { id, isPublic, createdAt, summary } }` | Reads `suites` and `trials`. Inserts `publications`. Domain code is in `supabase/functions/publish-run/domain/` and is imported relatively. Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. | `supabase/config.toml` sets `verify_jwt = true`. Import specifier: `npm:@supabase/supabase-js@2.49.1`. |

- CORS/preflight: `Access-Control-Allow-Origin: *` with headers `authorization, x-client-info, apikey, content-type` and methods `POST, OPTIONS`. The browser sends the JWT as a header, not a cookie. `*` is not authentication.
- Identity/ownership and abuse controls: non-owner suite returns 403. Trial ids must be UUIDs belonging to that owner and suite. Body cap 1.5 MB. Trial cap 2,000. Reads are chunked by 100 ids. The handler recomputes the summary and will not store a client-supplied summary.
- Paid API limits: not required. This function does not call a model.
- Webhooks: not required.
- Platform credentials: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected server secrets. Verify they exist. Do not copy values from another project.

If the Bolt bundler does not follow `./domain/*.ts`, vendor those modules into the function entry. Do not point the function at `src/`.

## Server secrets to enter through settings

| Name | Consumer | Required / optional | Owner source |
|---|---|---|---|
| `SUPABASE_URL` | `publish-run` | Required for publish | Platform-injected project URL |
| `SUPABASE_ANON_KEY` | `publish-run` | Required for publish | Platform public key, server-side copy |
| `SUPABASE_SERVICE_ROLE_KEY` | `publish-run` | Required for publish | Platform service role. Never `VITE_` |
| `ANTHROPIC_API_KEY` | Future runner host only | Optional. Unused by the web app | Anthropic account, later |
| `OPENAI_API_KEY` | Future runner host only | Optional. Unused by the web app | OpenAI account, later |

Missing-secret behavior: `publish-run` returns HTTP 500 with the missing names and does not write a summary. The planners return an error naming `CLAUDE_BIN`, `ANTHROPIC_API_KEY`, `CODEX_BIN`, or `OPENAI_API_KEY` and do not invent a result. No secret value is written into the response.

## Auth, storage, and external steps

- Auth providers/confirmation: email and password. Confirmation is whatever the project sets. The UI says so when sign-up returns no session. Password recovery UI is not built.
- Site URL and callback/recovery routes: the app origin. Hash routes used by the app are `#pub=<uuid>` for a public snapshot. There is no `/auth/callback` page.
- Buckets: not required.
- Realtime: not required.
- Scheduled/long jobs: not required. Publication is a request/response call, not a worker.
- Outside services: a model account is not required to preview, save, or publish records. Running Claude Code or Codex later is an owner step on a separate host and is outside this Bolt deploy.
- Real integrations: Supabase Auth, Postgres, and `publish-run`. Explicit demos: the sample fixture in the browser. Runner planners are not live executors.

## Acceptance checks and receipts

| Check | Expected result | Outcome / receipt |
|---|---|---|
| Import/install/build | `npm install`, `npm run typecheck`, `npm test`, and `npm run build` succeed | pending — not run |
| Schema | The one migration is the only pending file and its tables, policies, and `import_suite` exist | pending — not applied |
| Function round trip | Signed-in `Publish snapshot` stores a summary recomputed on the server | pending — not deployed |
| Auth/isolation | Signed-out save fails. User B cannot read user A's suite or private snapshot. User B cannot publish user A's suite | pending |
| Missing secret | Undeployed or unconfigured `publish-run` returns an actionable error and no fabricated summary | pending. Source returns 500 naming the three `SUPABASE_*` secrets |
| Uploads, if needed | Not required | Not required |
| Webhooks, if needed | Not required | Not required |
| Jobs, if needed | Not required | Not required |
| Publish, if requested | Not requested | Not run |

## One prompt after GitHub import

### Provision backend

> Read BOLT-HANDOFF.md and use its **Bolt Database** target. The implemented code is written and the local checks are pending, as that file says. Perform the missing infrastructure setup: create a fresh Bolt Database, confirm there is no applied migration baseline, apply only `supabase/migrations/20261023190000_create_skill_eval.sql`, and deploy `publish-run` with `verify_jwt = true`, including the `domain` modules beside the entry file. Configure email/password auth and the public `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values. Confirm the server has `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Do not put the service role in a `VITE_` variable. Do not add model API keys for this demo. Preserve the app; change code only for a concrete deployment or wiring gap. Run the acceptance checks and record receipts. **Prepare hosting without publishing.** Do not replace the comparison math with a mock, and do not make private suites public for a demo.
