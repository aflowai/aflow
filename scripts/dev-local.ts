/**
 * One command for running the local edition from source.
 *
 * The appliance runs compiled output in containers, so an edit costs a rebuild.
 * The same edition runs perfectly well under `tsx watch`, but reaching it by
 * hand means knowing three unobvious things: that a development `.env`
 * configures planes this edition refuses to start beside, that the instance
 * identity is a file rather than a variable, and that the coding lane and voice
 * are not part of the product. This wraps all three.
 *
 * The edition is set for these processes only; unset, `PHOENIX_EDITION` still
 * resolves to `enterprise`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTERPRISE_ONLY_ENV_KEYS } from '@aflow/schemas';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One machine, one local instance — which is what an appliance is.
 *
 * Per-checkout was the obvious default and the wrong one: every worktree minted
 * its own instance identity against the one Postgres they all share, so a
 * provider credential stored by one is undecryptable by every other. The
 * failure surfaces two systems away, as a decryption error on an agent turn,
 * naming a wrapping key that means nothing to the reader.
 *
 * A caller naming a directory still means it, which is how a deliberately
 * separate instance is asked for.
 */
const EXPLICIT_INSTANCE_DIR = process.env['PHOENIX_INSTANCE_DIR']?.trim();
const INSTANCE_DIR =
  EXPLICIT_INSTANCE_DIR !== undefined && EXPLICIT_INSTANCE_DIR !== ''
    ? EXPLICIT_INSTANCE_DIR
    : join(homedir(), '.aflow', 'dev-local');

/**
 * Blanked rather than deleted: the values live in the `.env` this repository
 * shares with the enterprise stack, and the dev runner merges that file over
 * whatever the parent set. A blank reads as unset to the descriptor and
 * survives the merge, where an unset variable would simply be refilled.
 */
const editionEnv: Record<string, string> = { PHOENIX_EDITION: 'community-local' };
for (const key of ENTERPRISE_ONLY_ENV_KEYS) editionEnv[key] = '';

/**
 * The same class of collision as the keys above, and the one that actually
 * stops the boot: a development `.env` carrying `HOST=0.0.0.0` publishes the
 * API beyond loopback, which this edition refuses outright. Blanked rather
 * than pinned to an address, because unset is what the descriptor resolves
 * from — it answers loopback on its own.
 */
editionEnv['HOST'] = '';

/**
 * A caller naming a database means it, so it survives the same merge. Without
 * this the shared `.env` decides, and pointing this at a second instance would
 * silently provision one database and run against another.
 */
const explicitDatabaseUrl = process.env['PHOENIX_DEV_LOCAL_DATABASE_URL']?.trim();
if (explicitDatabaseUrl !== undefined && explicitDatabaseUrl !== '') {
  editionEnv['DATABASE_URL'] = explicitDatabaseUrl;
}

/** A datastore already listening is the only thing `infra:up` is asked for. */
function reachable(url: string | undefined, fallbackPort: number): Promise<boolean> {
  const parsed = url === undefined ? undefined : URL.parse(url);
  const host = parsed?.hostname ?? '127.0.0.1';
  const port = Number(
    parsed?.port !== undefined && parsed.port !== '' ? parsed.port : fallbackPort,
  );
  return new Promise((resolve) => {
    const socket = connect({ host, port })
      .on('connect', () => {
        socket.destroy();
        resolve(true);
      })
      .on('error', () => {
        resolve(false);
      });
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Ctrl-C ends this, once.
 *
 * The terminal signals the whole foreground group, so the runner underneath
 * begins its own ten-second graceful shutdown while this process is still
 * waiting on it — and with nothing here managing that wait, the prompt came
 * back before the runner had finished printing, which reads as a hang and
 * invites a second Ctrl-C. Forwarding and then waiting for the child to
 * actually go makes one keystroke enough.
 *
 * A child killed by a signal is a stop, not a failure: `code` is null there,
 * and reporting it as `exited with null` turns an ordinary Ctrl-C into an error.
 */
function run(command: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', cwd: REPO_ROOT, env });

    let stopping = false;
    const forward = (signal: NodeJS.Signals) => {
      stopping = true;
      try {
        child.kill(signal);
      } catch {
        // Already gone; the exit handler below still settles the promise.
      }
    };
    const onInt = () => {
      forward('SIGINT');
    };
    const onTerm = () => {
      forward('SIGTERM');
    };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      if (code === 0 || signal !== null || stopping) {
        resolve();
        return;
      }
      reject(new Error(`\`${command}\` exited with ${String(code)}`));
    });
  });
}

/**
 * Carry a checkout's existing instance identity to the shared location.
 *
 * The identity that matters is whichever one wrapped the credentials already in
 * the database these checkouts share, and minting a fresh one is the failure
 * this default exists to remove — so an existing `instance.env` is adopted
 * rather than superseded. Copied, never moved: the checkout it came from is left
 * able to explain itself, and a file already at the destination is never
 * touched, because the first adoption is the one the database agrees with.
 */
