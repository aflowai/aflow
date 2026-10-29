#!/bin/zsh
# watch-session.sh <sessionId> <spaceId> [label] — polls a conversation every 30 s and exits when it
# pauses on user input after having run, or ends. A pause on a child workflow run is not an exit.
# "After having run" is a poll that saw it active, or a pause on another input step than the one
# the previous successful poll saw paused, so a turn that starts and pauses between two polls is
# still reported. A failed poll changes nothing, and consecutive polls paused on one step are one
# pause. Any status that is neither active nor paused (an end, STALLED, one this script does not
# know) exits.
set -u
API=${AFLOW_API:-http://localhost:3000}
SID=${1:-}; SP=${2:-}; LABEL=${3:-session}
[ -n "$SID" ] && [ -n "$SP" ] || { echo "usage: watch-session.sh <sessionId> <spaceId> [label]" >&2; exit 1; }
TOK=$(node -e 'const c=require("./mcp.local.json");process.stdout.write(c.apiKey||c.accessToken)') || exit 1
SEEN_RUNNING=0
HAVE_POLL=0
PAUSED_STEP=
for i in $(seq 1 240); do
  ST=$(curl -s -m 10 -H "Authorization: Bearer $TOK" "$API/v1/sessions/$SID?spaceId=$SP" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const p=(j.requiredInput&&j.requiredInput.prompt||"").replace(/[\s|]+/g," ").slice(0,200);const st=(j.status==="PAUSED"&&j.blockedOn&&j.blockedOn.kind==="workflow_run")?"BLOCKED_ON_CHILD":(j.status||"?");const step=(st==="PAUSED"&&j.requiredInput&&j.requiredInput.stepExecutionId)||"";console.log(st+"|"+step+"|"+p)}catch(e){console.log("?||")}})')
  S=${ST%%|*}
  REST=${ST#*|}
  STEP=${REST%%|*}
  echo "$(date -u +%H:%M) $LABEL $S|${REST#*|}"
  case "$S" in
    QUEUED|RUNNING|WAITING_ON_CHILD|BLOCKED_ON_CHILD|CANCELLING) SEEN_RUNNING=1; HAVE_POLL=1; PAUSED_STEP= ;;
    PAUSED)
      if [ "$HAVE_POLL" = "1" ] && { [ "$SEEN_RUNNING" = "1" ] || [ "$STEP" != "$PAUSED_STEP" ]; }; then
        echo "${LABEL}_PAUSED"; exit 0
      fi
      HAVE_POLL=1; PAUSED_STEP=$STEP ;;
    '?') ;;
    *) echo "${LABEL}_ENDED_$S"; exit 0 ;;
  esac
  sleep 30
done
echo "${LABEL}_WATCH_EXPIRED"
