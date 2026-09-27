#!/bin/bash
# =============================================================================
# Test script for inline flowConfig API
#
# Tests AI operations by running inline flow definitions directly via the API.
# No pre-registered flows needed — each test sends its own flow config.
#
# Prerequisites:
#   - Server running (apps/server)
#   - Orchestrator running (apps/aflow-orchestrator)
#   - AI Executor running (apps/aflow-executor-ai)
#
# Usage:
#   ./scripts/test-inline-flow.sh                      # Run all tests
#   ./scripts/test-inline-flow.sh generate             # Test ai.generate only
#   ./scripts/test-inline-flow.sh generateJson         # Test ai.generateJson only
#   ./scripts/test-inline-flow.sh image                # Test ai.image.generate only
#   ./scripts/test-inline-flow.sh agentDecide          # Test ai.agent_decide only
# =============================================================================

set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
TENANT_ID="${TENANT_ID:-a0000000-0000-0000-0000-000000000001}"
MODEL="${MODEL:-gpt-4o-mini}"
WAIT_SECONDS="${WAIT_SECONDS:-30}"
TEST_FILTER="${1:-all}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
SKIPPED=0

# ---------------------------------------------------------------------------
# Helper: run a flow with inline config and return the run response
# ---------------------------------------------------------------------------
run_inline_flow() {
  local test_name="$1"
  local flow_config="$2"   # JSON string for flowConfig
  local input="$3"         # JSON string for input

  echo -e "${BLUE}--- Test: ${test_name} ---${NC}"

  local body
  body=$(python3 -c "
import json, sys
fc = json.loads(sys.argv[1])
inp = json.loads(sys.argv[2])
print(json.dumps({
    'flowConfig': fc,
    'input': inp,
}))
" "$flow_config" "$input")

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "${API_URL}/v1/sessions?wait=${WAIT_SECONDS}s" \
    -H "Content-Type: application/json" \
    -H "X-Tenant-ID: ${TENANT_ID}" \
    -H "Idempotency-Key: test-$(date +%s%N)" \
    -d "$body")

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body_response
  body_response=$(echo "$response" | sed '$d')

  if [ "$http_code" -ne 201 ]; then
    echo -e "${RED}  FAILED: HTTP $http_code${NC}"
    echo "  Response: $body_response"
    FAILED=$((FAILED + 1))
    return 1
  fi

  local status
  status=$(echo "$body_response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  local run_id
  run_id=$(echo "$body_response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('runId',''))" 2>/dev/null)

  echo "  Run ID: $run_id"
  echo "  Status: $status"

  # If sync wait returned a terminal status
  if [ "$status" = "SUCCEEDED" ]; then
    local output_ref
    output_ref=$(echo "$body_response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('outputRef',''))" 2>/dev/null)

    if [ -n "$output_ref" ] && [ "$output_ref" != "" ] && [ "$output_ref" != "None" ]; then
      echo "  Output ref: $output_ref"
      local encoded_ref
      encoded_ref=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$output_ref")
      local payload
      payload=$(curl -s "${API_URL}/v1/payloads?ref=${encoded_ref}" -H "X-Tenant-ID: ${TENANT_ID}")
      echo "  Output:"
      echo "$payload" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(json.dumps(data, indent=2)[:2000])
except:
    print(sys.stdin.read()[:2000])
" 2>/dev/null || echo "  (could not parse output)"
    fi
    echo -e "${GREEN}  PASSED${NC}"
    PASSED=$((PASSED + 1))
    return 0

  elif [ "$status" = "FAILED" ]; then
    echo -e "${RED}  FAILED: Run failed${NC}"
    echo "  Response: $(echo "$body_response" | python3 -m json.tool 2>/dev/null || echo "$body_response")"
    FAILED=$((FAILED + 1))
    return 1

  elif [ "$status" = "RUNNING" ]; then
    # Sync wait timed out; poll
    echo "  Sync wait timed out, polling..."
    for i in $(seq 1 30); do
      sleep 1
      local poll_response
      poll_response=$(curl -s "${API_URL}/v1/sessions/${run_id}" -H "X-Tenant-ID: ${TENANT_ID}")
      status=$(echo "$poll_response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
      echo "  [$i] Status: $status"

      if [ "$status" = "SUCCEEDED" ]; then
        local output_ref
        output_ref=$(echo "$poll_response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('outputRef',''))" 2>/dev/null)
        if [ -n "$output_ref" ] && [ "$output_ref" != "" ] && [ "$output_ref" != "None" ]; then
          local encoded_ref
          encoded_ref=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$output_ref")
          local payload
          payload=$(curl -s "${API_URL}/v1/payloads?ref=${encoded_ref}" -H "X-Tenant-ID: ${TENANT_ID}")
          echo "  Output:"
          echo "$payload" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(json.dumps(data, indent=2)[:2000])
except:
    print(sys.stdin.read()[:2000])
" 2>/dev/null || echo "  (could not parse output)"
        fi
        echo -e "${GREEN}  PASSED${NC}"
        PASSED=$((PASSED + 1))
        return 0
      elif [ "$status" = "FAILED" ]; then
        echo -e "${RED}  FAILED: Run failed${NC}"
        echo "  $poll_response"
        FAILED=$((FAILED + 1))
        return 1
      fi
    done

    echo -e "${RED}  FAILED: Timed out waiting for run${NC}"
    FAILED=$((FAILED + 1))
    return 1
  else
    echo -e "${RED}  FAILED: Unexpected status '${status}'${NC}"
    echo "  Response: $body_response"
    FAILED=$((FAILED + 1))
    return 1
  fi
}

# =============================================================================
# Test 1: ai.generate — basic text generation
# =============================================================================
test_generate() {
  local flow_config='{
    "name": "test-ai-generate",
    "steps": [
      {
        "stepId": "gen",
        "type": "ai",
        "operation": "ai.generate"
      }
    ]
  }'

  local input
  input=$(python3 -c "
import json
print(json.dumps({
    'prompt': 'What is 2+2? Answer with just the number.',
    'model': '$MODEL'
}))
")

  run_inline_flow "ai.generate (basic text)" "$flow_config" "$input"
}

# =============================================================================
# Test 2: ai.generateJson — structured JSON output
# =============================================================================
test_generate_json() {
  local flow_config='{
    "name": "test-ai-generateJson",
    "steps": [
      {
        "stepId": "gen-json",
        "type": "ai",
        "operation": "ai.generateJson"
      }
    ]
  }'

  local input
  input=$(python3 -c '
import json
print(json.dumps({
    "prompt": "List 3 planets in our solar system with their order from the sun.",
    "model": "'"$MODEL"'",
    "outputSchema": {
        "type": "object",
        "properties": {
            "planets": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "orderFromSun": { "type": "integer" }
                    },
                    "required": ["name", "orderFromSun"]
                }
            }
        },
        "required": ["planets"]
    }
}))
')

  run_inline_flow "ai.generateJson (structured output)" "$flow_config" "$input"
}

