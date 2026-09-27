#!/bin/bash
# Test script for running a real AI step

API_URL="${API_URL:-http://localhost:3000}"
TENANT_ID="${TENANT_ID:-a0000000-0000-0000-0000-000000000001}"

# Fixed flow ID - reused across runs
FLOW_ID="test-ai-fact-generator"
FLOW_VERSION="${FLOW_VERSION:-1}"

# Topic for the interesting fact
TOPIC="${1:-quantum computing}"
# Model to use (optional second arg)
MODEL="${2:-gpt-4o-mini}"
# Wait mode: "sync" or "poll" (optional third arg)
WAIT_MODE="${3:-poll}"

# Timing helper
START_TIME=$(python3 -c "import time; print(time.time())")

elapsed() {
  python3 -c "import time; print(f'{time.time() - $START_TIME:.2f}s')"
}

echo "=== Testing Real AI Step ==="
echo "API: $API_URL"
echo "Tenant: $TENANT_ID"
echo "Topic: $TOPIC"
echo "Model: $MODEL"
echo "Flow: $FLOW_ID@$FLOW_VERSION"
echo "Mode: $WAIT_MODE"
echo ""

# Check if flow exists, create if not
echo "1. Ensuring flow exists..."
FLOW_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/v1/agents/$FLOW_ID/versions/$FLOW_VERSION" \
  -H "X-Tenant-ID: $TENANT_ID")

if [ "$FLOW_CHECK" = "200" ]; then
  echo "   Flow already exists, reusing."
