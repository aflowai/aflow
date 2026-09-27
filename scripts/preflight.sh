#!/usr/bin/env bash
# preflight.sh — run all quality checks and print a summary
# Usage: ./scripts/preflight.sh [--no-test] [--no-lint]
#
# Flags:
#   --no-test   skip yarn test (useful when infra is not running)
#   --no-lint   skip advisory lint check
#
# Every step reports its own elapsed time, because "preflight is slow" is not
# actionable until you can see which step owns the minutes.
#
# Exit code: 0 if all BLOCKING checks pass, 1 otherwise

set -uo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' CYAN='' RESET=''
fi

PASS="${GREEN}✓ pass${RESET}"
FAIL="${RED}✗ fail${RESET}"
WARN="${YELLOW}⚠ warn${RESET}"
SKIP="${DIM}– skip${RESET}"

# ── flags ────────────────────────────────────────────────────────────────────
RUN_TEST=1
RUN_LINT=1
for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TEST=0 ;;
    --no-lint) RUN_LINT=0 ;;
  esac
done

# ── helpers ──────────────────────────────────────────────────────────────────
LOG_DIR=$(mktemp -d)
trap 'rm -rf "$LOG_DIR"' EXIT

# Step durations go to a file, not a shell array: every caller invokes
# run_check inside `$( )`, and a subshell's array assignments never reach the
# parent — the timings would silently come back empty.
run_check() {
  local name="$1"
  local log="$LOG_DIR/$name.log"
  shift
  local start
  start=$(date +%s)
  local rc=0
  "$@" >"$log" 2>&1 || rc=1
  echo "$(( $(date +%s) - start ))" >"$LOG_DIR/$name.secs"
  echo "$rc"
}

elapsed_for() {
  local f="$LOG_DIR/$1.secs"
  [ -s "$f" ] || return 0
  local s
  s=$(cat "$f")
  if [ "$s" -ge 60 ]; then
    echo "$(( s / 60 ))m$(( s % 60 ))s"
  else
    echo "${s}s"
  fi
}

print_header() {
  echo
  echo -e "${BOLD}${CYAN}Phoenix preflight checks${RESET}"
  echo -e "${DIM}$(date '+%Y-%m-%d %H:%M:%S')${RESET}"
  echo
}

print_running() {
  printf "  %-22s %s\n" "$1" "running…"
}

print_result_line() {
  local label="$1"
  local status="$2"   # pass | fail | warn | skip
  local note="$3"
  local icon
  case "$status" in
    pass) icon="$PASS" ;;
    fail) icon="$FAIL" ;;
    warn) icon="$WARN" ;;
    skip) icon="$SKIP" ;;
  esac
  printf "  %-22s %b  %s\n" "$label" "$icon" "$note"
}

show_log() {
  local name="$1"
  local log="$LOG_DIR/$name.log"
  if [ -s "$log" ]; then
    echo
    echo -e "  ${DIM}── $name output ──────────────────────────────${RESET}"
    sed 's/^/  /' "$log" | tail -40
    echo -e "  ${DIM}───────────────────────────────────────────────${RESET}"
  fi
}

# ── results arrays (bash 3 compatible) ───────────────────────────────────────
# We track: name, status (pass/fail/warn/skip), note, blocking (1/0)
RESULT_NAMES=()
RESULT_STATUSES=()
RESULT_NOTES=()
RESULT_BLOCKING=()

record() {
  RESULT_NAMES+=("$1")
  RESULT_STATUSES+=("$2")
  RESULT_NOTES+=("$3")
  RESULT_BLOCKING+=("$4")
}

# ── run checks ───────────────────────────────────────────────────────────────
print_header

# 1. Format — auto-fix, then report whether files were changed
printf "  %-22s" "format"
printf " fixing…\r"
run_check "format" yarn format > /dev/null
CHANGED=$(git diff --name-only 2>/dev/null | grep -v "^$" || true)
if [ -z "$CHANGED" ]; then
  record "format" "pass" "$(elapsed_for format)" 1
else
  FILES=$(echo "$CHANGED" | wc -l | tr -d ' ')
  record "format" "warn" "auto-fixed $FILES file(s) — stage and commit the changes" 0
fi

# 2. Build
printf "  %-22s" "build"
printf " building…\r"
RC=$(run_check "build" yarn build)
if [ "$RC" = "0" ]; then
  record "build" "pass" "$(elapsed_for build)" 1
else
  record "build" "fail" "see output below ($(elapsed_for build))" 1
fi

# 3. Typecheck
printf "  %-22s" "typecheck"
printf " typechecking…\r"
RC=$(run_check "typecheck" yarn typecheck)
if [ "$RC" = "0" ]; then
  record "typecheck" "pass" "$(elapsed_for typecheck)" 1
else
  record "typecheck" "fail" "see output below ($(elapsed_for typecheck))" 1
fi

