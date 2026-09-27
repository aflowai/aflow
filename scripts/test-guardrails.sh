#!/usr/bin/env bash
#
# Test guardrail system end-to-end via the API.
#
# Prerequisites:
#   - yarn start running
#   - AI keys configured in .env
#
# Usage:
#   ./scripts/test-guardrails.sh
#
set -euo pipefail

API="http://localhost:3000/v1"
TENANT="a0000000-0000-0000-0000-000000000001"
SPACE_HEADER=""

# Try to get a space ID (required for space-scoped routes)
SPACE_ID=$(curl -s "$API/spaces" -H "X-Tenant-ID: $TENANT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
spaces = data.get('spaces', [])
if spaces:
    print(spaces[0].get('id', ''))
" 2>/dev/null || echo "")

if [[ -n "$SPACE_ID" ]]; then
  SPACE_HEADER="-H X-Space-ID:$SPACE_ID"
fi

HEADERS=(-H "Content-Type: application/json" -H "X-Tenant-ID: $TENANT")
if [[ -n "$SPACE_HEADER" ]]; then
  HEADERS+=($SPACE_HEADER)
fi

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[test]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }

# ═══════════════════════════════════════════════════════════════════════════
# TEST 1: CRUD — Create, read, list, update, delete a guardrail policy
# ═══════════════════════════════════════════════════════════════════════════
log "TEST 1: Guardrail policy CRUD"

# Create
POLICY_BODY=$(cat <<'EOF'
{
  "policyId": "test-blocklist-policy",
  "name": "Test Blocklist",
  "description": "Blocks the word FORBIDDEN in agent output",
  "scope": { "platform": true },
  "rails": [
    {
      "railId": "block-forbidden",
      "name": "Block FORBIDDEN",
      "layer": "rule",
      "trigger": "on_agent_turn_output",
      "mode": "blocking",
      "type": "blocklist",
      "config": { "terms": ["FORBIDDEN", "BANNED"] },
      "onViolation": "block",
      "violationMessage": "Response contains prohibited content.",
      "priority": 1,
      "enabled": true
    }
  ],
  "settings": {
    "defaultFailBehavior": "fail_closed",
    "logMode": "violations_only"
  }
}
EOF
)

RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/guardrails" "${HEADERS[@]}" -d "$POLICY_BODY")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP" == "201" ]]; then
  pass "Create policy — 201"
else
  fail "Create policy — got $HTTP: $BODY"
fi

# Read
RESP=$(curl -s -w "\n%{http_code}" "$API/guardrails/test-blocklist-policy" "${HEADERS[@]}")
HTTP=$(echo "$RESP" | tail -1)
if [[ "$HTTP" == "200" ]]; then
  pass "Get policy — 200"
else
  fail "Get policy — got $HTTP"
fi

# List
RESP=$(curl -s -w "\n%{http_code}" "$API/guardrails" "${HEADERS[@]}")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
COUNT=$(echo "$BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('policies',[])))" 2>/dev/null || echo 0)
if [[ "$HTTP" == "200" ]] && [[ "$COUNT" -ge 1 ]]; then
  pass "List policies — 200, found $COUNT"
else
  fail "List policies — got $HTTP, count=$COUNT"
fi

# ═══════════════════════════════════════════════════════════════════════════
# TEST 2: Tool denylist — agent can't call a denied tool
# ═══════════════════════════════════════════════════════════════════════════
log "TEST 2: Tool denylist guardrail"

DENY_POLICY=$(cat <<'EOF'
{
  "policyId": "test-tool-deny",
  "name": "Deny api-fetch tool",
  "scope": { "platform": true },
  "rails": [
    {
      "railId": "deny-api-fetch",
      "name": "Block api-fetch",
      "layer": "rule",
      "trigger": "on_tool_input",
      "mode": "blocking",
      "type": "tool_denylist",
      "config": { "deniedTools": ["api-fetch"] },
      "onViolation": "block",
      "violationMessage": "This tool is not allowed.",
      "priority": 1,
      "enabled": true
    }
  ]
}
EOF
)

curl -s -X POST "$API/guardrails" "${HEADERS[@]}" -d "$DENY_POLICY" > /dev/null 2>&1

# Run the agent-simple flow (which uses api-fetch tool)
FLOW_BODY=$(cat scripts/test-flows/agent-simple.json)
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/runs" "${HEADERS[@]}" -d "$FLOW_BODY")
HTTP=$(echo "$RESP" | tail -1)
JSON=$(echo "$RESP" | sed '$d')
RUN_ID=$(echo "$JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('runId',''))" 2>/dev/null || echo "")