else
  echo "   Creating flow..."
  FLOW_RESPONSE=$(curl -s -X POST "$API_URL/v1/agents" \
    -H "Content-Type: application/json" \
    -H "X-Tenant-ID: $TENANT_ID" \
    -d "{
      \"flowId\": \"$FLOW_ID\",
      \"name\": \"Test AI Fact Generator\",
      \"description\": \"Generates a surprising fact about a topic using AI\",
      \"steps\": [
        {
          \"stepId\": \"generate-fact\",
          \"type\": \"ai\",
          \"operation\": \"ai.generate\"
        }
      ]
    }")

  # Extract version from flow response
  NEW_VERSION=$(echo "$FLOW_RESPONSE" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$NEW_VERSION" ]; then
    FLOW_VERSION="$NEW_VERSION"
  fi
  echo "   Created flow version: $FLOW_VERSION"
fi
echo ""

# Start a run with the topic as input
echo "2. Starting flow run..."

# Build URL with optional wait parameter for sync mode
RUN_URL="$API_URL/v1/sessions"
if [ "$WAIT_MODE" = "sync" ]; then
  RUN_URL="$API_URL/v1/sessions?wait=30s"
  echo "   Using sync mode (wait=30s)..."
fi

RUN_RESPONSE=$(curl -s -X POST "$RUN_URL" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Idempotency-Key: test-$(date +%s)" \
  -d "{
    \"flowId\": \"$FLOW_ID\",
    \"version\": \"$FLOW_VERSION\",
    \"input\": {
      \"prompt\": \"Tell me one surprising and interesting fact about ${TOPIC} that most people don't know. Be concise (2-3 sentences max).\",
      \"model\": \"$MODEL\"
    }
  }")

echo "Run response: $RUN_RESPONSE"
echo ""

# Extract run ID and status
RUN_ID=$(echo "$RUN_RESPONSE" | grep -o '"runId":"[^"]*"' | cut -d'"' -f4)
STATUS=$(echo "$RUN_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

if [ -z "$RUN_ID" ]; then
  echo "Failed to get run ID. Full response:"
  echo "$RUN_RESPONSE"
  exit 1
fi

echo "Run ID: $RUN_ID"
RUN_START_TIME=$(python3 -c "import time; print(time.time())")
echo ""

# In sync mode, check if we got a terminal status directly
if [ "$WAIT_MODE" = "sync" ]; then
  TOTAL_ELAPSED=$(elapsed)
  if [ "$STATUS" = "SUCCEEDED" ]; then
    echo "=== SUCCESS (sync mode, total: $TOTAL_ELAPSED) ==="
    echo "$RUN_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RUN_RESPONSE"
    
    # Fetch output
    OUTPUT_REF=$(echo "$RUN_RESPONSE" | grep -o '"outputRef":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$OUTPUT_REF" ]; then
      echo ""
      echo "=== AI OUTPUT ==="
      ENCODED_REF=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$OUTPUT_REF")
      OUTPUT_RESPONSE=$(curl -s "$API_URL/v1/payloads?ref=$ENCODED_REF" -H "X-Tenant-ID: $TENANT_ID")
      # Extract content from AI output (payload is returned raw, not wrapped)
      echo "$OUTPUT_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if isinstance(data, dict):
        if 'content' in data:
            print(data['content'])
        elif 'text' in data:
            print(data['text'])
        elif 'error' in data:
            print(f\"Error: {data.get('message', data.get('error'))}\")
        else:
            print(json.dumps(data, indent=2))
    else:
        print(data)
except Exception as e:
    print(sys.stdin.read() if hasattr(sys.stdin, 'read') else str(e))
"
    fi
    exit 0
  elif [ "$STATUS" = "FAILED" ]; then
    echo "=== FAILED (sync mode, total: $TOTAL_ELAPSED) ==="
    echo "$RUN_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RUN_RESPONSE"
    exit 1
  elif [ "$STATUS" = "PAUSED" ]; then
    echo "=== PAUSED (requires input, total: $TOTAL_ELAPSED) ==="
    echo "$RUN_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RUN_RESPONSE"
    exit 0
  else
    echo "   Sync wait timed out, falling back to polling..."
  fi
fi

# Poll for completion (async mode or sync timeout fallback)
echo "3. Waiting for completion..."
FIRST_VISIBLE_TIME=""
for i in {1..30}; do
  sleep 1
  STATUS_RESPONSE=$(curl -s "$API_URL/v1/sessions/$RUN_ID" \
    -H "X-Tenant-ID: $TENANT_ID")
  
  STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  
  # Check for errors in response
  ERROR=$(echo "$STATUS_RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
  ELAPSED=$(elapsed)
  if [ -n "$ERROR" ]; then
    echo "   [$ELAPSED] Attempt $i: Error - $ERROR"
  elif [ -z "$STATUS" ]; then
    # Check if it's a 404 or other issue
    HTTP_CODE=$(echo "$STATUS_RESPONSE" | grep -o '"statusCode":[0-9]*' | cut -d':' -f2)
    if [ -n "$HTTP_CODE" ]; then
      echo "   [$ELAPSED] Attempt $i: Not visible yet"
    else
      echo "   [$ELAPSED] Attempt $i: Waiting..."
    fi
  else
    if [ -z "$FIRST_VISIBLE_TIME" ]; then
      FIRST_VISIBLE_TIME=$ELAPSED
      echo "   [$ELAPSED] Attempt $i: Status = $STATUS (first visible)"
    else
      echo "   [$ELAPSED] Attempt $i: Status = $STATUS"
    fi
  fi
  
  if [ "$STATUS" = "SUCCEEDED" ]; then
    TOTAL_ELAPSED=$(elapsed)
    echo ""
    echo "=== SUCCESS (total: $TOTAL_ELAPSED, visible after: $FIRST_VISIBLE_TIME) ==="
    echo "$STATUS_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$STATUS_RESPONSE"
    
    # Try to fetch the output
    OUTPUT_REF=$(echo "$STATUS_RESPONSE" | grep -o '"outputRef":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$OUTPUT_REF" ]; then
      echo ""
      echo "=== AI OUTPUT ==="
      
      # Use query param approach - simpler encoding
      ENCODED_REF=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$OUTPUT_REF")
      OUTPUT_RESPONSE=$(curl -s "$API_URL/v1/payloads?ref=$ENCODED_REF" \
        -H "X-Tenant-ID: $TENANT_ID")
      
      # Extract content from AI output (payload is returned raw, not wrapped)
      echo "$OUTPUT_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if isinstance(data, dict):
        if 'content' in data:
            print(data['content'])
        elif 'text' in data:
            print(data['text'])
        elif 'error' in data:
            print(f\"Error: {data.get('message', data.get('error'))}\")
        else:
            print(json.dumps(data, indent=2))
    else:
        print(data)
except Exception as e:
    print(sys.stdin.read() if hasattr(sys.stdin, 'read') else str(e))
"
    fi
    exit 0
  fi
  
  if [ "$STATUS" = "FAILED" ]; then
    echo ""
    echo "=== FAILED ==="
    echo "$STATUS_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$STATUS_RESPONSE"
    exit 1
  fi
done

echo ""
echo "=== TIMEOUT ==="
echo "Run did not complete within 60 seconds."
echo "Check orchestrator logs for errors."
echo ""
echo "Last response:"
echo "$STATUS_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$STATUS_RESPONSE"
exit 1
