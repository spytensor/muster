# Release Readiness Gate

Use this profile gate when a change will be deployed or distributed to users. Merge
is not release; release is complete only when rollout and rollback are understood.

## Required record

```text
# Release Readiness: <change>

Release artifact / version:
Feature flag or rollout control:
Rollout plan:
Rollback command / mechanism:
Migration or data compatibility notes:
Changelog / user communication:
Owner watching the rollout:
Post-release smoke:
Verdict: pass | fail
```

## Rules

- Rollback must name the concrete mechanism: revert SHA, flag name, down-migration,
  package version, or deploy command.
- A migration that cannot be safely rolled back must say so and name the forward-fix
  plan.
- User-visible changes need release notes or an explicit "internal only" reason.
