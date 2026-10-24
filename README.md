# Skill eval harness

Does this exact instruction artifact change a real coding-agent CLI's results on my chosen tasks, and at what token,
time and monetary cost?

The harness compares one no-artifact **baseline** with one **treatment** (a complete `SKILL.md` bundle, an
`AGENTS.md` or a `CLAUDE.md`, only for a harness/file combination that is supported) on your own trusted tasks,
with deterministic graders, paired repeats and honest uncertainty. It has three parts that share one
environment-neutral domain (`supabase/functions/publish-run/domain/`):

1. **Offline report (browser, Vite + React).** Load the labelled synthetic sample or import a bundle. See planned,
   attempted and not-started sides, complete pairs, helpful/harmful flips, the task-weighted effect, an empirical
   task-cluster bootstrap interval, an exact McNemar test on predeclared repeat 0 only, operational failures,
   exposure evidence and cost coverage. Preview and download a sanitized export. No login or database needed.
2. **Local runner (Node CLI, `runner/`).** Validate a trusted suite (oracle must pass, untouched fixture must fail),
   dry-run a resolved experiment, replay synthetic events through the real scheduler, process host, graders and
   writer, and — only after separately authorized activation — run Claude Code or Codex as separate pinned experiments.
3. **Optional persistence (Bolt Database).** Save an immutable run edition, then ask `publish-run` to recompute and
   sanitize it into a public or private snapshot at `#pub=<id>`. Neither login nor database gates offline analysis.

No winner badge is computed. The report always shows the observed direction, and says when the interval is
unavailable, degenerate or includes zero. Results apply only to the selected suite and recorded environment.

## What is built — and what has not run

**Dirty Mode construction (2026-10-23). Source written and statically inspected; nothing has been executed.**

| Area | Built (source) | Not yet run |
|---|---|---|
| v2 contracts, validators, canonical JSON, digests, pairing, retry selection | yes | unit tests |
| Statistics (task mean, Wilson, cluster bootstrap, repeat-0 McNemar, cost coverage) | yes | unit tests, independent numeric cross-check |
| Manifests, envelope verification, sanitized export | yes | unit tests |
| Browser report, import, export, auth, save/publish, `#pub=` view | yes | `vite build`, any browser session |
| Runner: suite loader, graders, capture, validate, dry run, scheduler, process host, store, budgets, resume, replay | yes | `build:runner`, any CLI command, replay run |
| Claude Code and Codex adapters | yes, **hypothesis contracts** | any real CLI invocation; flags/events/discovery roots are unverified |
| Forward migration, `publish-run` v2 | yes | migration apply, function deploy, RLS tests |

Static checks that did run: a no-emit TypeScript 6.0.3 check of the domain, runner and tests (with `@types/node`
and a type-only `yaml` shim), and shimmed checks of the React UI and the Deno handler. Those are type checks, not
builds or tests. No dependency has been installed and there is no lockfile. See `DEVELOPMENT-STATUS.md`.

## First journey (written, not exercised)

1. `npm run dev`, open the page, click **Load synthetic sample**. The sample is fabricated: it shows flips, ties,
   a task timeout, a missing side, a grader error and unknown cost. It is not measured agent behavior.
2. `npm run build:runner`, then `npm run cli -- validate examples/acme-changelog`.
3. `npm run cli -- run examples/experiments/acme-replay.yaml --dry-run`, then without `--dry-run` and with
   `--out <a folder outside any git repo>`. Import `<run>/bundle.private.json` into the page, or
   `npm run cli -- export <run-dir>` for a sanitized bundle.
4. Live Claude Code / Codex runs need Roy's pinned model ids, machine/account, auth channel and explicit spend and
   attempt limits first. Nothing in this repo authorizes spend.

## Scripts (after a later, authorized `npm install`)

```text
npm run typecheck          # browser + domain (tsc --noEmit)
npm run typecheck:runner   # runner + domain + tests with Node types
npm test                   # vitest run
npm run build              # Vite -> dist/
npm run build:runner       # esbuild -> dist-runner/cli.mjs
npm run cli -- <command>   # validate | preflight | run [--dry-run|--resume] | report | export
```

A skipped or failed command is not a pass.

## Docs

- `docs/STATISTICS.md` — the method actually implemented (s20.taskmean.v1).
- `docs/RUN-RECORD.md` — the v2 record, ledger, manifest and envelope shapes, plus the legacy v1 importer.
- `docs/SUITE-FORMAT.md` — suite, task, grader and replay file formats.
- `docs/RUNNER.md` — runner commands, isolation limits, budgets, resume and adapter capability status.
- `BOLT-HANDOFF.md` — optional Bolt Database provisioning inventory.

## Prior art

Ideas (not code) from Waza, skillgrade, SkillsBench, paired-eval/benchtrace and claude-ablation-lab: separate
executor/grader/report, oracle/null gate, startup watchdog, deterministic checks, paired outcomes, task-cluster
resampling, exposure evidence. The example suite is original fictional content.

## License

MIT. See `LICENSE`.
