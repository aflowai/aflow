#!/usr/bin/env bash
#
# Develop the web app against a running appliance.
#
# The appliance publishes 3000/3001 by default, which a developer's own dev
# stack already uses, so a second set of ports is needed — and remembering to
# pass them on every invocation is not a process. Passing them once and then
# running a plain `yarn local:up` recreates the containers on the defaults,
# which presents as ECONNREFUSED from a web server still pointed at the old
# ones. Pinned here so the two halves cannot disagree.
#
# The web container is deliberately left stopped: the dev server takes its port,
# so that one address serves the same app with hot reload, and the API's CORS
# and realtime origins — which name the web port — keep matching.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# An array, so a checkout path containing a space stays one argument.
COMPOSE=(docker compose -f "${REPO_ROOT}/docker-compose.local.yml")

export AFLOW_API_PORT="${AFLOW_API_PORT:-3200}"
export AFLOW_WEB_PORT="${AFLOW_WEB_PORT:-3201}"
export AFLOW_REDIS_PORT="${AFLOW_REDIS_PORT:-6380}"

case "${1:-up}" in
  up)
    echo "Appliance: API on ${AFLOW_API_PORT}, Redis on ${AFLOW_REDIS_PORT}."
    # Named services rather than all: `web` would claim the port the dev server
    # wants, and bringing it up only to stop it costs a minute of build for
    # nothing.
    "${COMPOSE[@]}" up -d --build api worker
    "${COMPOSE[@]}" stop web >/dev/null 2>&1 || true
    echo "Now run: yarn local:dev:web"
    ;;
  web)
    secret="$("${COMPOSE[@]}" exec -T api sh -c '. /var/lib/aflow/instance/instance.env && printf %s "$PHOENIX_INSTANCE_SECRET"')"
    if [ -z "$secret" ]; then
      echo "Could not read the instance secret. Is the appliance up? \`yarn local:dev:up\`" >&2
      exit 1
    fi
    cd "${REPO_ROOT}/apps/web"
    # PHOENIX_EDITION is what makes the proxy attach that secret at all; without
    # it every call is refused and the pages look broken rather than signed out.
    PHOENIX_EDITION=community-local \
      API_URL="http://127.0.0.1:${AFLOW_API_PORT}" \
      NEXT_PUBLIC_API_ORIGIN="http://127.0.0.1:${AFLOW_API_PORT}" \
      PHOENIX_INSTANCE_SECRET="$secret" \
      NEXT_DIST_DIR=".next-dev${AFLOW_WEB_PORT}" \
      exec npx next dev --port "${AFLOW_WEB_PORT}"
    ;;
  stop)
    "${COMPOSE[@]}" stop api worker
    ;;
  *)
    echo "Usage: appliance-dev.sh [up|web|stop]" >&2
    exit 2
    ;;
esac
