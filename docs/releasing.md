# Releasing

One version for the whole product. The server, the web app, the sandbox and the container
image carry it; the desktop and iOS apps are released with it and carry the same number.

## The number

[Semantic Versioning](https://semver.org), tags `vX.Y.Z`.

- **Before 1.0**: `0.Y.0` may change settings, the database schema or an API, and its
  changelog entry has an "Upgrading" part that says what to do. `0.Y.Z` only fixes.
- **From 1.0**: a change that breaks a deployment, a client still in use or a documented
  API is a new major version.
- A release candidate is `vX.Y.Z-rcN`. It gets an image and a GitHub pre-release, and
  never the `latest` tag. It needs the `## X.Y.Z` changelog heading too.
- The first public release is `0.2.0`: the desktop app had reached 0.1.3 before the
  repository was public, and one number now covers everything.
- Database changes are append-only steps, so upgrading is starting the new
  image. Going back to an older version after its schema steps ran is not supported:
  restore the backup made before the upgrade (`docs/runbook.md`, section 3).

## Making a release

`main` is always releasable. A maintainer:

1. Moves what is under "Unreleased" in `CHANGELOG.md` to a new heading
   `## X.Y.Z — YYYY-MM-DD`, and leaves an empty "Unreleased" above it.
2. Sets `version` to `X.Y.Z` in `package.json`, `apps/desktop/package.json` and
   `apps/mobile/package.json` (and `apps/mobile/app.json`), and "Latest release tag" in
   `AGENTS.md`.
3. Lands that as one pull request, `chore: release X.Y.Z`, with green CI.
4. Tags the merged commit and pushes the tag:

```bash
git tag -s vX.Y.Z -m "Muster X.Y.Z"
```

```bash
git push origin vX.Y.Z
```

The tag starts `.github/workflows/release.yml`, which checks that the tag matches
`package.json` and that the changelog has the entry, runs `pnpm check`, builds the
server and sandbox images, pushes them to GitHub's registry
(`ghcr.io/<owner>/<repository>` and `…-sandbox`, tagged `X.Y.Z`, and `latest` unless it
is a candidate), and opens a GitHub Release whose text is the changelog entry.

## The apps

- **Desktop**: `pnpm --filter @muster/desktop run release` on a Mac makes the signed,
  notarized build (it needs the maintainers' Apple Developer ID; see the script). Attach
  the archive to the GitHub Release. An organization can also build its own, naming its
  server in `apps/desktop/server.json`.
- **iOS**: built and submitted from `apps/mobile` (its README). Not in the App Store
  yet; an organization builds it with its own Apple account.

Not automated yet: desktop builds for Windows and Linux, and attaching the desktop build
from CI (signing needs keys that are not given to CI).

## A fix for an older version

Before 1.0 only the newest release gets fixes (`SECURITY.md`). From 1.0, a branch
`release/X.Y` is cut from the tag when an older line needs one, the fix is cherry-picked
from `main`, and the same steps make `X.Y.Z+1`.
