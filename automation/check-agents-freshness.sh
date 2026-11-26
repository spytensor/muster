#!/usr/bin/env bash
# Guard against silent drift in governance files (Standard P9).
# Checks AGENTS.md (release tag, tracker open) AND architecture.md (Last reviewed),
# and walks nested AGENTS.md files. Distinguishes "can't verify" from "drift".
# Usage: automation/check-agents-freshness.sh [path-to-AGENTS.md]
# Env:   ARCH_REVIEW_MAX_DAYS (default 180)
# Requires: git; gh (authenticated) for the tracker check.
set -euo pipefail

agents="${1:-AGENTS.md}"
[ -f "$agents" ] || { echo "no $agents found"; exit 1; }
fail=0
warn=0

# 1) Release tag line must match the latest git tag, if both exist.
declared_tag="$(grep -iE '^Latest release tag:' "$agents" | sed -E 's/.*: *//; s/\.$//' | tr -d ' ' || true)"
latest_tag="$(git tag --sort=-creatordate | head -n1 || true)"
if [ -n "$latest_tag" ] && [ -n "$declared_tag" ] && [ "$declared_tag" != "none" ] && [ "$declared_tag" != "$latest_tag" ]; then
  echo "DRIFT: AGENTS.md says release '$declared_tag' but latest git tag is '$latest_tag'"
  fail=1
fi

# 2) If an active tracker is named, it must be an OPEN issue.
#    A gh failure is "can't verify" (warn), NOT drift (fail).
tracker="$(grep -iE '^Primary tracker:' "$agents" | sed -E 's/.*: *//; s/\.$//' | tr -d ' #' || true)"
if [ -n "$tracker" ] && [ "$tracker" != "none" ] && command -v gh >/dev/null 2>&1; then
  if state="$(gh issue view "$tracker" --json state -q .state 2>/dev/null)"; then
    if [ "$state" != "OPEN" ]; then
      echo "DRIFT: AGENTS.md Primary tracker #$tracker is '$state' (expected OPEN)"
      fail=1
    fi
  else
    echo "WARN: could not verify tracker #$tracker (gh error / rate limit). Not treating as drift."
    warn=1
  fi
fi

# 3) architecture.md must have been reviewed within the window.
arch="$(dirname "$agents")/docs/architecture.md"
[ -f "$arch" ] || arch="docs/architecture.md"
max_days="${ARCH_REVIEW_MAX_DAYS:-180}"
if [ -f "$arch" ]; then
  reviewed="$(grep -ioE 'Last reviewed: *[0-9]{4}-[0-9]{2}-[0-9]{2}' "$arch" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -n1 || true)"
  if [ -n "$reviewed" ]; then
    # portable epoch diff (GNU vs BSD date)
    if r_epoch="$(date -d "$reviewed" +%s 2>/dev/null || date -j -f %Y-%m-%d "$reviewed" +%s 2>/dev/null)"; then
      now_epoch="$(date +%s)"
      age_days=$(( (now_epoch - r_epoch) / 86400 ))
      if [ "$age_days" -gt "$max_days" ]; then
        echo "DRIFT: docs/architecture.md last reviewed $reviewed ($age_days days ago > $max_days). Re-validate locked decisions (P9)."
        fail=1
      fi
    fi
  fi
fi

# 4) Walk nested AGENTS.md (informational): each should carry a Last aligned date.
while IFS= read -r nested; do
  [ "$nested" = "$agents" ] && continue
  if ! grep -qiE '^Last aligned:' "$nested"; then
    echo "WARN: nested $nested has no 'Last aligned:' line"
    warn=1
  fi
done < <(git ls-files '**/AGENTS.md' 'AGENTS.md' 2>/dev/null || true)

if [ "$fail" -ne 0 ]; then
  echo "Governance files are stale. Propose the exact fix before other work (Standard P9)."
  exit 1
fi
[ "$warn" -ne 0 ] && echo "freshness: OK (with warnings)" || echo "freshness: OK"
exit 0
