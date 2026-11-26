#!/usr/bin/env bash
# Flag test tampering: deleted/weakened/skipped tests or blind snapshot updates,
# done to make CI green (Standard P10). Fails unless the PR justifies it.
# Usage: automation/check-test-integrity.sh <base-ref> [pr-number-or-url]
# Heuristic and language-agnostic; tune TEST_GLOB for your project.
set -euo pipefail

base="${1:?usage: check-test-integrity.sh <base-ref> [pr]}"
pr="${2:-}"
# Match common test file conventions.
test_re='(^|/)(test_|.*_test\.|.*\.test\.|.*\.spec\.|tests?/)'

changed="$(git diff --name-only "$base"...HEAD | grep -iE "$test_re" || true)"
snapshots="$(git diff --name-only "$base"...HEAD | grep -iE '\.snap$|__snapshots__|/snapshots/' || true)"

flags=0
notes=()

indent() {
  while IFS= read -r line; do
    printf '    %s\n' "$line"
  done
}

# 1) Net-removed test lines or whole test files deleted.
if [ -n "$changed" ]; then
  changed_files=()
  while IFS= read -r file; do
    [ -n "$file" ] && changed_files+=("$file")
  done <<<"$changed"
  removed="$(git diff --numstat "$base"...HEAD -- "${changed_files[@]}" | awk '{del+=$2; add+=$1} END{print (del+0)-(add+0)}')"
  deleted_files="$(git diff --diff-filter=D --name-only "$base"...HEAD | grep -iE "$test_re" || true)"
  if [ -n "$deleted_files" ]; then
    notes+=("test files DELETED:"); notes+=("$(indent <<<"$deleted_files")"); flags=1
  fi
  if [ "${removed:-0}" -gt 0 ]; then
    notes+=("net $removed test lines removed across changed test files"); flags=1
  fi
  # 2) Added skip/xfail/only markers (weakening).
  added_skips="$(git diff "$base"...HEAD -- "${changed_files[@]}" | grep -E '^\+' | grep -ciE '\b(skip|xfail|it\.skip|test\.skip|@pytest\.mark\.skip|#\[ignore\]|describe\.only|\.only\()' || true)"
  if [ "${added_skips:-0}" -gt 0 ]; then
    notes+=("$added_skips added skip/xfail/only marker(s)"); flags=1
  fi
fi

# 3) Snapshot files updated.
if [ -n "$snapshots" ]; then
  notes+=("snapshot files updated:"); notes+=("$(indent <<<"$snapshots")"); flags=1
fi

[ "$flags" -eq 0 ] && { echo "test integrity: OK"; exit 0; }

echo "TEST-INTEGRITY: potential test tampering detected (Standard P10):"
printf '  - %s\n' "${notes[@]}"

# Allow if the PR explicitly justifies the test change.
if [ -n "$pr" ] && command -v gh >/dev/null 2>&1; then
  pb="$(gh pr view "$pr" --json body -q .body 2>/dev/null || true)"
  if grep -qiE 'Test changes justification:.*\S' <<<"$pb" \
     || grep -qiE 'tests? (changed|removed|updated).*(because|reason|justif)' <<<"$pb"; then
    echo "ALLOWED: PR provides a test-change justification."
    exit 0
  fi
fi

echo "Provide a 'Test changes justification' in the PR (and prefer a separate test PR), or restore the tests."
exit 1
