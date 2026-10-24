# Local runner (s20)

Status: source written, statically type-checked, **never executed**. Every statement below describes intended
behavior of the source, not observed behavior.

## Commands

```text
validate <suite-dir>                                 no spend; oracle-applied fixture must pass, untouched must fail
preflight <experiment.yaml>                          resolves binary, CLI version (--version probe only), pins, capabilities
run <experiment.yaml> --dry-run                      resolved hashes, limits, capabilities, schedule; starts no CLI/model
run <experiment.yaml> --out <dir> [--run-id <id>]    serial dispatch
run <experiment.yaml> --resume --run-id <id> --out <dir> [--confirm-stopped <attempt_id,...>]
report <run-dir>                                     recompute the summary from the run's records
export <run-dir> [--keep-labels] [--keep-check-details] [--out <dir>]
                                                     sanitized staging bundle under <out>/<run_id>/ (not publication)
```

There is no static-publish command. Public links use the optional Bolt Database path.

## Experiment file

```yaml
experiment_id: acme-skill-replay      # safe id
suite: ../acme-changelog              # relative to this file
harness: replay                       # replay | claude-code | codex
model: replay-model                   # pinned id; no default model is ever assumed
effort: null
repeats: 3                            # 1-20; repeat_id is zero-based and is not a provider seed
scheduling_seed: 20261023             # controls dispatch order and bootstrap resampling only
exposure_mode: native                 # native | explicit-request | forced-content
startup_retries: 0                    # default 0; only affirmative no-action startup failures may retry
estimate_usd_per_side: null           # required for paid dispatch when limits.max_usd is set
environment_allowlist: []             # extra env NAMES passed to the child (values never recorded)
output_root: null                     # or --out / S20_OUTPUT_ROOT; must be outside every git work tree
limits: {}                            # overrides: first_event_timeout_ms 30000, agent_timeout_ms 180000,
                                      # grader_timeout_ms 30000, max_output_bytes 8 MiB, max_attempts,
                                      # max_usd, max_tokens, run_deadline (ISO)
notes: ""
```

All overrides are resolved and pinned into `experiment.json` before dispatch. The experiment digest pins the
invariant configuration; each arm digest pins the treatment difference (artifact, exposure mode, prompt overlay).

## Run directory (private)

```
<output_root>/<run_id>/
  experiment.json           resolved ExperimentSpec
  ledger/edition-NNNN.json  immutable plan/recovery/final editions, each referencing its predecessor
  attempts/<id>.json        immutable AttemptRecords (never overwritten)
  inflight/<id>.json        dispatch markers (crash recovery)
  traces/<id>.log           private bounded raw stdout/stderr — never exported
  snapshots/<id>.json       private captured grader snapshot — never exported
  workspaces/<id>/          fresh agent workspace (own git root, outside existing repos)
  homes/<id>/               per-attempt HOME / config dirs (proposed isolation)
  budget.json               pinned per-side estimate and caps (must match on resume)
  cleanup/<id>.json         immutable "cleanup established" records for cleanup_pending attempts
  grader-inflight/          trusted grader child pids recorded at spawn
  LOCK                      single-runner lock
  records.jsonl             regenerated convenience index
  manifest.private.json, bundle.private.json   written when the ledger is final
```

Writes go to a temp file in the same directory, are flushed, then renamed. Universal crash durability is not claimed.

## Lifecycle, deadlines and cleanup

planned → materialized → agent_started → agent_terminal → grader_terminal → finalized. First-event, total-agent and
grader deadlines are separate. A deadline, output cap or cancel terminates the owned process tree (`taskkill /T /F`
on Windows, process-group signals on POSIX) and waits for confirmed exit before grading or new dispatch. If exit
cannot be confirmed the attempt is `cancelled` with `cleanup_pending`, scheduling stops, and resume refuses until
the process is gone. On POSIX, "confirmed" means the leader exited and the whole process group was SIGKILLed
and polled empty (also checked after a normal exit); a descendant that called setsid()/setpgid() left the group and
is invisible to this probe. On Windows only the leader's exit is confirmed (`taskkill /T /F` is best effort for the
tree, and nothing checks for grandchildren after a normal exit). No OS/version combination has been validated yet.
Trusted grader children have their pids recorded at spawn and are checked on resume like the agent.

