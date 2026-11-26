#!/usr/bin/env bash
# Verify that a repo installing this standard has the GitHub-side enforcement that
# the files describe. This checks external state, not just committed templates.
# Usage: automation/check-self-governance.sh [owner/repo] [branch]
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
branch="${2:-main}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
fail=0

need_file() {
  local path="$1"
  if [ ! -f "$root/$path" ]; then
    echo "MISSING file: $path"
    fail=1
  fi
}

echo "checking self-governance for $repo@$branch"

need_file ".github/PULL_REQUEST_TEMPLATE.md"
need_file ".github/workflows/standard-guard.yml"
need_file ".github/workflows/main-integration.yml"
need_file "AGENTS.md"

labels_file="$here/labels.yml"
if [ -f "$labels_file" ]; then
  existing="$(gh label list --repo "$repo" --limit 300 --json name -q '.[].name' 2>/dev/null || true)"
  while IFS= read -r label; do
    [ -z "$label" ] && continue
    if ! grep -qxF "$label" <<<"$existing"; then
      echo "MISSING label: $label"
      fail=1
    fi
  done < <(sed -nE 's/^- name: *"?([^"]*)"?/\1/p' "$labels_file")
else
  echo "MISSING file: automation/labels.yml"
  fail=1
fi

if ! bash "$here/verify-branch-protection.sh" "$repo" "$branch"; then
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "self-governance: FAIL (sync labels, install workflows, and protect $branch)"
  exit 1
fi

echo "self-governance: OK"
