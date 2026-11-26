# Security

Muster sits between agents and a company's data, so a hole in it matters. Thank you for
telling us before telling everyone.

## Reporting a problem

Use GitHub's private report: on this repository, **Security → Report a vulnerability**.
Do not open a public issue or pull request for it.

Say what you found, how to reproduce it, and which commit or release you looked at. You
will get an answer within five working days. We will agree a date with you before
anything is made public, and name you in the release notes unless you would rather not.

## What counts

- Getting past the gateway: a tool call that should have asked or been refused and ran.
- Getting out of the sandbox, or reaching the network from it when it is closed.
- Reading or changing another person's or another organization's data.
- Getting in without signing in, or keeping a session that was ended.
- Changing or removing entries of the activity log.
- A secret (a model key, a connector's credential) shown to someone who should not see it.

Not a vulnerability here: what happens with `MUSTER_DEV=1`, which turns on a
passwordless sign-in for development and which the server refuses to combine with
PostgreSQL or https; and what a model says, as long as the gateway held.

## Which versions get fixes

Before 1.0, only the newest release.
