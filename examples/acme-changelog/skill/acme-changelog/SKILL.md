---
name: acme-changelog
description: House conventions for the acme-widgets library's CHANGELOG.md release headings, dates, compare links and version metadata. Use when adding or editing a release entry, cleaning up release dates or links, or bumping the acme-widgets version.
---

# acme-widgets changelog and version conventions

## Release headings

- `## [Unreleased]` always stays first, directly under the intro paragraph.
- Each release heading is exactly `## [X.Y.Z] - YYYY-MM-DD`: version in square brackets, a space, a hyphen,
  a space, the release date. No `v` prefix, no parentheses, nothing after the date.
- Newest release first. Group entries under `### Added`, `### Changed`, `### Fixed`, `### Removed` (in that
  order, empty groups omitted). Bullets start with `- ` and name the API in backticks, for example
  ``- `resize()` method on `Widget`.``

## Dates

- ISO 8601 calendar dates only: `2026-10-23`. Never `October 23, 2026`, `23 Oct 2026`, `10/23/2026` or
  `2026/10/23`.
- When tidying older entries, convert each existing date to this form without changing the day.

## Compare links

- All link reference definitions sit together at the very bottom of CHANGELOG.md, one per heading, in the
  same order as the headings, with nothing after them.
- `[Unreleased]: https://example.invalid/acme-widgets/compare/vX.Y.Z...HEAD` where X.Y.Z is the newest release.
- Each release: `[X.Y.Z]: https://example.invalid/acme-widgets/compare/vPREVIOUS...vX.Y.Z`.
- The first release only: `[1.0.0]: https://example.invalid/acme-widgets/releases/tag/v1.0.0`.
- When cutting a release, repoint `[Unreleased]` at the new version and add the new release's compare line
  directly below it.

## Version metadata

- The version is recorded in two places that must agree: `"version"` in package.json, and a `VERSION` file at
  the repository root containing only the bare version and one trailing newline (`1.4.0`, no `v`).
- Create `VERSION` if it is missing. A version bump always updates both.
