# Code Review Gate

Strict, **independent** review for Tier 1 work (Standard P10).

## Independence is mandatory (not preferred)

- The reviewer's agent identity **must differ from the implementer's**.
- Use a **different model where available** — `cross_model_satisfied: true` is
  required for Tier 1; `false` needs an explicit `@host` waiver with a reason.
  (Same-model self-review is documented to miss ~half of real defects.)
- The review must cite **tool-grounded evidence** — the reviewer ran the tests,
  grepped the pattern, opened the path. A review that only restates the PR
  description does not count.
- Authoritative results come from CI runs (P10); link run IDs, don't paste claims.

## Required output fields

```text
reviewer_identity: <agent/human, != implementer>
engine: <claude|codex|gemini|...>
model: <model>
cross_model_satisfied: true|false   # must be true for Tier 1, or @host-waived
blocking_count: <n>
warning_count: <n>
test_quality_ok: true|false
all_blockings_resolved: true|false
ci_run: <url>
```

## Review dimensions

- Correctness against the plan and acceptance criteria.
- Data-flow safety across entry points, state, IO, and downstream effects.
- Cross-path behavior and edge cases.
- Error handling and rollback behavior.
- Plan/diff drift (did the implementation wander from the plan?).
- **Test quality** (P10): every new behavior has a test that fails without the
  change; no assertion-free tests; mocks do not replace the unit under test;
  snapshots are not blindly blessed. **No tests deleted/skipped/`xfail`/weakened to
  go green** — if test files shrink or loosen, that needs its own PR + justification.
- **Non-regression**: relevant existing suites (full suite for shared-code changes)
  pass on the merge commit; a green achieved only by re-running flakes is noted, not
  hidden.
- **Scope** (P6): the diff matches the declared tier and one concern; no out-of-scope
  files without a stated reason.
- Security dimensions if it touches auth/IO/state/deps — defer to
  [`security-gate.md`](security-gate.md).
- Consistency: grep for nearby patterns the change should match; reuse the canonical
  utility from `docs/code-map.md` rather than reinventing.

Every finding that claims code evidence cites `path:line` (Standard P2). A blocking
finding blocks merge until resolved or explicitly waived by `@host` with a reason.
Approval means the dimensions above were checked against the actual diff — not prose.
