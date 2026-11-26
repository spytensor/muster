#!/usr/bin/env bash
# Sanity-check the PR's declared tier against the actual diff (Standard P6/P8).
# Stops an agent self-downgrading a large change to skip gates.
# Usage: automation/check-tier.sh <base-ref> [pr-number-or-url]
#   base-ref e.g. origin/main. If pr given, reads declared tier from its body.
# Env: TIER0_MAX_LINES (default 50), CONCERN_MAX_DIRS (default 4)
set -euo pipefail

base="${1:?usage: check-tier.sh <base-ref> [pr]}"
pr="${2:-}"
tier0_max="${TIER0_MAX_LINES:-50}"
concern_max="${CONCERN_MAX_DIRS:-4}"

changed="$(git diff --name-only "$base"...HEAD)"
[ -z "$changed" ] && { echo "no changes vs $base"; exit 0; }
lines="$(git diff --shortstat "$base"...HEAD | grep -oE '[0-9]+ insertion|[0-9]+ deletion' | grep -oE '[0-9]+' | paste -sd+ - | bc 2>/dev/null || echo 0)"

# Heuristic: does the diff touch non-doc/non-comment code?
code_touched=0
while IFS= read -r f; do
  case "$f" in
    *.md|*.txt|docs/*|*/docs/*|LICENSE|.gitignore) : ;;
    "") : ;;
    *) code_touched=1 ;;
  esac
done <<<"$changed"

# Sensitive paths that force Tier 1 regardless of size.
sensitive="$(grep -iE 'migrat|auth|secret|crypto|payment|/security|package(-lock)?\.json|requirements|Cargo\.lock|go\.mod|yarn\.lock|pnpm-lock' <<<"$changed" || true)"

top_dirs="$(awk -F/ '{print $1}' <<<"$changed" | sort -u | grep -c . || echo 0)"

declared=""
if [ -n "$pr" ] && command -v gh >/dev/null 2>&1; then
  pb="$(gh pr view "$pr" --json body -q .body 2>/dev/null || true)"
  grep -qiE '^\- \[x\].*Tier 0' <<<"$pb" && declared="tier0"
  grep -qiE '^\- \[x\].*Tier 1' <<<"$pb" && declared="tier1"
  grep -qiE '^\- \[x\].*Tier 2' <<<"$pb" && declared="tier2"
  grep -qiE '^\- \[x\].*Codemod' <<<"$pb" && declared="codemod"
  grep -qiE '^\- \[x\].*Hotfix'  <<<"$pb" && declared="hotfix"
  grep -qiE '^Selected tier/lane:.*Tier 0' <<<"$pb" && declared="tier0"
  grep -qiE '^Selected tier/lane:.*Tier 1' <<<"$pb" && declared="tier1"
  grep -qiE '^Selected tier/lane:.*Tier 2' <<<"$pb" && declared="tier2"
  grep -qiE '^Selected tier/lane:.*Codemod' <<<"$pb" && declared="codemod"
  grep -qiE '^Selected tier/lane:.*Hotfix'  <<<"$pb" && declared="hotfix"
fi

fail=0
echo "diff: $lines lines, $top_dirs top-level dirs, code_touched=$code_touched, declared=${declared:-<none>}"

if [ "$declared" = "tier0" ]; then
  if [ "$code_touched" -eq 1 ]; then
    echo "FAIL: declared Tier 0 but the diff changes code (not docs/comments). Re-classify."
    fail=1
  fi
  if [ "${lines:-0}" -gt "$tier0_max" ]; then
    echo "FAIL: declared Tier 0 but diff is $lines lines (> $tier0_max). Re-classify."
    fail=1
  fi
fi

if [ -n "$sensitive" ] && [ "$declared" = "tier0" ]; then
  echo "FAIL: touches sensitive paths but declared Tier 0 (route via security gate):"
  while IFS= read -r line; do
    printf '  %s\n' "$line"
  done <<<"$sensitive"
  fail=1
fi

if [ "$declared" != "codemod" ] && [ "$top_dirs" -gt "$concern_max" ]; then
  echo "WARN: touches $top_dirs top-level dirs (> $concern_max). Confirm one-concern-per-PR (P6) or use the codemod lane."
fi

# Mixing constitution docs with code is forbidden unless allowed (P5/P6).
if grep -qE '(^|/)docs/architecture\.md$' <<<"$changed" && [ "$code_touched" -eq 1 ]; then
  echo "FAIL: mixes docs/architecture.md (constitution) with code changes (P5/P6). Split the PR."
  fail=1
fi

[ "$fail" -ne 0 ] && exit 1
echo "tier check: OK"
