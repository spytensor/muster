<!--
PR title MUST follow Conventional Commits:
  feat: …      feat(<scope>): …
  fix: …       chore: …   docs: …   refactor: …   test: …   ci: …   perf: …
Scope is a directory or module name.

Provenance trailers in the PR description / commits (Standard P9):
  Agent: <claude-code|codex|gemini|human>
  Model: <model-id>
  Run-ID: <session or CI run id>
-->

<!-- Contributing from outside the maintainers? Fill in Summary, Test plan and Out of
     scope; leave the rest as it is. See CONTRIBUTING.md. -->

## Summary

<!-- 1–3 sentences. What changed and why? -->

## Governance tier / lane

Selected tier/lane: <Tier 0 | Tier 1 | Tier 2 | Hotfix / Incident | Codemod / Sweep>

Reason:

## Architecture impact

Architecture impact: <No change | Refines an open question | Amends a locked decision>

Evidence/link:

## Linked issues

<!-- Plane tickets: the EPIC (MUS-N + URL) and the child tickets this PR completes. -->

## Acceptance criteria

<!-- Copy the linked issue AC and tick only what this PR satisfies. -->
<!-- AC must have been ratified by a party other than the implementer BEFORE work (P10). -->

- [ ] AC-1:
- AC ratified by (≠ implementer):

## Test plan (CI runs are authoritative — link them; P10)

- format check: <pass | fail | n/a> — run:
- lint: <pass | fail | n/a> — run:
- tests: <pass | fail | n/a> — run:
- build: <pass | fail | n/a> — run:
- non-regression: <pass | fail | n/a> — relevant/affected suites on the merge commit:
- real-use / manual smoke: <pass | fail | n/a> — what you ran, against which real build:
- Flake disclosure: <none | tests re-run to go green + the quarantine issue>

## Evidence packet

- Plan artifact (Tier 1+):
- Independent code-review (reviewer identity ≠ implementer; cross_model_satisfied):
- Security gate (if auth/IO/state/deps; secret-scan / SAST / dep-scan run links):
- Sign-off gate (SO-N / RG-N mapping):
- Profile gates (if installed):
- Changed files:
- Commands run / CI run links:
- Test changes justification (if any test was modified/removed — P10):
- Snapshot/fixture evidence, if user-facing output changed:
- Risks / remaining gaps:
- Rollback (concrete mechanism: `git revert <sha>` / flag name / down-migration):
- Unverified items:

## Real-use evidence (EPIC-closing PRs only)

<!-- The dogfood/manual/E2E run that proves the product path works, executed by CI or
     a party != the implementer (Standard P3/P10). "n/a — not EPIC-closing" is fine. -->

- executed_by (≠ implementer / CI run url):

## Tracker update (Plane)

The PR is incomplete until Plane is updated. This project keeps tickets in Plane
only; there is no GitHub tracker issue.

- Tracker issue: none — Plane <MUS-N>
- Plane tickets updated with PR and CI links: <yes | no — reason>
- Evidence Ledger row appended: no — Plane is the tracker

If implementation is complete but Plane is stale, report
`implementation complete, tracker incomplete`; do not claim `done`.

## Out of scope

<!-- What you intentionally didn't do, even though it's adjacent. -->
