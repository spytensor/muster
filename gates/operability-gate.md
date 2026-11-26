# Operability Gate

Use this profile gate for services, jobs, apps, or workflows that must be supported
after release. A product is not industrial-grade if nobody can detect, diagnose, or
recover from failure.

## Required record

```text
# Operability: <change>

Runtime owner:
Logs added/changed:
Metrics:
Traces:
Alerts:
Dashboard:
Runbook:
SLO / expected behavior:
Failure modes and recovery:
Verdict: pass | fail
```

## Rules

- New failure modes need observable signals and an owner.
- Alerts must be actionable; noisy alerts without a runbook are not a pass.
- Background jobs and integrations need idempotency/retry behavior documented.
- If the project has no observability stack, record the gap and add the smallest
  useful fallback: structured logs plus a manual smoke command.