# =============================================================================
# Test 3: ai.image.generate — image generation
# =============================================================================
test_image_generate() {
  local flow_config='{
    "name": "test-ai-image-generate",
    "steps": [
      {
        "stepId": "img-gen",
        "type": "ai",
        "operation": "ai.image.generate"
      }
    ]
  }'

  local input='{
    "prompt": "A simple red circle on a white background",
    "model": "gpt-image",
    "size": "1024x1024",
    "n": 1
  }'

  run_inline_flow "ai.image.generate (image creation)" "$flow_config" "$input"
}

# =============================================================================
# Test 4: ai.agent_decide — agent decision with tools
# =============================================================================
test_agent_decide() {
  local flow_config='{
    "name": "test-ai-agent-decide",
    "steps": [
      {
        "stepId": "decide",
        "type": "ai",
        "operation": "ai.agent_decide"
      }
    ]
  }'

  local input
  input=$(python3 -c '
import json
print(json.dumps({
    "prompt": "Look up the weather in Tokyo",
    "model": "'"$MODEL"'",
    "availableTools": [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": { "type": "string", "description": "The city name" },
                        "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "Temperature unit" }
                    },
                    "required": ["city"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": "Search the web for information",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }
            }
        }
    ]
}))
')

  run_inline_flow "ai.agent_decide (tool selection)" "$flow_config" "$input"
}

# =============================================================================
# Test 5: Multi-step flow — ai.generate → ai.generateJson (chained)
# =============================================================================
test_multi_step() {
  local flow_config='{
    "name": "test-multi-step",
    "steps": [
      {
        "stepId": "step1-generate",
        "type": "ai",
        "operation": "ai.generate"
      },
      {
        "stepId": "step2-generate",
        "type": "ai",
        "operation": "ai.generate"
      }
    ]
  }'

  local input
  input=$(python3 -c '
import json
print(json.dumps({
    "prompt": "Name a famous scientist. Just the name, nothing else.",
    "model": "'"$MODEL"'"
}))
')

  run_inline_flow "multi-step (ai.generate → ai.generate)" "$flow_config" "$input"
}

# =============================================================================
# Main
# =============================================================================
echo "=============================================="
echo " Inline Flow Config Tests"
echo "=============================================="
echo "API:    $API_URL"
echo "Tenant: $TENANT_ID"
echo "Model:  $MODEL"
echo "Wait:   ${WAIT_SECONDS}s"
echo ""

case "$TEST_FILTER" in
  generate)
    test_generate
    ;;
  generateJson)
    test_generate_json
    ;;
  image)
    test_image_generate
    ;;
  agentDecide)
    test_agent_decide
    ;;
  multi)
    test_multi_step
    ;;
  all)
    test_generate || true
    echo ""
    test_generate_json || true
    echo ""
    test_agent_decide || true
    echo ""
    # Multi-step requires input mapping (not yet implemented for inline flows)
    echo -e "${YELLOW}Skipping multi-step test (requires input mapping between steps)${NC}"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    # Image generation is slower & costs money, run last
    echo -e "${YELLOW}Skipping ai.image.generate (run with: ./scripts/test-inline-flow.sh image)${NC}"
    SKIPPED=$((SKIPPED + 1))
    ;;
  *)
    echo "Unknown test: $TEST_FILTER"
    echo "Valid tests: generate, generateJson, image, agentDecide, multi, all"
    exit 1
    ;;
esac

echo ""
echo "=============================================="
echo -e " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}"
echo "=============================================="

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
