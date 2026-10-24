# Run record

Paste this shape into the app, or send it to `import_suite` after sign-in. The sample button loads a larger synthetic record of the same shape. Hashes below are placeholders, not digests of a real file.

```json
{
  "name": "Parser ablation",
  "description": "Owner-supplied records. No agent was run by the app.",
  "tasks": [
    {
      "slug": "trailing-comma",
      "title": "Accept a trailing comma",
      "prompt": "Update the parser so a trailing comma is valid, and leave the other cases unchanged."
    }
  ],
  "trials": [
    {
      "task_slug": "trailing-comma",
      "harness": "claude-code",
      "condition": "baseline",
      "seed": 1,
      "passed": false,
      "instruction_loaded": null,
      "input_tokens": 100,
      "output_tokens": 40,
      "cost_usd": 0.02,
      "cli_version": "claude 1.0.62",
      "model_id": "claude-example",
      "artifact_sha256": "none",
      "grader_id": "parser-checks",
      "grader_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    {
      "task_slug": "trailing-comma",
      "harness": "claude-code",
      "condition": "skill",
      "seed": 1,
      "passed": true,
      "instruction_loaded": true,
      "input_tokens": 180,
      "output_tokens": 70,
      "cost_usd": 0.05,
      "cli_version": "claude 1.0.62",
      "model_id": "claude-example",
      "artifact_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "grader_id": "parser-checks",
      "grader_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  ]
}
```

Rules checked before a preview:

- One to 2,000 trials. Slugs match `^[a-z0-9][a-z0-9-]{0,63}$`.
- `harness` is `claude-code` or `codex`.
- `condition` is `baseline`, `skill`, `agents`, or `claude`.
- Baseline: `artifact_sha256` is `none` and `instruction_loaded` is null.
- Treatment: `artifact_sha256` is 64 lowercase hex characters and `instruction_loaded` is true or false.
- `grader_sha256` is 64 lowercase hex characters.
- A harness that has a treatment also needs a baseline.
- Duplicate `(harness, condition, task, seed)` is rejected.

One task is not enough for a winner. The verdict stays uninformative or no-winner until at least two tasks give the bootstrap a non-degenerate interval. See `STATISTICS.md`.

The deterministic grader is separate. It scores a workspace snapshot. It does not call a model.

```json
{
  "files": { "out/report.txt": "status: ok\n" },
  "commands": { "check": { "exitCode": 0, "stdout": "{\"score\": 1}", "stderr": "" } }
}
```

Checks are `file_exists`, `file_contains`, `command_exit`, and `json_score`. An empty check list fails. A bad regular expression fails that check and does not throw.

Runner planners live in `supabase/functions/publish-run/domain/runners.ts`. They are not an executor. A live plan requires `CLAUDE_BIN` plus `ANTHROPIC_API_KEY`, or `CODEX_BIN` plus `OPENAI_API_KEY`, supplied by the caller. Those values are never `VITE_` variables and are not read from disk by this app.