async function adoptCheckoutInstance(): Promise<void> {
  // Only the default location adopts. A caller naming a directory is asking for
  // the instance that lives there, and seeding it with a different identity
  // would answer a request for a separate instance with a copy of the shared
  // one — which is the opposite of what was asked, and silent.
  if (EXPLICIT_INSTANCE_DIR !== undefined && EXPLICIT_INSTANCE_DIR !== '') return;

  const destination = join(INSTANCE_DIR, 'instance.env');
  if (existsSync(destination)) return;

  const checkoutInstance = join(REPO_ROOT, '.aflow-local', 'instance.env');
  if (!existsSync(checkoutInstance)) return;

  await mkdir(INSTANCE_DIR, { recursive: true, mode: 0o700 });
  await copyFile(checkoutInstance, destination);
  await chmod(destination, 0o600);
  console.log(
    `[dev:local] adopted this checkout's instance identity into ${INSTANCE_DIR}\n` +
      `[dev:local]   from ${checkoutInstance}\n` +
      '[dev:local]   one machine now has one local instance, so stored credentials decrypt\n' +
      '[dev:local]   in every checkout instead of only the one that wrote them',
  );
}

/** `instance.env` is shell-quoted, which is one unquoting rather than a parser. */
async function readInstanceConfig(): Promise<Record<string, string>> {
  const raw = await readFile(join(INSTANCE_DIR, 'instance.env'), 'utf8');
  const values: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) continue;
    values[match[1]] = match[2].replace(/^'(.*)'$/s, '$1').replace(/'\\''/g, "'");
  }
  return values;
}

async function main(): Promise<void> {
  // The loader the root scripts run under merges `.env` over the shell, so the
  // edition reaches `db:migrate` the way it reaches the dev runner.
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...editionEnv,
    PHOENIX_INSTANCE_DIR: INSTANCE_DIR,
    PHOENIX_DEV_ENV_OVERRIDES: JSON.stringify(editionEnv),
  };

  // Started only when something is missing, and judged by what is listening
  // rather than by the exit code: `infra:up` fails on a container that already
  // exists, which is the normal state of a machine that has run this before.
  const datastores = async (): Promise<boolean> =>
    (await reachable(base['DATABASE_URL'], 5433)) && (await reachable(base['REDIS_URL'], 6379));
  if (await datastores()) {
    console.log('[dev:local] Postgres and Redis already listening');
  } else {
    console.log('[dev:local] starting Postgres and Redis');
    await run('yarn infra:up', base).catch(() => undefined);
    if (!(await datastores())) {
      throw new Error('Postgres or Redis is not reachable. Start them with `yarn infra:up`.');
    }
  }

  console.log('[dev:local] applying migrations');
  await run('yarn db:migrate', base);

  await adoptCheckoutInstance();

  console.log(`[dev:local] provisioning the instance in ${INSTANCE_DIR}`);
  await run('yarn bootstrap:local', base);

  // Every value in the file, not only the secret: it also carries the wrapping
  // key that unwraps stored credentials and the pinned tenant and owner, and a
  // process missing those authenticates but decrypts nothing.
  const instance = await readInstanceConfig();
  if (instance['PHOENIX_INSTANCE_SECRET'] === undefined) {
    throw new Error(`No PHOENIX_INSTANCE_SECRET in ${join(INSTANCE_DIR, 'instance.env')}`);
  }

  // The browser's copy of the pinned tenant, which `.env` fills with the hosted
  // development one. The `session.events` subscribe carries a tenant hint and
  // the gateway compares it to the connection's, so a stale copy denied every
  // subscription and left chat on "Connecting to agent…" with nothing else
  // failing. Taken from the file the server pins from, so the two cannot
  // disagree. The appliance leaves it unset and the hint is skipped; here it is
  // set, so the check does its job rather than being switched off.
  const localTenantId = instance['PHOENIX_LOCAL_TENANT_ID'];
  if (localTenantId === undefined) {
    throw new Error(`No PHOENIX_LOCAL_TENANT_ID in ${join(INSTANCE_DIR, 'instance.env')}`);
  }

  // The dev runner merges `.env` over its own environment, so what must win is
  // handed to it separately and applied last.
  // The development Redis's password is the machine's, which the stack's loader
  // lays into REDIS_URL (scripts/stackEnv.mjs). The instance file's REDIS_PASSWORD is
  // the appliance's, and ioredis lays a password option over the URL's, so it
  // would replace the right one.
  const redisPassword = { REDIS_PASSWORD: '' };
  const overrides = {
    ...editionEnv,
    ...instance,
    ...redisPassword,
    // The capacity every pool is sized from; the default is the hosted tier's,
    // and the development Postgres runs with its own default of 100.
    DB_SERVER_MAX_CONNECTIONS: base['DB_SERVER_MAX_CONNECTIONS'] ?? '100',
    NEXT_PUBLIC_TENANT_ID: localTenantId,
    // What pairing tells a machine to connect to. The route's own default is the
    // appliance's published port; a machine paired against this stack must be
    // sent to the Redis this stack runs on.
    ...(process.env['PHOENIX_HOST_REDIS_URL']?.trim()
      ? {}
      : { PHOENIX_HOST_REDIS_URL: base['REDIS_URL'] ?? 'redis://127.0.0.1:6379' }),
  };

  console.log('[dev:local] starting the local edition — http://localhost:3001\n');
  await run('node scripts/dev.mjs --profile local', {
    ...base,
    ...instance,
    ...redisPassword,
    // Named so the single-stack refusal tells the reader the command they ran,
    // rather than the one the runner underneath it happens to be.
    PHOENIX_DEV_RESTART_HINT: 'yarn dev:local',
    PHOENIX_DEV_ENV_OVERRIDES: JSON.stringify(overrides),
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  console.error(`[dev:local] ${message}`);
  process.exit(1);
});
