#!/bin/bash
# Dumps the by-rule error breakdown. Run before and after each cleanup session.
set -euo pipefail
echo "=== Lint Progress Report $(date +%Y-%m-%d) ==="
NODE_OPTIONS=--max-old-space-size=8192 npx eslint . 2>&1 | \
  awk '{match($0, /@typescript-eslint\/[a-z-]+/); if (RLENGTH>0) print substr($0, RSTART, RLENGTH)}' | \
  sort | uniq -c | sort -rn
echo "---"
NODE_OPTIONS=--max-old-space-size=8192 npx eslint . 2>&1 | tail -1
