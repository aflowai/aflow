#!/usr/bin/env node
/**
 * Writes the installation bundle a collaborator receives.
 *
 * The bundle is the whole install: a Compose file with nothing to build and an
 * image pinned by digest, an environment template, and the pull, upgrade and
 * rollback procedures. It is emitted at release time rather than committed,
 * because the digest it pins does not exist until the image is pushed — and a
 * bundle pinned to anything weaker than a digest lets the image move under an
 * instance somebody has already installed.
 *
 * Usage:
 *   node scripts/appliance-bundle.mjs --image ghcr.io/owner/name@sha256:…
 *                                      [--out dir] [--repo owner/name]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  BAKED_API_PORT,
  bundleStillBuilds,
  consumerCompose,
  floatingImages,
  relativeBindSources,
} from '@aflow/lib/appliance-bundle';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const valueOf = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const image = valueOf('--image');
if (image === undefined) {
  console.error('[bundle] --image ghcr.io/owner/name@sha256:… is required');
  process.exit(2);
}
const outDir = resolve(REPO, valueOf('--out') ?? 'dist/appliance-bundle');

// Which repository's attestations verify this image. Passed in rather than
// derived from the image reference: the registry namespace is the OWNER, and the
// repository name is not recoverable from it.
const attestationRepo = valueOf('--repo');

const source = readFileSync(join(REPO, 'docker-compose.local.yml'), 'utf-8');

// Resolved here rather than inside the transform, so the transform stays a
// pure function a test can drive without a network or a daemon.
// The digest is the hash of the manifest bytes, so it is computed from them
// rather than read out of a formatted field. `--format` is honoured by some
// buildx versions and silently ignored by others, which yields the default
// human-readable block where a digest was expected — a difference between a
// developer's Docker Desktop and a runner's CLI, and exactly the kind that
// surfaces during a release rather than before one.
const pinned = {};
for (const reference of floatingImages(source)) {
  const raw = execFileSync('docker', ['buildx', 'imagetools', 'inspect', reference, '--raw'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  pinned[reference] = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

const { yaml, changes } = consumerCompose(source, { image, pinned });

// Asked of the output rather than trusted from the transform: the one property
// the whole bundle rests on is that a machine with Docker and nothing else can
// start it.
if (bundleStillBuilds(yaml)) {
  console.error('[bundle] the derived file still describes something to build');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'docker-compose.yml'), yaml);

// Bind sources travel with the file or they are not there. Docker creates a
// directory where a missing one should be, so Postgres starts, finds no `.sql`
// in `docker-entrypoint-initdb.d`, never creates the extensions, and the first
// migration fails against a database that reported healthy.
for (const relative of relativeBindSources(yaml)) {
  const target = join(outDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(REPO, relative), target);
  changes.push(`carried ${relative}, which the Compose file bind-mounts`);
}

// Backup and restore are shipped rather than described. Reproducing them in
// prose got the database user, the volume names and one of the two volumes
// wrong, and each of those mistakes produces an archive that looks like a
// backup and restores nothing.
for (const relative of [
  'scripts/appliance-backup.sh',
  'scripts/appliance-restore.sh',
  // Shipped so an operator can check the install rather than trust it — and so
  // the release verifies with the copy they receive rather than one beside the
  // source it was built from.
  'scripts/appliance-smoke.sh',
  'scripts/appliance-smoke.mjs',
]) {
  const target = join(outDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(REPO, relative), target);
  changes.push(`carried ${relative}`);
}

writeFileSync(
  join(outDir, '.env.example'),
  `# The appliance generates its own secrets on first boot, so this file is
# optional. Copy it to \`.env\` beside the Compose file to change a default.
#
# The API port is not here. The published image has its API origin compiled
# into the browser bundle, so moving that port starts a stack whose web app
# calls an origin nothing answers on. It is fixed at ${BAKED_API_PORT}.

# The port the web app is published on.
#AFLOW_WEB_PORT=3001

# Where Docker keeps the sandbox scratch directory, for the optional compute
# profile only. It must be a path the host Docker daemon can resolve, because
# the daemon is what mounts it.
#AFLOW_SANDBOX_DIR=/tmp/aflow-sandbox
`,
);

writeFileSync(
  join(outDir, 'README.md'),
  `# Aflow appliance

Everything here is the install. You need Docker, and nothing else — no clone,
no Node, no dependency install.

The image is \`${image}\`, pinned by digest: the same bytes every time, and it
cannot move under an instance you have already installed.

## Install

In this folder:

\`\`\`sh
docker compose pull
docker compose up -d
\`\`\`

The first pull moves several gigabytes. Afterwards, open
http://localhost:\${AFLOW_WEB_PORT:-3001}.

Compose warns that \`AFLOW_SANDBOX_DIR\` is unset. That is expected: it is only
read by the optional compute profile below, and it has no default on purpose —
the path has to be one the host Docker daemon can resolve, and a default that
looked right would mount an empty directory into every sandbox.

First boot generates the instance secret and the credential-encryption key and
keeps them in a volume. Nothing is asked of you, and nothing is sent anywhere.

${
  attestationRepo === undefined
    ? ''
    : `## Verify what you pulled

The digest above says the bytes cannot change. It does not say where they came
from — for that the image carries an attestation, signed at build time and
recorded in a public transparency log:

\`\`\`sh
gh attestation verify oci://${image} --repo ${attestationRepo}
\`\`\`

It prints the workflow and the commit that produced these bytes. A digest with
no attestation, or one naming a different repository or workflow, did not come
from this project's release pipeline — whatever else it may be.

The release also publishes a CycloneDX inventory, \`sbom.cdx.json\`, attested against
the same digest: one that verifies is the one this build produced rather than one
edited afterwards.

`
}## What runs, and what does not

The default stack is the product: database, cache, API, worker and web. Two
services are opt-in and absent until you ask for them:

\`\`\`sh
docker compose --profile mcp up -d      # an MCP endpoint on loopback
docker compose --profile compute up -d  # sandboxed code execution
\`\`\`

The compute profile mounts the host Docker socket. That is host root whoever
holds it — enable it only if you accept that on this machine.

### Connecting a client to the MCP endpoint

The endpoint mints no credential and holds no directory of its own, so a client
authenticates with a key you issue. Open the web app, go to **Settings → API
keys**, create one, and copy it — it is shown once. Then point the client at
\`http://127.0.0.1:3100\` with that key as a bearer token:

\`\`\`json
{
  "mcpServers": {
    "aflow": {
      "url": "http://127.0.0.1:3100",
      "headers": { "Authorization": "Bearer phx_..." }
    }
  }
}
\`\`\`

A session that arrives without one is refused rather than admitted as nobody,
and the \`auth_status\` tool says what is missing.

## Upgrade

Replace the digest in \`docker-compose.yml\` with the one from the new release,
then:

\`\`\`sh
docker compose pull
docker compose up -d
\`\`\`

Your volumes are untouched, and migrations run before the API starts. Take a
backup first regardless — see \`Back up\` below.

## Roll back

Migrations are forward-only, so rolling the image back is not enough on its own:
a newer schema stays. Roll back by restoring a backup taken before the upgrade,
then putting the previous digest back.

Keep the digest you are running written down. \`docker compose config\` prints
the one in effect.

## Back up

\`\`\`sh
bash scripts/appliance-backup.sh ./my-backup
\`\`\`

Run it before every upgrade. It dumps the database rather than copying its data
directory — a \`tar\` of a live PostgreSQL directory is a physical copy taken
while pages are being written, which is not a consistent snapshot — and it takes
the instance configuration and the payload volume with it.

All three or none. A database restored without the instance configuration has
credential rows nothing can read, because the key that wrapped them lived in
the volume that was skipped; and without the payload volume its payload
references resolve to files that are not there.

\`\`\`sh
bash scripts/appliance-restore.sh ./my-backup
\`\`\`

The scripts are shipped rather than described on purpose. An earlier draft of
this file spelled the commands out and got the database user, the volume names
and one of the two volumes wrong — each of which produces an archive that looks
like a backup and restores nothing.
`,
);

console.log(`[bundle] wrote ${outDir}`);
for (const change of changes) console.log(`[bundle]   ${change}`);
