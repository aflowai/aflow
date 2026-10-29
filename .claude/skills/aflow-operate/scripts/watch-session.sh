#!/bin/zsh
# watch-session.sh <sessionId> <spaceId> [label] — polls a conversation every 30 s and exits when it
# pauses on user input after having run, or ends. A pause on a child workflow run is not an exit.
set -u
API=${AFLOW_API:-http://localhost:3000}
SID=$1; SP=$2; LABEL=${3:-session}
TOK=$(node -e 'const c=require("./mcp.local.json");process.stdout.write(c.apiKey||c.accessToken)') || exit 1
SEEN_RUNNING=0
for i in $(seq 1 240); do
  ST=$(curl -s -m 10 -H "Authorization: Bearer $TOK" "$API/v1/sessions/$SID?spaceId=$SP" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const p=(j.requiredInput&&j.requiredInput.prompt||"").replace(/\s+/g," ").slice(0,200);const st=(j.status==="PAUSED"&&j.blockedOn&&j.blockedOn.kind==="workflow_run")?"BLOCKED_ON_CHILD":j.status;console.log(st+"|"+p)}catch(e){console.log("?|")}})')
  S=${ST%%|*}
  echo "$(date -u +%H:%M) $LABEL $ST"
  case "$S" in RUNNING|BLOCKED_ON_CHILD) SEEN_RUNNING=1 ;; esac
  if [ "$S" = "PAUSED" ] && [ "$SEEN_RUNNING" = "1" ]; then echo "${LABEL}_PAUSED"; exit 0; fi
  case "$S" in SUCCEEDED|FAILED|CANCELLED) echo "${LABEL}_ENDED_$S"; exit 0 ;; esac
  sleep 30
done
echo "${LABEL}_WATCH_EXPIRED"
