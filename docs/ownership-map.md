# Muster — Ownership Map

This profile document is for teams where code, APIs, data, review, and runtime
responsibility must be explicit. Keep it aligned with `.github/CODEOWNERS` and
`docs/code-map.md`.

`Last reviewed:` 2026-11-18

## Ownership table

| Area | Code owner | API/contract owner | Data owner | Runtime owner | Required reviewer |
|---|---|---|---|---|---|
| Governance (`AGENTS.md`, `docs/`, `gates/`, `.github/`, `automation/`) | @spytensor | n/a | n/a | n/a | @spytensor |
| Workspace toolchain (root config, CI) | @spytensor | n/a | n/a | n/a | @spytensor |
| `packages/` (`protocol`, `ui-schema`) | @spytensor | @spytensor | @spytensor | n/a | @spytensor |
| `apps/` (`server`, `web`, `desktop`, `mobile`) | @spytensor | @spytensor | @spytensor | @spytensor | @spytensor |

The project has a single owner today, so one handle appears in every column. That
means the "reviewer ≠ author" rule is met by a different agent or model reviewing
the work, with the owner approving the merge.

## Escalation

- Product ambiguity: @spytensor
- Architecture boundary exception: @spytensor
- Security/privacy decision: @spytensor
- Release/incident owner: @spytensor

## Rules

- A PR that changes an area must request review from the required reviewer.
- A data or runtime change cannot merge with only a code owner approval.
- If ownership is unknown, the PR records `owner unresolved` and asks `@host`; do
  not let the implementer silently become the owner by touching the file.
