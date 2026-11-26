#!/usr/bin/env bash
# Guard that a PR body carries REAL evidence, not just section headers (Standard P2/P10).
# Usage: automation/check-pr-evidence.sh <pr-number-or-url>
#    or: BODY_FILE=body.md automation/check-pr-evidence.sh   (check a file directly)
# Requires: gh (authenticated) when given a PR number.
set -euo pipefail

repo_from_pr_ref() {
  case "$1" in
    https://github.com/*/*/pull/*)
      sed -nE 's#^https://github.com/([^/]+/[^/]+)/pull/[0-9]+.*#\1#p' <<<"$1"
      ;;
    *)
      gh repo view --json nameWithOwner -q .nameWithOwner
      ;;
  esac
}

if [ -n "${BODY_FILE:-}" ]; then
  body="$(cat "$BODY_FILE")"
  is_template=1   # a raw template file is allowed to have empty sections
  pr_number=""
  repo=""
else
  pr="${1:?usage: check-pr-evidence.sh <pr-number-or-url>}"
  repo="$(repo_from_pr_ref "$pr")"
  pr_number="$(gh pr view "$pr" --repo "$repo" --json number -q .number)"
  body="$(gh pr view "$pr" --repo "$repo" --json body -q .body)"
  is_template=0
fi

tracker_issue_from_body() {
  grep -iE '^[[:space:]]*[-*]?[[:space:]]*Tracker issue:' <<<"$1" \
    | sed -nE 's/.*#([0-9]+).*/\1/p' \
    | head -n1
}

ledger_comment_id_for_pr() {
  local repo_name="$1"
  local tracker="$2"
  local pr_num="$3"

  gh api "repos/$repo_name/issues/$tracker/comments" --paginate \
    --jq ".[] | select(.body | contains(\"LEDGER-ROW\") and test(\"(^|[^0-9])#${pr_num}([^0-9]|$)\")) | .id" \
    | head -n1
}

required=(
  "## Summary"
  "## Governance tier"
  "## Linked issues"
  "## Acceptance criteria"
  "## Test plan"
  "## Evidence packet"
  "## Tracker update"
)

fail=0
for section in "${required[@]}"; do
  if ! grep -qF "$section" <<<"$body"; then
    echo "MISSING section: $section"
    fail=1
  fi
done

# Content checks only apply to a real PR (templates legitimately have empty sections).
if [ "$is_template" -eq 0 ]; then
  tier="$(grep -iE '^\- \[x\].*Tier 1|^\- \[x\].*Tier 2|^Selected tier/lane:.*Tier 1|^Selected tier/lane:.*Tier 2' <<<"$body" || true)"

  # At least one path:line citation somewhere (P2).
  if ! grep -qE '\b[A-Za-z0-9_./-]+:[0-9]+\b' <<<"$body"; then
    echo "MISSING: no path:line citation in the PR body (P2)"
    fail=1
  fi

  # Evidence packet must contain a fenced block or a CI run link (P10), not just prose.
  if ! grep -qE '```|https?://[^ ]+/(actions|runs)/' <<<"$body"; then
    echo "WEAK: Evidence packet has no fenced output block or CI run link (P10)"
    fail=1
  fi

  # Tier 1+ must name an independent reviewer (P10).
  if [ -n "$tier" ] && ! grep -qiE 'reviewer.*(≠|!=|other than|not the implementer)|cross_model' <<<"$body"; then
    echo "MISSING: Tier 1+ PR does not record an independent reviewer (P10)"
    fail=1
  fi

  # Completion language without a tracker-evidence line is a hard fail for Tier 1+.
  if grep -qiE '\b(done|complete|finished)\b' <<<"$body" \
     && ! grep -qiF "Evidence Ledger row appended" <<<"$body" \
     && ! grep -qiF "implementation complete, tracker incomplete" <<<"$body"; then
    if [ -n "$tier" ]; then
      echo "FAIL: completion language without a tracker-evidence line (P2). Do not infer completion from prose."
      fail=1
    else
      echo "WARN: completion language without a tracker-evidence line."
    fi
  fi

  if grep -qiE '^[[:space:]]*-[[:space:]]*Evidence Ledger row appended:[[:space:]]*yes\b' <<<"$body"; then
    tracker="$(tracker_issue_from_body "$body" || true)"
    if [ -z "$tracker" ]; then
      echo "FAIL: Evidence Ledger row appended is yes, but Tracker issue does not name a GitHub issue."
      fail=1
    elif [ -z "$(ledger_comment_id_for_pr "$repo" "$tracker" "$pr_number" || true)" ]; then
      echo "FAIL: Evidence Ledger row appended is yes, but tracker #$tracker has no LEDGER-ROW comment referencing PR #$pr_number."
      fail=1
    fi
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "PR evidence is incomplete (use PULL_REQUEST_TEMPLATE.md; see Standard P2/P10)."
  exit 1
fi
echo "PR evidence: OK"
