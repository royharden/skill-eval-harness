# acme-changelog example suite

Original, fictional toy content written for the S20 skill-eval harness. `acme-widgets` is not a real library and
every URL uses the reserved `example.invalid` domain. The suite is frozen before any live run; corrections make a
new suite version and digest rather than editing tasks after measurements.

- `suite.yaml` lists six tasks: four that depend on the house conventions in `skill/acme-changelog/SKILL.md`
  (`changelog-heading`, `changelog-date-format`, `changelog-link-refs`, `version-metadata`) and two neutral ones
  (`neutral-fix-typo`, `neutral-add-test`).
- Each `tasks/<id>/` holds the prompt, the fixture copied into the agent workspace, the oracle overlay used only
  by `validate`, trusted graders and any expected files. File formats follow `docs/SUITE-FORMAT.md`.
- `replay/<task_id>/<arm>.json` (with optional `.r<repeat>.json` overrides) are scripted synthetic agents for a
  no-model pipeline run. Their outcomes are synthetic and designed by hand, not measured agent behavior:
  across 3 repeats the baseline usually breaks the conventions and the treatment usually follows them, with one
  deliberate harmful flip (`changelog-link-refs`, treatment repeat 1), one treatment timeout
  (`version-metadata`, treatment repeat 1, which also has no usage event so its cost is unknown), one baseline
  tie (`changelog-date-format`, baseline repeat 2) and one treatment repeat with no exposure event
  (`changelog-heading`, treatment repeat 2).
