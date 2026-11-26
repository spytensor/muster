# Changelog

What a person using or running Muster would notice, newest first. Versions follow
[Semantic Versioning](https://semver.org); how a release is made is in
[`docs/releasing.md`](docs/releasing.md). Before 1.0, a minor version may change
settings, the database schema or an API; when it does, the entry says so under
"Upgrading".

## Unreleased

First public release.

- The workspace on web, desktop (Electron) and iOS: conversations with agents, replies
  as generated interface, documents, files, projects, building agents.
- The control plane and admin console: sign-in (Google, Microsoft, OIDC, SAML), SCIM,
  the agent roster with risk levels, approvals, traces, usage and cost, the activity log.
- The runtime: OpenClaw's agent loop (`vendor/openclaw`, tag `v2026.9.8`) behind one
  gateway; code run in a sandbox that reaches only the hosts an
  administrator allows.
- Deployment with Docker Compose: server, PostgreSQL, sandbox.
