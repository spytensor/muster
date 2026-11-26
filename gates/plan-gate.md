# Plan Gate

Create a plan before Tier 1 implementation. The plan is the contract the code-review
and sign-off gates check against.

Required structure:

```text
# Plan: <feature>

## Scope
- In:
- Out:

## Files and Impact
- <path>:<line> - expected change

## Reuse (cite docs/code-map.md)
- Existing utilities/modules I will reuse instead of reinventing: <code-map entries>

## Approach
- <key decisions; reference docs/architecture.md by decision ID; flag any amendment needed>

## Rollback Strategy
- <git revert <sha> / feature-flag name / tested down-migration — name a concrete
  mechanism, not prose. Prefer shipping behind a flag for user-facing Tier 1.>

## Sign-off Checklist
| ID | Predicate | Verification Method | Pass Criterion |
| --- | --- | --- | --- |
| SO-1 | <what must be true> | <command / test / manual check> | <observable pass> |
| RG-1 | <what must NOT regress> | <existing suite / affected tests on merge commit> | <green, no flake retries> |
```

Attach the plan to the issue or PR. Every `SO-N`/`RG-N` row is mapped back to
CI-produced evidence at the sign-off gate (Standard P2/P10). The acceptance criteria
the plan satisfies must have been ratified by `@host` or a party other than the
implementer before work starts (P10) — an AC edited inside the implementing PR is a
flag.
