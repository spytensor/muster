#!/usr/bin/env bash
# Verify main is actually protected (Standard P10/P11). Run in the guard workflow on
# push:main so an unprotected main is loud, not silent.
# Usage: automation/verify-branch-protection.sh [owner/repo] [branch]
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
branch="${2:-main}"

if ! prot="$(gh api "repos/$repo/branches/$branch/protection" 2>/dev/null)"; then
  echo "FAIL: $branch is NOT protected. Run automation/set-branch-protection.sh (P10/P11)."
  exit 1
fi

fail=0
reviews="$(jq -r '.required_pull_request_reviews.required_approving_review_count // 0' <<<"$prot")"
strict="$(jq -r '.required_status_checks.strict // false' <<<"$prot")"
force="$(jq -r '.allow_force_pushes.enabled // false' <<<"$prot")"
checks="$(jq -r '([.required_status_checks.contexts[]?] + [.required_status_checks.checks[]?.context])[]?' <<<"$prot" | sort -u)"

[ "${reviews:-0}" -ge 1 ] || { echo "FAIL: no required approving review (P10 independent review)"; fail=1; }
[ "$strict" = "true" ]   || { echo "WARN: required_status_checks.strict is off (P11 up-to-date-before-merge)"; }
[ -n "$checks" ]          || { echo "FAIL: no required status checks configured (P10/P11)"; fail=1; }
if [ -n "$checks" ] && ! grep -Eq '(^standard-guard$|^guard$|standard-guard.*guard|guard.*standard-guard)' <<<"$checks"; then
  echo "FAIL: standard-guard is not a required status check (P10/P11)"
  fail=1
fi
[ "$force" = "false" ]   || { echo "FAIL: force pushes allowed on $branch (P12)"; fail=1; }

[ "$fail" -ne 0 ] && exit 1
echo "branch protection: OK"
