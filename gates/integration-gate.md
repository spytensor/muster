# Integration Gate

Governs many changes in flight at once so they do not corrupt the source of truth or
break `main`. Serves Standard P11. Applies whenever more than one agent/human is
active in the repo.

## Claim before branch (atomic)

1. Re-read the issue. Confirm `status:ready` + `agent-ready`, not `agent-halt`.
2. Claim atomically: self-assign **and** flip `status:ready` → `status:in-progress`
   in one step.
3. Re-read. If it is already assigned or no longer `status:ready`, **abort — you lost
   the race.** Pick the next ready issue.
4. Maintain a claim/progress record (pinned comment or `PROGRESS.md` on the branch):
   AC-by-AC status, decisions, dead ends, next step. Refresh it at each milestone.
   This is what a successor reads if you crash (P1: externalize, don't keep in chat).

A claim with no branch/comment activity past the lease window (default 24h) may be
relabeled `status:stale` by `check-stale-claims.sh` and reclaimed by another agent.

## Append, never overwrite shared evidence

Each completing PR appends its Evidence Ledger row as a **new issue comment** on the
tracker (use `append-ledger-row.sh`), never by concurrently editing the tracker body.
`@host` (or a scheduled job) reconciles comments into the body as an owned, serial
step.

## Integrate, don't just merge

- Require **up-to-date-before-merge** / a merge queue, so a PR green against stale
  `main` cannot land.
- After any rebase/merge of `main` that touches your files, **prior green CI is void**
  — re-run the full validation packet before merge.
- A **post-merge integration check** runs the full build + test on `main` after every
  merge (`main-integration.yml`). Breakage auto-files a `priority:high`
  `status:blocked` issue and freezes autonomous pickup until `main` is green.
- The **later** PR owns conflict resolution. If resolution changes behavior, it needs
  a fresh code-review gate.
- Never build on another agent's open PR branch. If blocked on it, release your claim
  (back to `status:ready`) and pick other ready work — do not idle-hold.

## Before pickup: avoid duplicate work

Search open issues/PRs for overlapping scope or files (the issue's "Affected Areas"
field makes this cheap). If found, link/merge and ask `@host` rather than starting a
parallel solution.
