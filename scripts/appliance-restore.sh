#!/usr/bin/env bash
#
# Restore an Aflow Local instance from `appliance-backup.sh` output.
#
# Destructive: the target instance's database and volumes are replaced. Every
# input is therefore read and verified before the first volume is removed — an
# artefact that exists is not an artefact that loads, and discovering the
# difference afterwards would leave the target emptied and the backup unusable.
#
#   scripts/appliance-restore.sh <backup-directory> [compose-file]
#
set -euo pipefail

SRC="${1:?usage: appliance-restore.sh <backup-directory> [compose-file]}"
# Two layouts: this repository, and the installation bundle, which ships this
# script and carries its Compose file under the plain name.
default_compose() {
  for candidate in docker-compose.local.yml docker-compose.yml; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  echo docker-compose.local.yml
}
COMPOSE_FILE="${2:-$(default_compose)}"
SRC_ABS="$(cd "$SRC" && pwd)"
PROJECT="${AFLOW_PROJECT:-aflow-local}"
VOLUMES=(instance_config payload_data)

# Removing a volume must succeed or stop the restore. Swallowing an "in use"
# failure would leave the old volume in place, and `docker volume create` would
# hand that same volume back — restoring on top of the data being replaced.
remove_volume() {
  local name="$1"
  if ! docker volume inspect "$name" >/dev/null 2>&1; then
    return 0
  fi
  if ! docker volume rm "$name" >/dev/null; then
    echo "error: could not remove volume $name — something still holds it." >&2
    exit 1
  fi
}

# Runs a check quietly and surfaces the tool's own output only when it fails,
# which is what names the artefact at fault.
run_check() {
  local failure="$1"
  shift
  local output
  if ! output="$("$@" 2>&1)"; then
    echo "error: ${failure}" >&2
    echo "       Nothing has been changed." >&2
    echo "$output" >&2
    exit 1
  fi
}

if [ ! -f "${SRC_ABS}/MANIFEST" ]; then
  echo "error: ${SRC_ABS} has no MANIFEST — not a backup taken by appliance-backup.sh" >&2
  exit 1
fi

for artefact in SHA256SUMS postgres.dump "${VOLUMES[@]/%/.tgz}"; do
  if [ ! -f "${SRC_ABS}/${artefact}" ]; then
    echo "error: ${SRC_ABS}/${artefact} is missing — restoring a partial set would" >&2
    echo "       leave the instance internally inconsistent." >&2
    exit 1
  fi
done

# `-a`, not just running: a stopped container still holds a reference to its
# volumes, so `docker volume rm` would fail and the restore would overlay the
# archives onto the state it was meant to replace.
existing="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --quiet)"
if [ -n "$existing" ]; then
  echo "error: ${PROJECT} still has containers, which hold its volumes open." >&2
  echo "       Remove them first (stopping is not enough):" >&2
  echo "  docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down" >&2
  exit 1
fi

# The image compose declares, rather than a name repeated here: the check below
# must run `pg_restore` from the same PostgreSQL version that will load the
# dump, and asking compose is what keeps the two from drifting apart.
postgres_image="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" config --images postgres 2>/dev/null | head -n 1 || true)"
if [ -z "$postgres_image" ]; then
  echo "error: ${COMPOSE_FILE} declares no image for a postgres service." >&2
  exit 1
fi

echo "  verifying backup"

# Digested inside the image that wrote the sums: macOS ships `shasum` and no
# `sha256sum`, so a host-side digest would work on one operator's machine and
# not the next one's.
run_check "the backup does not match its own checksums — it is incomplete, corrupt, or was assembled from more than one run." \
  docker run --rm -v "${SRC_ABS}:/backup:ro" alpine sh -c 'cd /backup && sha256sum -c SHA256SUMS'

# The checksums establish that the bytes are the ones the backup took. This
# establishes that those bytes are something `tar` can open, which is what the
# restore below actually asks of them.
run_check "an archive in ${SRC_ABS} does not read as a gzipped tar." \
  docker run --rm -v "${SRC_ABS}:/backup:ro" alpine sh -c \
  'for archive in /backup/*.tgz; do tar tzf "$archive" >/dev/null || exit 1; done'

# `pg_restore -l` parses the custom-format table of contents without opening a
# database, so the dump is proven loadable while the database it would replace
# still exists.
run_check "postgres.dump does not read as a custom-format pg_dump archive." \
  docker run --rm -v "${SRC_ABS}:/backup:ro" --entrypoint pg_restore "$postgres_image" -l /backup/postgres.dump

for volume in "${VOLUMES[@]}"; do
  full="${PROJECT}_${volume}"
  echo "  restoring $full"
  remove_volume "$full"
  docker volume create "$full" >/dev/null
  docker run --rm \
    -v "${full}:/data" \
    -v "${SRC_ABS}:/backup:ro" \
    alpine sh -c "tar xzf /backup/${volume}.tgz -C /data"
done

# Redis carries in-flight execution belonging to the instance being replaced.
# Left in place it would replay streams and hot state from a newer run against
# an older database — the stale replay the backup omits Redis to avoid.
echo "  discarding redis state"
remove_volume "${PROJECT}_redis_data"

echo "  recreating database"
remove_volume "${PROJECT}_postgres_data"
# `-p` matters: AFLOW_PROJECT scopes every volume this script destroys, and
# without it compose would target the name hard-coded in the file instead —
# restoring into a different instance than the one just emptied.
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d postgres >/dev/null

postgres_container=""
for _ in $(seq 1 60); do
  postgres_container="$(docker ps \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=postgres" \
    --filter "health=healthy" --quiet)"
  [ -n "$postgres_container" ] && break
  sleep 2
done

if [ -z "$postgres_container" ]; then
  echo "error: postgres did not become healthy — nothing was restored into it." >&2
  exit 1
fi

echo "  loading dump"
docker exec -i "$postgres_container" \
  pg_restore -U phoenix -d phoenix --clean --if-exists --no-owner < "${SRC_ABS}/postgres.dump"

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" stop postgres >/dev/null

echo "Restored ${PROJECT} from ${SRC_ABS}"
echo "Start it with: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} up -d"
