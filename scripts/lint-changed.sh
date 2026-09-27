#!/usr/bin/env bash
# Lint only files changed in the current branch vs main.
# Useful for quick checks before pushing.
set -euo pipefail

BASE="${1:-main}"
if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  BASE="origin/main"
  if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
    echo "Could not find base ref 'main' or 'origin/main'. Pass a branch as first arg, e.g. ./scripts/lint-changed.sh develop"
    exit 1
  fi
fi

FILES=$(git diff --name-only "$BASE"...HEAD 2>/dev/null | grep -E '\.(ts|tsx)$' || true)
if [ -z "$FILES" ]; then
  echo "No .ts/.tsx files changed vs $BASE"
  exit 0
fi

echo "Linting changed files vs $BASE:"
echo "$FILES" | sed 's/^/  /'
echo
export NODE_OPTIONS=--max-old-space-size=8192
echo "$FILES" | xargs npx eslint --cache
