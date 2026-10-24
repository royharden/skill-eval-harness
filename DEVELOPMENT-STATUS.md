# Development status

Dirty Mode construction. Runtime unverified. Updated 2026-10-23.

| Area | State |
|---|---|
| Comparison math, grader, runner planners, sample record | Written. Tests are in `tests/` and have not been executed. |
| SQL migration and `publish-run` | Written. Not applied and not deployed. |
| Browser UI | Written. Not built and not opened. |
| Package lockfile | Absent on purpose until a later install. |
| Agent execution | Not implemented. Planners refuse without a binary path and an API key. |
| Live database, auth, and public snapshots | Depend on Bolt provisioning. No project is connected. |

A failed or skipped check is not a pass. `BOLT-HANDOFF.md` lists the checks that still have to be run.