if [[ -n "$RUN_ID" ]]; then
  log "  Run started: $RUN_ID — waiting for completion..."
  sleep 10

  # Check events for guardrail violation
  EVENTS=$(curl -s "$API/runs/$RUN_ID/events" "${HEADERS[@]}" -H "Accept: text/event-stream" --max-time 5 2>/dev/null || echo "")
  if echo "$EVENTS" | grep -q "GuardrailViolation"; then
    pass "Tool denylist — GuardrailViolation event found"
  else
    fail "Tool denylist — no GuardrailViolation event in run events"
  fi
else
  fail "Tool denylist — couldn't start run"
fi

# Clean up policies
curl -s -X DELETE "$API/guardrails/test-tool-deny" "${HEADERS[@]}" > /dev/null 2>&1

# ═══════════════════════════════════════════════════════════════════════════
# TEST 3: Effective policy endpoint
# ═══════════════════════════════════════════════════════════════════════════
log "TEST 3: Effective policy"

RESP=$(curl -s -w "\n%{http_code}" "$API/guardrails/effective" "${HEADERS[@]}")
HTTP=$(echo "$RESP" | tail -1)
if [[ "$HTTP" == "200" ]]; then
  pass "Effective policy — 200"
else
  fail "Effective policy — got $HTTP"
fi

# ═══════════════════════════════════════════════════════════════════════════
# TEST 4: Budget limit guardrail
# ═══════════════════════════════════════════════════════════════════════════
log "TEST 4: Budget limit guardrail"

BUDGET_POLICY=$(cat <<'EOF'
{
  "policyId": "test-budget-limit",
  "name": "Strict budget",
  "scope": { "platform": true },
  "rails": [
    {
      "railId": "max-1-turn",
      "name": "Max 1 turn",
      "layer": "rule",
      "trigger": "on_agent_turn_input",
      "mode": "blocking",
      "type": "budget_limit",
      "config": { "maxTurns": 1 },
      "onViolation": "block",
      "violationMessage": "Budget exceeded — max 1 turn.",
      "priority": 1,
      "enabled": true
    }
  ]
}
EOF
)

curl -s -X POST "$API/guardrails" "${HEADERS[@]}" -d "$BUDGET_POLICY" > /dev/null 2>&1

FLOW_BODY=$(cat scripts/test-flows/agent-simple.json)
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/runs" "${HEADERS[@]}" -d "$FLOW_BODY")
HTTP=$(echo "$RESP" | tail -1)
JSON=$(echo "$RESP" | sed '$d')
RUN_ID=$(echo "$JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('runId',''))" 2>/dev/null || echo "")

if [[ -n "$RUN_ID" ]]; then
  log "  Run started: $RUN_ID — waiting for budget enforcement..."
  sleep 15

  EVENTS=$(curl -s "$API/runs/$RUN_ID/events" "${HEADERS[@]}" -H "Accept: text/event-stream" --max-time 5 2>/dev/null || echo "")

  if echo "$EVENTS" | grep -q "GuardrailViolation\|FlowRunFailed"; then
    pass "Budget limit — run was stopped after exceeding budget"
  else
    fail "Budget limit — run was not stopped"
    echo "  Events tail:"
    echo "$EVENTS" | tail -20
  fi
else
  fail "Budget limit — couldn't start run"
fi

# Clean up
curl -s -X DELETE "$API/guardrails/test-budget-limit" "${HEADERS[@]}" > /dev/null 2>&1
curl -s -X DELETE "$API/guardrails/test-blocklist-policy" "${HEADERS[@]}" > /dev/null 2>&1

# ═══════════════════════════════════════════════════════════════════════════
# TEST 5: Guardrail log endpoint
# ═══════════════════════════════════════════════════════════════════════════
log "TEST 5: Guardrail log endpoint"

if [[ -n "$RUN_ID" ]]; then
  RESP=$(curl -s -w "\n%{http_code}" "$API/runs/$RUN_ID/guardrail-log" "${HEADERS[@]}")
  HTTP=$(echo "$RESP" | tail -1)
  if [[ "$HTTP" == "200" ]]; then
    pass "Guardrail log — 200"
  else
    fail "Guardrail log — got $HTTP"
  fi
else
  fail "Guardrail log — no run to check"
fi

echo ""
log "Done. Clean up any remaining test policies if needed."
