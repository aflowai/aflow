#!/usr/bin/env bash
#
# Back up a running Aflow Local instance.
#
# The database is dumped rather than copied: a `tar` of a live PostgreSQL data
# directory is a physical copy taken while pages are being written, which is
# not a consistent snapshot. `pg_dump` takes one without stopping anything.
#
# The artefacts are only useful together — a database restored without its
# encryption key has credential rows nothing can read, its payload refs resolve
# to files that must also be present, and without the tenant and owner ids
# recorded in `instance.env` a clean host boots as a different instance than the
# one whose database it just loaded.
#
#   scripts/appliance-backup.sh [destination-directory]
#
set -euo pipefail

DEST="${1:-./aflow-backup-$(date +%Y%m%d-%H%M%S)}"
PROJECT="${AFLOW_PROJECT:-aflow-local}"
VOLUMES=(instance_config payload_data)

# A trailing slash would put the staging directory below the destination rather
# than beside it, and the publishing `mv` would then move it inside itself.
DEST="${DEST%/}"
if [ -z "$DEST" ]; then
  echo "error: a destination directory is required." >&2
  exit 1
fi

# Refused rather than merged. A second run overwrites some artefacts and leaves
# the rest, and restore only establishes that the files are present — so a set
# assembled from two runs reads as a valid backup of a moment that never was.
if [ -e "$DEST" ]; then
  echo "error: $DEST already exists." >&2
  echo "       A backup is written whole or not at all; reusing a directory would" >&2
  echo "       leave artefacts from two runs in it. Choose a new destination." >&2
  exit 1
fi

# Staged beside the destination and renamed once every artefact is written, so
# an interrupted run leaves nothing a restore would accept.
STAGING="${DEST}.partial.$$"
mkdir -p "$(dirname "$DEST")"
mkdir "$STAGING"
# Restricted before anything is written into it: these archives carry the
# instance secret and the credential-encryption key, and a directory created
# under the usual umask is readable by every local user.
chmod 700 "$STAGING"
STAGING_ABS="$(cd "$STAGING" && pwd)"
trap 'rm -rf "$STAGING_ABS"' EXIT

postgres_container="$(docker ps \
  --filter "label=com.docker.compose.project=${PROJECT}" \
  --filter "label=com.docker.compose.service=postgres" \
  --quiet)"

if [ -z "$postgres_container" ]; then
  echo "error: no running postgres for project ${PROJECT}." >&2
  echo "       Start the instance first — the dump is taken from the live database." >&2
  exit 1
fi

# The instance file is checked before anything is archived, because a backup
# missing it is not a backup: restore would generate a fresh
# CREDENTIAL_ENCRYPTION_KEY and every credential row in the dump beside it would
# stay wrapped with a key nothing holds. A present volume does not establish
# that its contents are usable, and the archive's checksums would attest to the
# damage rather than catch it.
echo "  checking the instance identity"
if ! docker run --rm -v "${PROJECT}_instance_config:/instance:ro" alpine sh -c '
  f=/instance/instance.env
  [ -f "$f" ] || { echo "instance.env is missing"; exit 1; }
  for key in PHOENIX_INSTANCE_SECRET CREDENTIAL_ENCRYPTION_KEY PHOENIX_LOCAL_TENANT_ID PHOENIX_LOCAL_OWNER_ID; do
    grep -q "^${key}=." "$f" || { echo "$key is missing or empty"; exit 1; }
  done
  # The wrapping key is the one value whose shape can be checked here, and the
  # one whose loss is unrecoverable.
  key=$(sed -n "s/^CREDENTIAL_ENCRYPTION_KEY=//p" "$f" | tr -d "\047")
  bytes=$(printf %s "$key" | base64 -d 2>/dev/null | wc -c)
  [ "$bytes" -eq 32 ] || { echo "CREDENTIAL_ENCRYPTION_KEY does not decode to 32 bytes"; exit 1; }
'; then
  echo "error: ${PROJECT}'s instance identity is unusable, so a backup of it would be too." >&2
  echo "       Nothing was written. A running instance still holds these values in memory;" >&2
  echo "       recover them from its environment before restarting it." >&2
  exit 1
fi

echo "  dumping database"
docker exec "$postgres_container" pg_dump -U phoenix -Fc phoenix > "${STAGING_ABS}/postgres.dump"

for volume in "${VOLUMES[@]}"; do
  full="${PROJECT}_${volume}"
  if ! docker volume inspect "$full" >/dev/null 2>&1; then
    echo "error: volume $full does not exist — is the instance named $PROJECT?" >&2
    exit 1
  fi
  echo "  archiving $full"
  # Archived as root, then handed to the caller. Both halves are needed:
  # `instance.env` is 0600 owned by the image's `node` user, so an operator
  # with a different uid cannot read it; and on Linux a rootful engine writes
  # bind-mounted files as uid 0, so the `chmod` below would fail against files
  # the caller does not own. (macOS hides the second half by remapping
  # ownership to the calling user.)
  docker run --rm \
    -v "${full}:/data:ro" \
    -v "${STAGING_ABS}:/backup" \
    alpine sh -c "tar czf /backup/${volume}.tgz -C /data . && chown $(id -u):$(id -g) /backup/${volume}.tgz"
done

# Redis is deliberately absent: it holds in-flight execution, not durable
# state. Restoring a stale stream alongside a restored database would replay
# work the database already recorded as finished — which is why the restore
# discards it rather than leaving the running instance's copy in place.
cat > "${STAGING_ABS}/MANIFEST" <<MANIFEST
project=${PROJECT}
database=postgres.dump
volumes=${VOLUMES[*]}
checksums=SHA256SUMS
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MANIFEST

# Digested inside the image that wrote the archives, so the tool producing the
# sums is the one verifying them on whatever host the restore runs: macOS ships
# `shasum` and no `sha256sum`, and the two disagree on argument spelling.
#
# The MANIFEST is digested with the rest, which is what lets restore treat a
# tampered or truncated manifest as a failed backup rather than a description
# of one.
echo "  checksumming"
docker run --rm \
  -v "${STAGING_ABS}:/backup" \
  alpine sh -c "cd /backup && sha256sum MANIFEST postgres.dump *.tgz > SHA256SUMS && chown $(id -u):$(id -g) SHA256SUMS"

chmod 600 "${STAGING_ABS}"/*

mv "$STAGING_ABS" "$DEST"
trap - EXIT
DEST_ABS="$(cd "$DEST" && pwd)"

echo "Backed up ${PROJECT} to ${DEST_ABS}"
echo "Keep instance_config.tgz with the rest: it holds the key that unwraps every"
echo "credential, and the tenant and owner ids this instance answers as."
echo "Model-provider keys are not in here — they live in .env.local beside the compose file."
