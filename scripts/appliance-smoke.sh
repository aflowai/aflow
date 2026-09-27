#!/usr/bin/env bash
# Runs the boot-and-surface smoke against a running appliance.
#
# Usage: appliance-smoke.sh [project] [compose-file]
#
# The checks run inside the containers, so the host needs Docker and nothing
# else — the appliance is installed with `docker compose` and never asks the
# operator for Node or a dependency install. Running there also needs no
# published host port, which is what a CI stack will want.
#
# Each check runs where it is legitimate. The web app answers only to the hosts
# it was configured with, so its check originates inside the web container
# rather than reaching it as `web:3001` from elsewhere.
set -euo pipefail

PROJECT="${1:-aflow-local}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# The file, and therefore the image, is a parameter. The release proof runs this
# against the bundle a collaborator receives — an image that was pulled rather
# than built here — because the artifact that gets checked has to be the one
# they install. Defaults to the development topology so `yarn local:smoke` is
# unchanged.
default_compose() {
  # Two layouts: this repository, and the installation bundle, which ships this
  # script so an operator can check their own install rather than trust it.
  for candidate in "$HERE/../docker-compose.local.yml" "$HERE/../docker-compose.yml"; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
}
COMPOSE_FILE="${2:-${APPLIANCE_COMPOSE_FILE:-$(default_compose)}}"
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "No Compose file at $COMPOSE_FILE." >&2
  exit 2
fi
COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")

for service in api web; do
  if [ -z "$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null)" ]; then
    echo "No running \`$service\` in compose project '$PROJECT' ($COMPOSE_FILE). Start the stack first." >&2
    exit 2
  fi
done

status=0

"${COMPOSE[@]}" exec -T -e SMOKE_SCOPE=api -e SMOKE_API_URL=http://127.0.0.1:3000 api sh -c '
  set -a
  . /var/lib/aflow/instance/instance.env 2>/dev/null || {
    echo "No instance secret at /var/lib/aflow/instance/instance.env." >&2
    exit 2
  }
  set +a
  export SMOKE_INSTANCE_SECRET="$PHOENIX_INSTANCE_SECRET"
  cat > /tmp/appliance-smoke.mjs && node /tmp/appliance-smoke.mjs
' < "$HERE/appliance-smoke.mjs" || status=1

"${COMPOSE[@]}" exec -T -e SMOKE_SCOPE=web -e SMOKE_WEB_URL=http://127.0.0.1:3001 web sh -c '
  cat > /tmp/appliance-smoke.mjs && node /tmp/appliance-smoke.mjs
' < "$HERE/appliance-smoke.mjs" || status=1

exit $status
