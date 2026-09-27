#!/usr/bin/env bash
#
# Test flow execution via the API.
# Usage:
#   ./scripts/test-flows.sh                  # Run all tests
#   ./scripts/test-flows.sh hello            # Run just the hello test
#   ./scripts/test-flows.sh inline-ai        # Run inline AI test
#
# Prerequisites:
#   - Server running: yarn start
#   - AI keys configured in .env (for AI tests)
#
set -euo pipefail

API="http://localhost:3000/v1"
TENANT="a0000000-0000-0000-0000-000000000001"
HEADERS=(-H "Content-Type: application/json" -H "X-Tenant-ID: $TENANT")

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[test]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# ---------------------------------------------------------------------------
# Helper: start a run and poll for completion
# ---------------------------------------------------------------------------
run_and_wait() {
  local test_name="$1"
  local body="$2"
  local timeout="${3:-30}"

  log "Starting: $test_name"

  # Start run
  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$API/runs" "${HEADERS[@]}" -d "$body")
  local http_code
  http_code=$(echo "$response" | tail -1)
  local json
  # macOS head doesn't support -n -1; use sed to drop last line instead
  json=$(echo "$response" | sed '$d')

  if [[ "$http_code" != "201" ]]; then
    fail "$test_name — POST /runs returned $http_code"
    echo "  Response: $json"
    return 1
  fi

  local run_id
  run_id=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('runId',''))" 2>/dev/null || echo "")
  local status
  status=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

  if [[ -z "$run_id" ]]; then
    fail "$test_name — no runId in response"
    echo "  Response: $json"
    return 1
  fi

  log "  Run started: $run_id (status: $status)"

  # Poll events for terminal status
  local elapsed=0
  local final_status=""
  while [[ $elapsed -lt $timeout ]]; do
    sleep 2
    elapsed=$((elapsed + 2))

    local events
    events=$(curl -s "$API/runs/$run_id/events" "${HEADERS[@]}" -H "Accept: text/event-stream" --max-time 3 2>/dev/null || echo "")

    # Check for terminal events
    if echo "$events" | grep -q "FlowRunSucceeded"; then
      final_status="SUCCEEDED"
      break
    elif echo "$events" | grep -q "FlowRunFailed"; then
      final_status="FAILED"
      break
    elif echo "$events" | grep -q "FlowRunStalled"; then
      final_status="STALLED"
      break
    fi

    log "  Waiting... (${elapsed}s / ${timeout}s)"
  done

  if [[ -z "$final_status" ]]; then
    warn "$test_name — timed out after ${timeout}s (run $run_id)"
    return 1
  fi

  if [[ "$final_status" == "SUCCEEDED" ]]; then
    pass "$test_name — $final_status (${elapsed}s)"
    # Show output if present
    local output_line
    output_line=$(echo "$events" | grep "outputVariables" | tail -1 || echo "")
    if [[ -n "$output_line" ]]; then
      log "  Output: $(echo "$output_line" | head -c 200)"
    fi
    return 0
  else
    fail "$test_name — $final_status (${elapsed}s)"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Test: inline single-step AI chat
# ---------------------------------------------------------------------------
test_inline_ai() {
  run_and_wait "Inline AI generate" '{
    "flowConfig": {
      "name": "test-inline-ai",
      "steps": [
        {
          "stepId": "chat",
          "type": "ai",
          "operation": "ai.generate",
          "config": {
            "model": "gpt-4o-mini",
            "systemPrompt": "Reply with exactly: Hello from Phoenix!"
          }
        }
      ]
    },
    "input": { "prompt": "Hi there!" }
  }' 30
}

# ---------------------------------------------------------------------------
# Test: inline API call (httpbin)
# ---------------------------------------------------------------------------
test_inline_api() {
  run_and_wait "Inline API call (httpbin)" '{
    "flowConfig": {
      "name": "test-inline-api",
      "steps": [
        {
          "stepId": "fetch",
          "type": "api",
          "operation": "api.call",
          "config": {
            "url": "https://httpbin.org/get",
            "method": "GET"
          }
        }
      ]
    },
    "input": {}
  }' 15
}

# ---------------------------------------------------------------------------
# Test: inline multi-step flow (API → AI)
# ---------------------------------------------------------------------------
test_inline_multi() {
  run_and_wait "Inline multi-step (API → AI)" '{
    "flowConfig": {
      "name": "test-multi-step",
      "steps": [
        {
          "stepId": "fetch-joke",
          "type": "api",
          "operation": "api.call",
          "config": {
            "url": "https://official-joke-api.appspot.com/random_joke",
            "method": "GET"
          }
        },
        {
          "stepId": "react",
          "type": "ai",
          "operation": "ai.generate",
          "config": {
            "model": "gpt-4o-mini",
            "systemPrompt": "You receive a joke as JSON. Rate it 1-10 and explain why. Be brief."
          }
        }
      ]
    },
    "input": {}
  }' 30
}

