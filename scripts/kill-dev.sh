#!/usr/bin/env bash
# Kill Phoenix dev processes (supervisors, server, orchestrator, executors, web).
# MCP is excluded: one left running keeps serving, and the next stack uses it.
# Usage: ./scripts/kill-dev.sh  or  yarn kill

set -euo pipefail

PORTS=(3000 3001)
KILLED=0

# Supervisors first. They respawn what they supervise, so killing the workers
# alone reads as this script having done nothing: the ports come back within
# seconds under new pids. `dev.mjs --profile mcp` is spared for the same reason
# the MCP is excluded below.
#
# No `-E`: `pkill` takes an extended regular expression already, and passing it
# is an illegal option that exits 2 — which this `if` with a discarded stderr
# would have swallowed, leaving the respawning supervisors this exists to stop.
for pattern in 'scripts/dev-local\.ts' 'scripts/dev\.mjs --profile (all|local|core|api|ui|engine|mock)'; do
  if pkill -9 -f "$pattern" 2>/dev/null; then
    echo "  killed supervisor matching ${pattern}"
  fi
done

# `-sTCP:LISTEN` is load-bearing rather than a narrowing: `lsof -ti :3000` also
# matches the far end of every established connection, so the bare form killed
# the browser holding a tab open on the dev server.
for port in "${PORTS[@]}"; do
  pids=$(lsof -t -sTCP:LISTEN -iTCP:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
    echo "  killed port $port (pids: $(echo "$pids" | tr '\n' ' '))"
    KILLED=$((KILLED + 1))
  fi
done

# Kill any process running from the aflow-* app directories (executors, orchestrator)
# aflow-mcp is excluded, as above.
pkill -9 -f "aflow-executor" 2>/dev/null && echo "  killed executor processes" || true
pkill -9 -f "aflow-orchestrator" 2>/dev/null && echo "  killed orchestrator processes" || true
pkill -9 -f "tsx.*apps/server" 2>/dev/null && echo "  killed server processes" || true
pkill -9 -f "next dev" 2>/dev/null && echo "  killed next dev (web)" || true

if [ "$KILLED" -eq 0 ]; then
  echo "No dev processes found on ports ${PORTS[*]}"
else
  echo "Done — freed $KILLED port(s)"
fi
