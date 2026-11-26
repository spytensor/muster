#!/usr/bin/env bash
# Configure branch protection on main to actually enforce the standard (P10/P11/P12).
# Without this, every guard is optional theatre. Owner must run it (needs admin).
# Usage: automation/set-branch-protection.sh [owner/repo] [branch]
# Env: REQUIRED_CHECKS (comma-separated contexts, default "standard-guard")
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
branch="${2:-main}"
IFS=',' read -ra checks <<<"${REQUIRED_CHECKS:-standard-guard}"
contexts_json="$(printf '%s\n' "${checks[@]}" | jq -R . | jq -s .)"

echo "applying branch protection to $repo@$branch (required checks: ${checks[*]})"

gh api -X PUT "repos/$repo/branches/$branch/protection" \
  --input - <<EOF
{
  "required_status_checks": { "strict": true, "contexts": $contexts_json },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF

echo "branch protection set. 'strict' = require up-to-date before merge (P11 integration)."