# ---------------------------------------------------------------------------
# Test: agent flow (agent decides to fetch, then completes)
# ---------------------------------------------------------------------------
test_agent() {
  local body
  body=$(cat scripts/test-flows/agent-research.json)
  run_and_wait "Agent research (tool-as-step loop)" "$body" 60
}

# ---------------------------------------------------------------------------
# Test: chat with history (Plan 18)
# ---------------------------------------------------------------------------
test_chat_history() {
  local body
  body=$(cat scripts/test-flows/chat-with-history.json)
  run_and_wait "Chat with history (Plan 18)" "$body" 30
}

# ---------------------------------------------------------------------------
# Test: memory put then get
# ---------------------------------------------------------------------------
test_memory_put_get() {
  local body
  body=$(cat scripts/test-flows/memory-put-get.json)
  run_and_wait "Memory: put then get" "$body" 10
}

# ---------------------------------------------------------------------------
# Test: memory full cycle (put → list → grep → get)
# ---------------------------------------------------------------------------
test_memory_full_cycle() {
  local body
  body=$(cat scripts/test-flows/memory-full-cycle.json)
  run_and_wait "Memory: full cycle (put→list→grep→get)" "$body" 15
}

# ---------------------------------------------------------------------------
# Test: concurrent memory runs (exercises keyed concurrency + DB pool)
# ---------------------------------------------------------------------------
test_concurrent_memory() {
  log "Starting: Concurrent memory (5 parallel runs)"

  local pids=()
  local run_ids=()
  local tmpdir
  tmpdir=$(mktemp -d)

  # Launch 5 memory-put-get runs simultaneously
  for i in 1 2 3 4 5; do
    local body
    body=$(cat scripts/test-flows/memory-put-get.json)
    (
      local response
      response=$(curl -s -w "\n%{http_code}" -X POST "$API/runs" "${HEADERS[@]}" \
        -H "Idempotency-Key: concurrent-test-$i-$(date +%s)" \
        -d "$body")
      local http_code
      http_code=$(echo "$response" | tail -1)
      local json
      json=$(echo "$response" | sed '$d')
      local run_id
      run_id=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('runId',''))" 2>/dev/null || echo "")
      echo "$run_id" > "$tmpdir/run-$i.id"
      echo "$http_code" > "$tmpdir/run-$i.http"
    ) &
    pids+=($!)
  done

  # Wait for all POSTs to complete
  for pid in "${pids[@]}"; do
    wait "$pid"
  done

  # Collect run IDs
  local all_started=true
  for i in 1 2 3 4 5; do
    local http_code
    http_code=$(cat "$tmpdir/run-$i.http" 2>/dev/null || echo "0")
    local run_id
    run_id=$(cat "$tmpdir/run-$i.id" 2>/dev/null || echo "")
    if [[ "$http_code" != "201" || -z "$run_id" ]]; then
      fail "Concurrent memory — run $i failed to start (HTTP $http_code)"
      all_started=false
    else
      run_ids+=("$run_id")
      log "  Run $i started: $run_id"
    fi
  done

  if [[ "$all_started" != "true" ]]; then
    rm -rf "$tmpdir"
    return 1
  fi

  # Poll all runs for completion (max 15s wall time)
  local start_time=$SECONDS
  local max_wait=15
  local statuses=()
  local all_done=false

  while [[ $((SECONDS - start_time)) -lt $max_wait ]]; do
    sleep 2
    all_done=true
    statuses=()
    for run_id in "${run_ids[@]}"; do
      local events
      events=$(curl -s "$API/runs/$run_id/events" "${HEADERS[@]}" -H "Accept: text/event-stream" --max-time 3 2>/dev/null || echo "")
      if echo "$events" | grep -q "FlowRunSucceeded"; then
        statuses+=("SUCCEEDED")
      elif echo "$events" | grep -q "FlowRunFailed"; then
        statuses+=("FAILED")
      else
        statuses+=("RUNNING")
        all_done=false
      fi
    done
    if [[ "$all_done" == "true" ]]; then
      break
    fi
    log "  Waiting... (${statuses[*]})"
  done

  rm -rf "$tmpdir"

  local wall=$((SECONDS - start_time))
  local succeeded=0
  for s in "${statuses[@]}"; do
    [[ "$s" == "SUCCEEDED" ]] && succeeded=$((succeeded + 1))
  done

  if [[ $succeeded -eq 5 ]]; then
    pass "Concurrent memory — $succeeded/5 succeeded (${wall}s wall)"
    return 0
  else
    fail "Concurrent memory — $succeeded/5 succeeded (${wall}s wall): ${statuses[*]}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Test: user input (should PAUSE)
