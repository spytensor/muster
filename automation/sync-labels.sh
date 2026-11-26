#!/usr/bin/env bash
# Create/update the canonical label set in a target repo.
# Usage: automation/sync-labels.sh <owner/repo>
# Requires: gh (authenticated), and labels.yml next to this script.
set -euo pipefail

repo="${1:?usage: sync-labels.sh <owner/repo>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
labels="$here/labels.yml"

# Minimal YAML reader for the fixed shape in labels.yml (- name:/color:/description:).
name="" color="" desc=""
flush() {
  [ -z "$name" ] && return 0
  echo "syncing: $name"
  gh label create "$name" --repo "$repo" --color "$color" --description "$desc" --force >/dev/null
  name="" color="" desc=""
}

while IFS= read -r line; do
  case "$line" in
    "- name: "*) flush; name="$(sed -E 's/^- name: *"?([^"]*)"?/\1/' <<<"$line")" ;;
    *"color: "*) color="$(sed -E 's/^ *color: *"?([^"]*)"?/\1/' <<<"$line")" ;;
    *"description: "*) desc="$(sed -E 's/^ *description: *"?([^"]*)"?/\1/' <<<"$line")" ;;
  esac
done < "$labels"
flush

echo "done: labels synced to $repo"
