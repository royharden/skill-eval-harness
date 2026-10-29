# Development status

Dirty Mode construction — runtime unverified. Updated 2026-10-24 (S20-INT run). Static checks below ran at commit `3bfb0fe` with an out-of-tree TypeScript 6.0.3;
the repo pins `typescript ^5.7.3`, so they must be rerun after install.

| Area | State |
|---|---|
| v2 domain (contracts, validators, canonical JSON, digests, pairing, statistics, manifests, envelope, sanitize, graders, pattern matcher) | Written; no-emit `tsc` clean at `3bfb0fe`. Unit tests written, not executed. |
| Browser report / import / export / auth / save / publish / `#pub=` | Written; type-checked only against scratch React/Supabase shims. Not built or opened. |
| Runner CLI (validate, preflight, dry run, run, resume, report, export) + replay | Written; no-emit `tsc` clean with Node types and a type-only `yaml` shim. Never executed. |
| Claude Code / Codex adapters | Written as hypothesis contracts with synthetic event fixtures. No real CLI invoked. |
| Example suite `examples/acme-changelog` + replay scripts | Written; oracle/null validation hand-checked only. |
| Forward migration + `publish-run` v2 | Written; not parsed by a SQL tool, not applied, not deployed. Handler type-checked against a Deno shim. |
| Lockfile / dependencies | None installed; no lockfile. |
| Legacy v1 modules (`compare.ts`, `verdict.ts`, `preview.ts`, `pins.ts`, `types.ts`, `stored.ts`, `fixture.ts`, `grade.ts`, `runners.ts`, `src/ui/report.tsx`) | Kept for history and the legacy importer; not used by the v2 report. `verdict.ts` winner labels are not shown anywhere. |

A skipped or failed check is not a pass. `BOLT-HANDOFF.md` lists the checks still owed.
