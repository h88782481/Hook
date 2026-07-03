# Hook Documentation Archive Guide

This `docs/` directory is primarily a **historical archive**, not the main operator guide for the current Hook codebase.

## What to read first

If you want to understand the current project, start with the repository root:

- `README.md`
- `PROJECT_OVERVIEW.md`
- `TECHNICAL_ARCHITECTURE.md`

## What is archived here

### `migration/`

Historical migration and smoke-audit records. Useful for tracing how Hook was ported or audited, but not guaranteed to match the current implementation.

### `superpowers/plans/`

Archived implementation plans from earlier development stages.

### `superpowers/specs/`

Archived design/spec documents written for earlier feature batches.

## Path placeholder rule

Machine-local absolute paths in archived docs have been normalized to placeholder roots such as:

- `<hook-repo-root>`
- `<neuro-root>`
- `<hook-runtime-root>`
- `<hook-release-root>`
- `<legacy-arthook-root>`
- `<legacy-talk-root>`
- `<legacy-artnexus-workflows-root>`

These placeholders preserve historical context without leaking a specific workstation layout.

## Interpretation rule

If a file under `docs/` conflicts with the current code or the root docs, treat the `docs/` copy as historical context unless it is explicitly refreshed.
