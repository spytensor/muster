# Contributing to Muster

Thank you for looking. This page is all you need to send a change; `AGENTS.md` is the
longer protocol the maintainers and their coding agents work by, and it does not bind
you.

## Before you write code

- **A bug or an idea**: open an issue. For anything larger than a small fix, say what
  you plan in the issue first, so nobody builds what will not be taken.
- **A security problem**: [`SECURITY.md`](SECURITY.md), never a public issue.
- **Locked decisions**: `docs/architecture.md` lists them. A change that contradicts one
  needs an amendment in `docs/proposed-amendments.md` first, in a pull request of its own.

## Set up and check

Node.js 22.12 or later, pnpm 11.

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm check
```

`pnpm check` is what CI runs: format check, lint, build, typecheck, tests. CI also runs
the server's tests on PostgreSQL; `docs/runbook.md`, section 2, says how to do that
yourself. `pnpm format` rewrites files in place.

## What a pull request needs

- One thing per pull request, from a branch of your fork: `fix/<slug>`, `feat/<slug>`,
  `docs/<slug>`.
- A [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) title:
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `perf:`.
- Green CI. Do not delete, skip or weaken a test to get there; if a test is wrong, say
  why in the pull request.
- Tests for what you changed, and the feature's section in `docs/features/` changed with
  it when behaviour changes.
- A line in `CHANGELOG.md` under "Unreleased" when a person using or running Muster
  would notice the change.
- Nothing on screen that does nothing: a control works, or it is not there.
- No keys, tokens or real addresses, in code, fixtures or screenshots.

The parts of the pull request template about tier, tracker and evidence packet are for
the maintainers; leave them as they are. A maintainer reviews and merges. If you used an
AI assistant, say so; a `Co-Authored-By:` trailer is welcome.

## Licence of what you send

By sending a pull request you agree that your contribution is licensed under
[Apache-2.0](LICENSE), as the rest of Muster is. Code under `vendor/openclaw` stays as
upstream wrote it except as `vendor/openclaw/UPSTREAM.md` records; send changes to it
upstream.

## For maintainers

The maintainers' rules (one pull request per EPIC, tiers, gates, the tracker, who
merges) are in [`AGENTS.md`](AGENTS.md) and `gates/`. Releases: `docs/releasing.md`.
Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
