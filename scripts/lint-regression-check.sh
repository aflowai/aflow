#!/bin/bash
# Fails if there are any lint errors, or if total problems exceed baseline.
# Zero errors required (Plan 56 complete). Baseline prevents warning regressions.
# Update baseline after intentional warning changes: echo <new_count> > .lint-baseline
set -euo pipefail

OUTPUT=$(NODE_OPTIONS=--max-old-space-size=8192 npx eslint . 2>&1) || true
echo "$OUTPUT"

ERRORS=$(echo "$OUTPUT" | grep -oE '[0-9]+ errors?' | head -1 | grep -oE '^[0-9]+' || echo 0)
CURRENT=$(echo "$OUTPUT" | grep -oE '[0-9]+ problems' | head -1 | grep -oE '^[0-9]+' || echo 99999)
BASELINE=$(cat .lint-baseline 2>/dev/null || echo 99999)

echo ""
echo "Summary: $ERRORS errors | $CURRENT total problems (baseline: $BASELINE)"

if [ "$ERRORS" -gt 0 ]; then
  echo "❌ FAIL: $ERRORS lint error(s) — zero required"
  exit 1
fi

if [ "$CURRENT" -gt "$BASELINE" ]; then
  echo "❌ FAIL: Lint problems increased from $BASELINE → $CURRENT"
  exit 1
fi
echo "✅ OK: 0 errors, $CURRENT ≤ $BASELINE problems"