Status mapping: valid grader success → `pass`; valid failed check → `fail`; agent deadline after the first event →
`timeout` (a binary failure under the pinned policy); startup, first-event, auth, output-cap, missing terminal event
or harness error result → `agent_error`; malformed grader definitions/output → `grader_error`; operator cancel or
unresolved cleanup → `cancelled`. Final assistant text alone is never completion.

## Budgets

Caps stop new work; they are not provider-enforced. A fresh block is admitted on the estimate for both sides and
every side is rechecked before dispatch, so an exhausted cap can leave the partner side `not_started` (visible as an
unmatched side, never padded). With `max_usd` set and no pinned estimate, paid dispatch is refused; executed attempts
with unknown cost are charged the pinned per-side estimate. With `max_tokens` set, any executed attempt with unknown
usage stops new work (the cap cannot be enforced). Replay has no model spend; its scripted cost is labelled estimated. In-flight usage can overshoot; reports show cap, known cost and coverage.

## Resume

Resume requires identical experiment, arm and suite digests; anything changed needs a new run. The child pid is
written synchronously at spawn and the dispatch marker before the workspace is materialized. A dead leader pid is not
proof of cleanup: on POSIX resume probes the whole process group (children are spawned detached, so the pid is the
group id); on Windows, and whenever no pid was recorded or a live pid may have been reused, the operator must name
the attempt with `--confirm-stopped`. The evidence (group probe or operator confirmation) is written into the record.
Budget inputs (per-side estimate and caps) are pinned in `budget.json` at run start and must match on resume. A
trusted grader process whose exit cannot be confirmed also marks the attempt `cleanup_pending` and stops scheduling. Cleanup
established for a `cleanup_pending` attempt is recorded in `cleanup/<attempt_id>.json`, after which the run can
finalize (the attempt itself stays an operational exclusion). Finalized attempts
written after the last edition are adopted; dispatched-but-unfinalized attempts are recorded as `cancelled`
(action history unknown, never retried automatically); a recovery edition references its predecessor. Measured
outcomes are never overwritten. With `max_tokens` set, an interrupted or cancelled record has unknown usage, so a
resume stops new work at the first side and finalizes with the remaining sides `not_started` (stop-new-work rule).

## Isolation (trusted mode only)

Supported live mode: trusted owner-authored toy suites/skills on an owner-controlled disposable account and
environment. A fresh cwd is not a sandbox. The child gets shell-disabled argv, an environment allowlist (names
recorded), per-attempt `HOME`/`USERPROFILE` plus `CLAUDE_CONFIG_DIR` or `CODEX_HOME` overrides, and serial
execution. That does not prove ancestor, system, plugin, enterprise or bundled context was excluded. Preflight
reports only whether known real-home discovery locations exist, never their contents. The runner never reads
credential files; the proposed auth path is passing the selected provider API-key variable to the child.

## Adapter capability status

| Harness | Skill discovery | AGENTS.md | CLAUDE.md | Exposure observation | Cost |
|---|---|---|---|---|---|
| replay | synthetic | synthetic | synthetic | exposure events in the script | synthetic, no spend |
| claude-code | hypothesis (`.claude/skills/<name>/`) | refused | hypothesis | Skill or Read of the installed SKILL.md with a successful tool_result (hypothesis) | `total_cost_usd` (hypothesis) |
| codex | hypothesis (`.agents/skills/<name>/`) | hypothesis | refused | completed exit-0 read verb with the installed SKILL.md as an argument (redirects/in-place edits refused); else unknown | unknown |

Candidate invocations (unverified): `claude -p --output-format stream-json --verbose --model <id>
--permission-mode acceptEdits -- <prompt>` and `codex exec --json --model <id> --sandbox workspace-write -- <prompt>`. On Windows,
`CLAUDE_BIN` / `CODEX_BIN` must name a real executable, not a `.cmd`/`.ps1` shim (the shell is disabled).
Activation must consult current official docs/help, pin installed binaries, and run disposable canaries for global
leakage and local exposure before any row above changes from hypothesis.
