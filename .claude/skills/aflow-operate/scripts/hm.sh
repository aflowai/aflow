#!/bin/zsh
# A Helmsman conversation over REST.
#   hm.sh new <spaceId> <briefFile>              -> prints the new sessionId
#   hm.sh send <spaceId> <sessionId> <textFile>  -> resumes a conversation paused on user input
#   hm.sh status <spaceId> <sessionId>
#   hm.sh last <spaceId> <sessionId> [chars]     -> the last assistant message
# Run it from a checkout root that holds mcp.local.json. AFLOW_API overrides the base URL.
set -u
API=${AFLOW_API:-http://localhost:3000}
CMD=${1:-}; SP=${2:-}
USAGE="usage: hm.sh new|send|status|last <spaceId> …"
case "$CMD" in
  new|send|status|last) [ -n "$SP" ] && [ -n "${3:-}" ] && { [ "$CMD" != send ] || [ -n "${4:-}" ]; } || { echo "$USAGE" >&2; exit 1; } ;;
  *) echo "$USAGE" >&2; exit 1 ;;
esac
TOK=$(node -e 'const c=require("./mcp.local.json");process.stdout.write(c.apiKey||c.accessToken)') || exit 1
H=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
case "$CMD" in
  new)
    node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({mode:"mcp",target:{kind:"platform-role",systemRole:"cybernetic-helmsman"},input:{input:fs.readFileSync(process.argv[1],"utf8")}}))' "$3" > "$BODY"
    curl -s -m 30 "$H[@]" -X POST "$API/v1/sessions?spaceId=$SP" --data-binary @"$BODY" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.sessionId||JSON.stringify(j).slice(0,400))})' ;;
  send)
    SID=$3
    curl -s -m 15 "$H[@]" "$API/v1/sessions/$SID?spaceId=$SP" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(j.status!=="PAUSED"||!j.requiredInput){console.error("NOT PAUSED ON INPUT:",j.status,j.blockedOn?JSON.stringify(j.blockedOn):"");process.exit(2)}const text=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(JSON.stringify({stepExecutionId:j.requiredInput.stepExecutionId,input:{input:text}}))})' "$4" > "$BODY" || exit 2
    curl -s -m 30 "$H[@]" -X POST "$API/v1/sessions/$SID/resume?spaceId=$SP" --data-binary @"$BODY" | cut -c1-300; echo ;;
  status)
    curl -s -m 15 "$H[@]" "$API/v1/sessions/$3?spaceId=$SP" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.status,"steps",j.stepCount,j.blockedOn?("blockedOn "+JSON.stringify(j.blockedOn)):"",(j.requiredInput&&j.requiredInput.prompt||"").replace(/\s+/g," ").slice(0,300))})' ;;
  last)
    curl -s -m 15 "$H[@]" "$API/v1/sessions/$3/chat-history?spaceId=$SP" \
      | node -e 'let d="";const n=+process.argv[1]||3000;process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const ms=j.messages||[];const la=[...ms].reverse().find(m=>m.role==="assistant");console.log("turn",j.turnNumber);console.log(String(la&&la.content||"").slice(0,n))})' "${4:-3000}" ;;
  *) echo "$USAGE" >&2; exit 1 ;;
esac
