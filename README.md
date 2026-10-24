# Skill eval harness

A small web app for paired measurements of instruction files. It compares a baseline (no file) with `SKILL.md`, `AGENTS.md`, and `CLAUDE.md` on the same tasks and seeds, for Claude Code and Codex records.

The headline numbers are a Wilson interval on each pass rate, an exact McNemar test on the flips, a task-clustered bootstrap of the pass-rate difference, USD and tokens per passing trial, and a check that the instruction file was actually loaded. A point estimate is not a winner. The paired interval has to be non-degenerate and sit entirely above or below zero.

Records are owner-supplied. This app does not launch an agent, call a model, or invent a pass when a key is missing.

## What is built

- Pure comparison, pin checks, and a deterministic grader over a workspace snapshot (file exists, file contains, command exit code, JSON score).
- Planner functions for a later Claude Code or Codex host. They return an unverified command contract or an error that names the missing variable. They do not spawn a process.
- A sample record you can preview in the browser without a database.
- SQL for owner-scoped suites and trials, with forced row-level security, and an immutable publication written only by the `publish-run` function after it recomputes the summary.
- Email/password sign-in, save, and publish once a Bolt Database project is configured.

## What has not been run

Dirty Mode construction. No install, typecheck, unit test, Vite build, migration, function deploy, or browser session has been executed in this repo. The lockfile is not committed. CLI flags in the planners are an unverified contract. See `DEVELOPMENT-STATUS.md` and `BOLT-HANDOFF.md`.

## Demo, local preview

1. Open the app. With no `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`, it shows the setup panel and does not invent a project URL.
2. Choose **Show sample records**. The sample is synthetic: two tasks, two seeds, a skill file, and an `AGENTS.md` file. One skill trial is marked not loaded.
3. Read the pass rates, intervals, flips, verdict, cost per passing trial, and the loaded-file warning.

Saving and publishing need the database path in `BOLT-HANDOFF.md`. After sign-in, **Save suite** stores the record and **Publish snapshot** asks `publish-run` to recompute it. A public snapshot opens at `#pub=<id>`.

## Scripts

After a later `npm install` (the lockfile is deliberately absent):

```text
npm run dev
npm run typecheck
npm test
npm run build
```

Do not treat a missing run of those commands as a pass.

## Prior art

The paired design follows public ideas from Waza, skillgrade, SkillsBench, benchtrace, and paired-eval. No source from those projects is copied. `docs/STATISTICS.md` states the rules this repo actually implements. `docs/RUN-RECORD.md` is the import shape.

## License

MIT. See `LICENSE`.
