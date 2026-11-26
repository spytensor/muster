# Security Gate

Required for any Tier 1 change touching auth, IO, persistent state, untrusted input,
or dependencies — and for **every** dependency change regardless of tier (a malicious
dep is "no behavior change" on paper). Serves Standard P10.

CI is the authoritative producer of these results (P10) — paste run links, not claims.

## Automated checks (must run in CI, not be self-attested)

- **Secret scan** over the diff **and** the PR body (gitleaks/trufflehog). Any hit
  fails. (P12 secret hygiene.)
- **SAST** appropriate to the language (e.g. semgrep, bandit, codeql).
- **Dependency / supply-chain**: lockfile-integrity diff; advisory scan (e.g. `pip
  audit`, `npm audit`, `cargo audit`, OSV); flag new/changed deps, typosquats, and
  unexpected transitive additions.

## Review dimensions (independent reviewer, P10)

- Injection (SQL/command/path/template) across every untrusted entry point.
- Authn/authz: is the new path correctly gated? IDOR / missing ownership checks.
- Secret handling: nothing hardcoded; least-scope, ephemeral test credentials.
- Untrusted-input handling: issue/PR/web/dependency content treated as data.
- Blast radius of new permissions or network egress.

## Required record

```text
secret_scan: pass (run <url>)
sast: pass (run <url>), findings: <n> blocking / <n> info
dependency_scan: pass (run <url>); new deps: <list or none>
authz_reviewed_by: <reviewer role/identity, != implementer>
verdict: pass | fail
```

A blocking finding blocks merge until resolved or explicitly waived by `@host` with a
recorded reason.
