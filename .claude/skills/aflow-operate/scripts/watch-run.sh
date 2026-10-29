#!/bin/zsh
# watch-run.sh <runId> <spaceId> [label] — polls a workflow run every 30 s and exits when it is
# terminal or paused on a person. Run it in the background and act when it exits.
set -u
API=${AFLOW_API:-http://localhost:3000}
RUN=$1; SP=$2; LABEL=${3:-run}
TOK=$(node -e 'const c=require("./mcp.local.json");process.stdout.write(c.apiKey||c.accessToken)') || exit 1
for i in $(seq 1 240); do
  ST=$(curl -s -m 10 -H "Authorization: Bearer $TOK" "$API/v1/spaces/$SP/workflow-runs/$RUN" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const r=j.run||j;console.log((r.status||"?")+"|"+(r.pausedReason||r.paused_reason||""))}catch(e){console.log("?|")}})')
  S=${ST%%|*}
  echo "$(date -u +%H:%M) $LABEL $ST"
  case "$S" in
    running|completing|cancelling|queued) ;;
    paused) echo "${LABEL}_PAUSED|${ST#*|}"; exit 0 ;;
    '?') ;;
    *) echo "${LABEL}_ENDED_$S"; exit 0 ;;
  esac
  sleep 30
done
echo "${LABEL}_WATCH_EXPIRED"
