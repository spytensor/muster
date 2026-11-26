# Data Governance Gate

Use this profile gate for persistent data, migrations, PII, audit trails, retention,
or cross-system synchronization. Code can often be reverted; data damage may not.

## Required record

```text
# Data Governance: <change>

Data stores touched:
Schema changes:
Backfill plan:
Rollback / forward-fix plan:
Backup / restore evidence:
PII or sensitive data:
Retention / deletion impact:
Audit log impact:
Access-control impact:
Owner:
Verdict: pass | fail
```

## Rules

- Schema migrations must state compatibility with old and new code during rollout.
- Backfills need an idempotent plan, progress visibility, and abort criteria.
- PII changes require privacy/security review and least-privilege access.
- If rollback is impossible, the PR must say so and provide a tested forward-fix
  path.
