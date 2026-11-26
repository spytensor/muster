# Audit-Sampling Gate

At scale, no one re-checks every PR, so fabrication and gaming pay off exactly when
nobody is looking. This gate keeps the verifiers honest by re-running a *sample* of
already-merged work. Serves Standard P10 ("verify the verifier").

## What gets audited

- A **risk-weighted random sample** of merged Tier 1 PRs (weight up: security/IO/
  state changes, new authors/agents, PRs that needed CI re-runs to go green).
- **Every** EPIC-closing real-use gate (no sampling — always re-run independently).

## Who

A human, or an agent identity that is **not** the implementer or the original
reviewer (P10).

## What the auditor does

1. Check out the merged change at its merge commit on a pinned toolchain.
2. Re-run the PR's claimed evidence: the exact commands in the evidence packet.
3. Compare results to what the ledger/PR claimed.
4. Spot-check that tests actually assert and were not weakened/deleted to pass.

## Outcome

```text
audited_pr: #<n>
auditor: <identity != implementer/reviewer>
reproduced: yes | no
discrepancies: <none | description>
verdict: pass | fail
```

A `fail` (evidence does not reproduce, or tests were gamed): reopen the work, file a
`priority:high` issue, and **widen sampling** for that author/area until a clean
streak returns. Repeated fails are a signal the gates are being satisfied
superficially — escalate to `@host`.

## Cadence

Default: audit on a schedule (e.g. weekly) plus on every EPIC closure. Record the
sample rate; if you cap coverage, `log` what was not audited — silent truncation
reads as "everything checked".