# 4. Test — the root runner owns one bounded Vitest worker pool and serializes
#    competing runs from sibling worktrees. Do not add workspace-level
#    concurrency here; that would multiply independent worker pools again.
if [ "$RUN_TEST" = "1" ]; then
  printf "  %-22s" "test"
  printf " running tests…\r"
  RC=$(run_check "test" yarn test)
  if [ "$RC" = "0" ]; then
    record "test" "pass" "$(elapsed_for test)" 1
  else
    record "test" "fail" "see output below ($(elapsed_for test))" 1
  fi
else
  record "test" "skip" "--no-test" 1
fi

# 5. Lint — ONE pass, and it must be `yarn lint`, not `yarn lint:fix`.
#    `lint:fix` is a single `eslint .` process that OOMs on this repo even at
#    8 GB; `yarn lint` walks the same files per target with bounded
#    concurrency, which is exactly why it exists. Running the monolithic one
#    made preflight report "0 issues" from a V8 crash dump and pass — a lint
#    step that fails OPEN is worse than no lint step. Auto-fix stays a
#    deliberate, separate `yarn lint:fix`.
if [ "$RUN_LINT" = "1" ]; then
  printf "  %-22s" "lint (advisory)"
  printf " linting…\r"
  RC=$(run_check "lint" yarn lint)
  # `grep -c` prints 0 AND exits 1 on no match, so a `||` fallback here
  # appends a second line and mangles the note.
  WARN_COUNT=$(grep -cE "warning|error" "$LOG_DIR/lint.log" 2>/dev/null | head -1)
  [ -n "$WARN_COUNT" ] || WARN_COUNT=0
  if [ "$RC" = "0" ]; then
    record "lint (advisory)" "pass" "$(elapsed_for lint)" 0
  elif [ "$WARN_COUNT" = "0" ]; then
    # Non-zero exit with nothing to report means it never finished — say so
    # rather than presenting a crash as a clean sheet.
    record "lint (advisory)" "warn" "did not complete — see log ($(elapsed_for lint))" 0
  else
    record "lint (advisory)" "warn" "$WARN_COUNT issues — advisory, does not block ($(elapsed_for lint))" 0
  fi
else
  record "lint (advisory)" "skip" "--no-lint" 0
fi

# ── print summary ─────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}Results${RESET}"
echo -e "  ${DIM}────────────────────────────────────────────────${RESET}"

BLOCKING_FAILED=0
i=0
while [ $i -lt ${#RESULT_NAMES[@]} ]; do
  name="${RESULT_NAMES[$i]}"
  status="${RESULT_STATUSES[$i]}"
  note="${RESULT_NOTES[$i]}"
  blocking="${RESULT_BLOCKING[$i]}"

  print_result_line "$name" "$status" "$note"

  if [ "$status" = "fail" ] && [ "$blocking" = "1" ]; then
    BLOCKING_FAILED=1
  fi

  i=$((i + 1))
done

echo -e "  ${DIM}────────────────────────────────────────────────${RESET}"

# ── show logs for failed blocking checks ────────────────────────────────────
i=0
while [ $i -lt ${#RESULT_NAMES[@]} ]; do
  name="${RESULT_NAMES[$i]}"
  status="${RESULT_STATUSES[$i]}"
  blocking="${RESULT_BLOCKING[$i]}"

  if [ "$status" = "fail" ] && [ "$blocking" = "1" ]; then
    show_log "$name"
  fi

  i=$((i + 1))
done

# ── lint log if warnings (advisory) ─────────────────────────────────────────
i=0
while [ $i -lt ${#RESULT_NAMES[@]} ]; do
  name="${RESULT_NAMES[$i]}"
  status="${RESULT_STATUSES[$i]}"
  blocking="${RESULT_BLOCKING[$i]}"

  # Only the lint row owns the lint log — keying on "any advisory warning"
  # printed it again for a format warning, with nothing in it.
  if [ "$name" = "lint (advisory)" ] && [ "$status" = "warn" ]; then
    ISSUES=$(grep -E "warning|error" "$LOG_DIR/lint.log" 2>/dev/null | head -20 || true)
    if [ -n "$ISSUES" ]; then
      echo
      echo -e "  ${DIM}── lint (first 20 issues) ───────────────────────${RESET}"
      echo "$ISSUES" | sed 's/^/  /'
      echo -e "  ${DIM}───────────────────────────────────────────────────${RESET}"
    fi
  fi

  i=$((i + 1))
done

# ── verdict ──────────────────────────────────────────────────────────────────
echo
if [ "$BLOCKING_FAILED" = "1" ]; then
  echo -e "  ${BOLD}${RED}✗  Preflight failed${RESET} — fix the errors above before opening a PR."
  echo
  exit 1
else
  echo -e "  ${BOLD}${GREEN}✓  Preflight passed${RESET} — safe to push and open a PR."
  echo
  exit 0
fi
