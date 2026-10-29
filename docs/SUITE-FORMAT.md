# Suite, task and replay file formats (s20 runner)

Status: source contract for the local Node runner. Not yet executed.

A suite is a trusted, owner-authored directory. The runner reads it with byte/count bounds, rejects symlinks and
reparse points, and records digests of everything before scheduling. Oracles, expected files and grader scripts stay
outside the agent workspace and are only used after the agent process has exited.

## suite.yaml

```yaml
suite_id: acme-changelog          # safe id: letters, digits, . _ : -
version: "1"
description: Fictional changelog conventions for a toy library.
tasks:                            # explicit list; each names tasks/<id>/task.yaml
  - changelog-heading
candidate:                        # the treatment artifact
  kind: skill                     # skill | agents-md | claude-md
  path: skill/acme-changelog      # skill: a directory containing SKILL.md; agents-md / claude-md: one file
```

A skill directory's `SKILL.md` frontmatter `name` must equal the directory name. Frontmatter keys other than `name`
and `description` (for example `allowed-tools`, `model`, hooks or dependencies) are refused under the default
content-only intervention.

## tasks/<id>/task.yaml

```yaml
id: changelog-heading             # must equal the folder name
label: Add a release heading in house style
prompt_file: prompt.md            # task-relative; the base prompt. Native-mode prompts never name the skill.
fixture: fixture                  # task-relative directory copied into the fresh agent workspace
oracle: oracle                    # task-relative directory overlaid onto a copy of the fixture (validate only)
grader_timeout_ms: 30000          # optional; capped by the experiment grader limit
graders:                          # all must pass; an empty list is an authoring error
  - id: changelog-exists
    kind: file_exists
    path: CHANGELOG.md            # workspace-relative regular file
  - id: heading-style
    kind: file_contains
    path: CHANGELOG.md
    pattern: '^## \[1\.4\.0\] - 2026-10-23$'
    flags: m                      # subset of i, m; see "Patterns" below
  - id: exact-footer
    kind: file_equals
    path: NOTICE.txt
    expected: expected/NOTICE.txt # task-relative trusted file, never copied to the workspace
    normalize_line_endings: false # true only by explicit choice; pinned in the grader digest
  - id: unit-check
    kind: command_exit
    argv: ["{node}", "{task}/graders/check.mjs", "{workspace}"]
    expect_exit: 0
  - id: style-score
    kind: json_score
    argv: ["{node}", "{task}/graders/score.mjs", "{workspace}"]
    threshold: 0.8                # pass when score >= threshold
```

Placeholders in `argv`: `{node}` (the runner's Node executable), `{task}` (absolute trusted task directory),
`{workspace}` (absolute agent workspace). Commands run with the shell disabled, a bounded timeout and bounded output.
A `json_score` command must print one JSON object `{"score": <0..1>, "checks": [{"id": "...", "pass": true}]}`
(`checks` optional). Invalid JSON, a missing score or a score outside [0,1] is `grader_error`; a valid low score is `fail`.

### Patterns

`file_contains` uses a linear-time matcher, not the JavaScript regex engine. Supported: literals, `.`, character
classes `[...]` / `[^...]` with ranges, escapes `\d \w \s \D \W \S \. \[ \] \( \) \\` and other escaped punctuation,
groups `( )`, alternation `|`, quantifiers `* + ?`, anchors `^ $`. Not supported (refused as `grader_error`):
backreferences, lookaround, lazy quantifiers, counted repetition `{m,n}`, named groups. Flags: `i` (ASCII case
folding), `m` (`^`/`$` match at line boundaries). Pattern and text sizes are bounded.

## Validation (`validate`, no spend)

For every task: copy the fixture, overlay the oracle, run the graders -> must pass. Run the graders on the untouched
fixture -> must fail. Any invalid task fails the whole suite with reasons. Corrections create a new suite digest.

## Replay scripts (synthetic, no model)

`replay/<task_id>/<arm_id>.json`, optionally overridden per repeat by `replay/<task_id>/<arm_id>.r<repeat_id>.json`.
The replay agent is a real child process (`node dist-runner/cli.mjs __replay-agent <script> <workspace>`), so lifecycle, deadlines,
capture, grading and the writer are the real pipeline. Its records carry attestation `replay-synthetic`.

```json
{
  "schema": "s20.replay.v1",
  "note": "synthetic",
  "steps": [
    { "event": { "type": "start", "model": "replay-model", "cli_version": "replay-1" } },
    { "event": { "type": "exposure", "mechanism": "native-invocation", "artifact": "SKILL.md" } },
    { "write": { "path": "CHANGELOG.md", "content": "..." } },
    { "sleep_ms": 50 },
    { "event": { "type": "usage", "input_tokens": 1200, "output_tokens": 300, "cost_usd": 0.01 } },
    { "event": { "type": "result", "status": "success" } },
    { "exit": 0 }
  ]
}
```

Step kinds: `event` (one JSON line on stdout), `write` (workspace-relative file, bounded), `sleep_ms`, `hang`
(never exits; exercises deadlines and process-tree cleanup), `exit` (exit code). Writes outside the workspace are refused.
