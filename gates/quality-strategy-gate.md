# Quality Strategy Gate

Use this profile gate for Tier 1 work in products where regressions matter. It
turns "what tests should we run?" into a risk-based checklist.

## Required record

```text
# Quality Strategy: <change>

Risk surface:
Required checks:
  unit:
  integration:
  contract:
  end-to-end:
  migration:
  performance:
  accessibility:
  visual/snapshot:
Checks intentionally skipped:
Non-regression suite:
CI run links:
Verdict: pass | fail
```

## Rules

- Shared code, public contracts, and data changes need more than unit tests.
- User-facing flows need at least one real path check: E2E, manual smoke, or a
  committed script that exercises the built artifact.
- A skipped check needs a reason and an owner; "not enough time" is a risk, not a
  pass.
- Flake re-runs are disclosed and linked to a quarantine issue.
