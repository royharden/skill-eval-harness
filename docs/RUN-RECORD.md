# Run records (schema s20.run.v2)

Source of truth: `supabase/functions/publish-run/domain/contracts.ts` (types), `validate.ts` (runtime validators),
`manifest.ts` (manifest and envelope). This page summarizes them; the code wins on any difference.

## ExperimentSpec (`experiment.json`)

schema_version, experiment_id; suite {suite_id, version, digest}; tasks[] {task_id, display_label, prompt_digest,
fixture_tree_digest, grader_digest, oracle_digest, suite_path}; harness_id; supported_cli_version_range;
pinned_cli_version; requested_model_id; resolved_model_policy; effort; base_tool_permission_config {digest,
summary}; environment_allowlist_names (names only); ambient_context_digest; repeats; scheduling_seed; retry_policy
{startup_retries (default 0), selection}; limits {first_event_timeout_ms, agent_timeout_ms, grader_timeout_ms,
max_output_bytes, max_attempts, max_usd, max_tokens, run_deadline, enforcement: stop-new-work}; intervention
(content-only); arms [baseline, treatment] {arm_id, artifact_kind, artifact_digest, bundle_files_digest,
exposure_mode, prompt_overlay_digest, config_differences, arm_digest}; experiment_digest; notes.

experiment_digest hashes the invariant configuration (everything except arms, itself and notes). arm_digest
hashes its descriptor without itself. Content-only intervention refuses configuration differences.

## Ledger editions (`ledger/edition-NNNN.json`)

{schema_version, run_id, experiment_digest, edition, kind plan|recovery|final, predecessor_digest, created_at,
sides[], note}. A side is {task_id, repeat_id, arm_id, order_index, order_in_pair, state planned|attempted|
not_started, attempt_ids[], selected_attempt_id}. `not_started` exists only here, never as an attempt status. The
selected attempt follows the pinned policy (the last attempt after qualified startup retries); a ledger whose
selection disagrees is refused, so retries cannot be cherry-picked.

## AttemptRecord (`attempts/<attempt_id>.json`)

Identity (run, experiment, task, repeat, arm, attempt id/no, order_in_pair), reported CLI/model, effective config,
ambient, base and effective prompt, fixture, grader and artifact digests; lifecycle timestamps; status
pass|fail|timeout|agent_error|grader_error|cancelled, terminal_reason, exit_code; grade {checks, score,
snapshot_digest}; trace {digest, bytes, truncated}; exposure {status, mechanism, artifact_digest, event_ref};
nullable usage counters with semantics; cost {usd, source reported|estimated|unknown, pricing_snapshot}; turns;
duration_ms; cleanup; retry_qualified; errors; attestation runner|replay-synthetic|imported (claimed origin).
`pass` requires grader evidence where every declared check passed.

## Manifest and envelope

The browser imports one JSON envelope `{manifest, files}` where files maps relative paths to UTF-8 text:
`experiment.json`, `ledger.json`, `attempts/<id>.json`, `summary.json` (and any reviewed extra files). The importer
checks the 8 MiB byte cap before parsing, then shape bounds, then exact path set, path safety/aliases, per-file
caps and SHA-256 of every file against `manifest.files`, then `content_digest`, and only then parses and validates
records, re-derives digests and recomputes the summary in the browser. `summary.json` is never trusted.

No self-hash cycles: `manifest.files` excludes the manifest; `content_digest` hashes the manifest without itself;
the summary references `records_edition_digest` (SHA-256 of canonical {spec, ledger, sorted attempts}). Withheld
inputs appear as typed `source_refs` (unverifiable metadata). A sanitized manifest records the transform rules,
the private manifest digest and the source experiment digest.

Shared limits: 8 MiB envelope, 4,096 files, 512 KiB per file, 2,000 attempts, 2,000 planned sides, 256 tasks,
20 repeats, depth 32, 256-character ids/paths, 64 KiB strings.

Matching hashes prove integrity against the supplied manifest — not agent execution, honesty, or that a rerun
would reproduce stochastic outcomes.

## Legacy v1 records

The earlier owner-supplied format (`{name, description, tasks[{slug,title,prompt}], trials[...]}`) is still
accepted by an explicit legacy importer. It shows descriptive counts with **unverified** (task, seed) pairing and
lists the pins it cannot provide; it computes no interval or test and never invents prompt/config pins.
