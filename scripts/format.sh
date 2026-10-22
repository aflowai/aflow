#!/usr/bin/env bash
# Run Prettier on the repo: only print paths that were reformatted (not unchanged files),
# then print a one-line count summary on stderr.
#
# Nothing is written outside the checkout and nothing is opened by path: the sandbox a
# coding agent runs in may refuse both the temporary directory and `/dev/fd/N`, so the
# paths are counted as they stream past, through descriptors the shell duplicates.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Running Prettier…" >&2
exec 3>&1
# --list-different + --write: print only files Prettier actually rewrote (see prettier#15480).
N=$(
  yarn exec prettier . --write --list-different | {
    count=0
    while IFS= read -r path; do
      printf '%s\n' "$path" >&3
      count=$((count + 1))
    done
    echo "$count"
  }
)
exec 3>&-

echo "" >&2
echo "Prettier: ${N} file(s) reformatted." >&2