# ---------------------------------------------------------------------------
test_user_input() {
  log "Starting: User input (expect PAUSE)"

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$API/runs" "${HEADERS[@]}" -d '{
    "flowConfig": {
      "name": "test-user-input",
      "steps": [
        {
          "stepId": "ask",
          "type": "user",
          "operation": "user.request_input",
          "config": {
            "prompt": "What is your name?"
          }
        }
      ]
    },
    "input": {}
  }')
  local http_code
  http_code=$(echo "$response" | tail -1)
  local json
  json=$(echo "$response" | sed '$d')

  if [[ "$http_code" != "201" ]]; then
    fail "User input — POST returned $http_code"
    echo "  Response: $json"
    return 1
  fi

  local run_id
  run_id=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('runId',''))" 2>/dev/null || echo "")
  log "  Run started: $run_id"

  # Give it a moment to process
  sleep 3

  local events
  events=$(curl -s "$API/runs/$run_id/events" "${HEADERS[@]}" -H "Accept: text/event-stream" --max-time 3 2>/dev/null || echo "")

  if echo "$events" | grep -q "StepPausedForInput\|PAUSED\|requiredInput"; then
    pass "User input — paused for input as expected"
    return 0
  else
    warn "User input — did not detect pause (may still be processing)"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Test: workflow lifecycle (create → start → record tasks → evaluate → learn → complete → get)
# ---------------------------------------------------------------------------
test_workflow_lifecycle() {
  # Randomize slug to avoid WORKFLOW_ALREADY_EXISTS on re-runs
  local slug="test-lifecycle-$(date +%s)"
  local body
  body=$(cat scripts/test-flows/workflow-lifecycle.json | sed "s/test-lifecycle/$slug/g")
  run_and_wait "Workflow: full lifecycle (create→start→record→evaluate→learn→complete)" "$body" 30
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  Phoenix Flow Execution Tests"
echo "==========================================="
echo ""

TESTS_PASSED=0
TESTS_FAILED=0

run_test() {
  local name="$1"
  if "$name"; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
  echo ""
}

# Determine which tests to run
TEST_FILTER="${1:-all}"

# Test catalog: name → description, requirements
declare -A TEST_DESCRIPTIONS=(
  [inline-ai]="Single-step AI generate (needs OPENAI_API_KEY)"
  [inline-api]="Single-step API call to httpbin (no AI keys needed)"
  [inline-multi]="Multi-step API→AI pipeline (needs OPENAI_API_KEY)"
  [user]="User input pause/resume flow (no AI keys needed)"
  [agent]="Agent flow with tool selection (needs AI API key)"
  [chat-history]="Chat with conversation history (needs AI API key)"
  [memory]="Memory put/get + full cycle (no AI keys needed)"
  [memory-concurrent]="Concurrent memory operations (no AI keys needed)"
  [workflow]="Workflow lifecycle: create→start→record→evaluate→learn→complete (no AI keys)"
)

if [[ "$TEST_FILTER" == "--list" || "$TEST_FILTER" == "list" ]]; then
  echo ""
  echo "Available test flows:"
  echo ""
  printf "  ${CYAN}%-20s${NC} %s\n" "NAME" "DESCRIPTION"
  printf "  %-20s %s\n" "----" "-----------"
  for name in inline-ai inline-api inline-multi user agent chat-history memory memory-concurrent workflow; do
    printf "  ${GREEN}%-20s${NC} %s\n" "$name" "${TEST_DESCRIPTIONS[$name]:-}"
  done
  echo ""
  echo "  ${CYAN}all${NC}                  Run all tests"
  echo ""
  echo "Usage: $0 [test-name|all|--list]"
  echo ""
  echo "JSON flow configs in: scripts/test-flows/"
  ls -1 scripts/test-flows/*.json 2>/dev/null | while read -r f; do
    printf "  %s\n" "$(basename "$f")"
  done
  echo ""
  exit 0
fi

case "$TEST_FILTER" in
  inline-ai)        run_test test_inline_ai ;;
  inline-api)       run_test test_inline_api ;;
  inline-multi)     run_test test_inline_multi ;;
  user)             run_test test_user_input ;;
  agent)            run_test test_agent ;;
  chat-history)     run_test test_chat_history ;;
  memory)
    run_test test_memory_put_get
    run_test test_memory_full_cycle
    ;;
  memory-concurrent) run_test test_concurrent_memory ;;
  workflow)          run_test test_workflow_lifecycle ;;
  all)
    run_test test_inline_api
    run_test test_inline_ai
    run_test test_inline_multi
    run_test test_chat_history
    run_test test_agent
    run_test test_memory_put_get
    run_test test_memory_full_cycle
    run_test test_concurrent_memory
    run_test test_user_input
    run_test test_workflow_lifecycle
    ;;
  *)
    echo "Unknown test: $TEST_FILTER"
    echo "Run '$0 --list' to see available tests."
    exit 1
    ;;
esac

echo "==========================================="
echo -e "  Results: ${GREEN}$TESTS_PASSED passed${NC}, ${RED}$TESTS_FAILED failed${NC}"
echo "==========================================="

[[ $TESTS_FAILED -eq 0 ]] && exit 0 || exit 1
