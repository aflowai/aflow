#!/usr/bin/env bash
# Run Prettier on the repo: only print paths that were reformatted (not unchanged files),
# then print a one-line count summary on stderr.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Running Prettier…" >&2
# --list-different + --write: print only files Prettier actually rewrote (see prettier#15480).
yarn exec prettier . --write --list-different | tee "$TMP"

if [[ ! -s "$TMP" ]]; then
  N=0
else
  N=$(wc -l <"$TMP" | tr -d ' ')
fi

echo "" >&2
echo "Prettier: ${N} file(s) reformatted." >&2
