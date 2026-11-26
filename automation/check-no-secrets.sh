#!/usr/bin/env bash
# Scan the diff AND the PR body for secrets (Standard P12). The evidence packet
# (pasted command output) is a real exfiltration vector — scan it too.
# Usage: automation/check-no-secrets.sh <base-ref> [pr-number-or-url]
# Uses gitleaks if installed; otherwise a conservative built-in regex fallback.
set -euo pipefail

base="${1:?usage: check-no-secrets.sh <base-ref> [pr]}"
pr="${2:-}"
fail=0

scan_text() {  # $1=label  $2=text
  local label="$1" text="$2"
  # High-confidence patterns; conservative to limit false positives.
  local hits
  hits="$(grep -nEi \
    -e 'AKIA[0-9A-Z]{16}' \
    -e 'ghp_[0-9A-Za-z]{36}' \
    -e 'github_pat_[0-9A-Za-z_]{22,}' \
    -e 'xox[baprs]-[0-9A-Za-z-]{10,}' \
    -e 'sk-[A-Za-z0-9]{20,}' \
    -e 'AIza[0-9A-Za-z_\-]{35}' \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e '(api[_-]?key|secret|token|password|passwd)["'"'"' :=]+[0-9A-Za-z/+_\-]{16,}' \
    <<<"$text" || true)"
  if [ -n "$hits" ]; then
    echo "SECRET in $label:"
    while IFS= read -r line; do
      printf '    %s\n' "$line"
    done <<<"$hits"
    fail=1
  fi
}

if command -v gitleaks >/dev/null 2>&1; then
  echo "scanning diff with gitleaks..."
  if ! gitleaks protect --staged --no-banner 2>/dev/null && ! gitleaks detect --no-banner --log-opts "$base..HEAD" 2>/dev/null; then
    echo "SECRET: gitleaks reported findings in the diff."
    fail=1
  fi
else
  echo "gitleaks not installed — using built-in regex fallback (less thorough)."
  scan_text "diff" "$(git diff "$base"...HEAD)"
fi

if [ -n "$pr" ] && command -v gh >/dev/null 2>&1; then
  scan_text "PR body" "$(gh pr view "$pr" --json body -q .body 2>/dev/null || true)"
fi

[ "$fail" -ne 0 ] && { echo "Secret material detected. Never paste secrets into code or PRs (P12)."; exit 1; }
echo "secret scan: OK"
