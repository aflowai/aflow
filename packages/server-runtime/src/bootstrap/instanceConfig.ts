/**
 * The instance's own identity and secrets, established once and then read.
 *
 * An appliance cannot ask an operator to invent a credential-wrapping key
 * before it will start, and it must not ship one — a key that arrives in the
 * image is a key every instance shares. So the first boot generates both, and
 * every boot after reads what the first one wrote.
 *
 * The tenant and owner ids are recorded here for the reason the secrets are:
 * they are the instance, and nothing else in a backup carries them. The
 * overrides that pin them live in `.env.local`, which is neither of the volumes
 * a backup archives, so an instance restored onto a clean host without them
 * comes up under the default ids, provisions a second tenant beside the one it
 * just loaded, and leaves the restored tenant unreachable. They are identity
 * rather than credentials — no provider key is written here.
 *
 * The file is shell-sourceable because the services that need these values
 * read it with `.` before exec'ing — and every value is single-quoted, because
 * an operator may supply one and a secret containing `$`, a backtick, or a
 * space would otherwise be rewritten or executed by the shell that sourced it.
 *
 * It is written `0600` because it is the whole of the instance's authority:
 * the secret that authenticates the BFF, and the key that unwraps every stored
 * credential. Losing it is losing the credentials; leaking it is granting
 * owner access.
 *
 * Every appliance process runs as the same user, so file ownership separates
 * none of them and what a container has mounted is the whole of what it can
 * read. A process handed the full file can reopen it after dropping a value
 * from its environment, so the values are also cut into one file per audience —
 * the wrapping key for the worker, the instance secret for the web BFF — and
 * each service mounts only its own.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { LOCAL_EDITION_OWNER_ID, LOCAL_EDITION_TENANT_ID } from '@aflow/schemas';

export const INSTANCE_CONFIG_FILENAME = 'instance.env';

/** Shortest instance secret the API's own startup check accepts. */
const MIN_INSTANCE_SECRET_LENGTH = 32;

const uuid = z.string().uuid();

function isUuid(value: string): boolean {
  return uuid.safeParse(value).success;
}

/**
 * Whether a value is a secret this file invents, or an id the instance is
 * pinned to.
 *
 * The two are reported differently: a generated secret is news the operator
 * has to act on, while a recorded id is the instance writing down what it
 * already resolved to.
 */
type ManagedKind = 'secret' | 'identity';

interface ManagedValue {
  kind: ManagedKind;
  /** The value adopted when neither the file nor the environment holds one. */
  fresh: () => string;
  accepts: (value: string) => boolean;
  /** Phrased as the tail of `must …`. */
  requirement: string;
  /** What adopting something other than the stored value would cost. */
  cost: string;
}

/** Variables this file owns. Anything else in it is left alone. */
const MANAGED = {
  PHOENIX_INSTANCE_SECRET: {
    kind: 'secret',
    fresh: () => randomBytes(32).toString('hex'),
    // Restated rather than imported: the length lives in the request
    // authentication plugin, and a bootstrap that pulled Fastify in to read
    // one constant would be the heavier coupling of the two.
    accepts: (value) => value.length >= MIN_INSTANCE_SECRET_LENGTH,
    requirement: `be at least ${String(MIN_INSTANCE_SECRET_LENGTH)} characters`,
    cost: 'The web BFF would then present a secret this API does not hold, and every call it proxies would be refused.',
  },
  CREDENTIAL_ENCRYPTION_KEY: {
    kind: 'secret',
    fresh: () => randomBytes(32).toString('base64'),
    accepts: (value) => Buffer.from(value, 'base64').length === 32,
    requirement: 'decode from base64 to exactly 32 bytes',
    cost: 'Everything wrapped with the stored key would become unreadable.',
  },
  REDIS_PASSWORD: {
    kind: 'secret',
    fresh: () => randomBytes(32).toString('hex'),
    accepts: (value) => value.length >= MIN_INSTANCE_SECRET_LENGTH,
    requirement: `be at least ${String(MIN_INSTANCE_SECRET_LENGTH)} characters`,
    cost: 'Every service would authenticate to Redis with a password it no longer holds, and the whole stack would stop.',
  },
  PHOENIX_HOST_REDIS_PASSWORD: {
    kind: 'secret',
    fresh: () => randomBytes(32).toString('hex'),
    accepts: (value) => value.length >= MIN_INSTANCE_SECRET_LENGTH,
    requirement: `be at least ${String(MIN_INSTANCE_SECRET_LENGTH)} characters`,
    cost: 'A paired host executor would authenticate with a password Redis no longer knows, and its jobs would stop being claimed.',
  },
  PHOENIX_LOCAL_TENANT_ID: {
    kind: 'identity',
    fresh: () => LOCAL_EDITION_TENANT_ID,
    accepts: isUuid,
    requirement: 'be a UUID',
    cost: "This instance's data lives in the stored tenant's schema, and nothing would reach it.",
  },
  PHOENIX_LOCAL_OWNER_ID: {
    kind: 'identity',
    fresh: () => LOCAL_EDITION_OWNER_ID,
    accepts: isUuid,
    requirement: 'be a UUID',
    cost: 'The stored owner holds every workspace membership, so the instance would come up as a user with none.',
  },
} satisfies Record<string, ManagedValue>;

type ManagedKey = keyof typeof MANAGED;

/**
 * A service that uses some of these values and not the rest.
 *
 * Withholding a value from a process's environment is not withholding it from
 * the process: the full file is a file, and anything that can open it can read
 * back what was unset. Each audience therefore gets a file carrying only the
 * keys it uses, and the appliance mounts that file rather than the whole one.
 */
interface ConfigAudience {
  /** Names the directory bootstrap writes this audience's file into. */
  directoryVar: string;
  filename: string;
  keys: readonly ManagedKey[];
  /**
   * Owner-only unless the reader runs as a different user than the writer.
   * Stated per audience rather than defaulted, because getting it wrong is a
   * server that will not start or a secret readable by more than needs it.
   */
  mode: number;
}

/** Audiences cut from the full file, keyed by the service that reads them. */
const CONFIG_AUDIENCES = {
  worker: {
    directoryVar: 'PHOENIX_WORKER_CONFIG_DIR',
    filename: 'wrapping-key.env',
    // The orchestrator and executors unwrap credentials, and none of them
    // authenticates to the API — so a compromised one must not be able to act
    // as the owner. They do all speak to Redis, which now asks who they are.
    keys: ['CREDENTIAL_ENCRYPTION_KEY', 'REDIS_PASSWORD'],
    mode: 0o600,
  },
  web: {
    directoryVar: 'PHOENIX_WEB_CONFIG_DIR',
    filename: 'instance-secret.env',
    // The BFF authenticates to the API and stores nothing, so the wrapping key
    // would only widen what a compromise of the browser-facing process reaches.
    keys: ['PHOENIX_INSTANCE_SECRET'],
    mode: 0o600,
  },
  compute: {
    directoryVar: 'PHOENIX_COMPUTE_CONFIG_DIR',
    filename: 'redis-password.env',
    // The sandbox host holds no model key, no mail credential and no wrapping
    // key by decision, and consuming its job stream is no reason to change
    // that. This is the whole of what it gets.
    keys: ['REDIS_PASSWORD'],
    mode: 0o600,
  },
  redis: {
    directoryVar: 'PHOENIX_REDIS_CONFIG_DIR',
    filename: 'redis.env',
    // Redis needs its own password to answer its own health check, and nothing
    // else. Handing it the full file would put the credential-wrapping key in
    // the one container whose whole job is to hold data at rest.
    keys: ['REDIS_PASSWORD'],
    // Group-readable, because Redis reads this as a different uid. The shared
    // group is stated in the compose file rather than inherited from whatever
    // gid two unrelated images happen to agree on today.
    mode: 0o640,
  },
  host: {
    directoryVar: 'PHOENIX_HOST_CONFIG_DIR',
    filename: 'host-redis.env',
    // The paired executor runs on the operator's machine and holds neither the
    // wrapping key nor the instance secret: it claims host jobs and reports
    // their results, which is all its credential is good for.
    keys: ['PHOENIX_HOST_REDIS_PASSWORD'],
    mode: 0o600,
  },
} satisfies Record<string, ConfigAudience>;

/**
 * A supplied value contradicts the one this instance already holds.
 *
 * Named rather than generic, because the operator's next step depends on which
 * value they meant: keep the stored one by removing it from the environment,
 * or restore the instance the supplied one belongs to.
 */
export class ConflictingInstanceValueError extends Error {
  constructor(
    readonly key: string,
    readonly path: string,
    cost: string,
  ) {
    super(
      `${key} in the environment differs from the one stored in ${path}. ${cost} ` +
        `Remove ${key} from the environment to keep the stored value, or restore the ` +
        'instance it belongs to.',
    );
    this.name = 'ConflictingInstanceValueError';
  }
}

/** A value the API would refuse to start with, caught before it is stored. */
export class InvalidInstanceValueError extends Error {
  constructor(
    readonly key: string,
    readonly path: string,
    origin: 'supplied' | 'stored' | 'generated',
    requirement: string,
  ) {
    super(
      `Refusing to use ${key}: the ${origin} value must ${requirement}. ` +
        `The API rejects it at startup, and storing it in ${path} would make the ` +
        'corrected value supplied afterwards read as a conflict with it.',
    );
    this.name = 'InvalidInstanceValueError';
  }
}

export interface InstanceConfigResult {
  path: string;
  values: Record<string, string>;
  /** Secrets this run had to invent. Empty on every boot after the first. */
  generated: string[];
  /** Identity pins this run wrote down. Empty once the file carries them. */
  recorded: string[];
  /**
   * Where each audience's file was written, keyed by audience. Empty for a
   * caller that named no audience directory — a developer running bootstrap by
   * hand serves every process from one environment.
   */
  audiences: Record<string, string>;
}

function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const raw = trimmed.slice(separator + 1);
    values[trimmed.slice(0, separator)] = unquote(raw);
  }
  return values;
}

/** Reverse of {@link shellQuote}; leaves an unquoted legacy value alone. */
function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith("'") || !raw.endsWith("'")) return raw;
  return raw.slice(1, -1).replaceAll("'\\''", "'");
}

/**
 * POSIX single-quoting: everything inside is literal, and an embedded quote is
 * closed, escaped, and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function serializeEnvFile(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return `${keys.map((key) => `${key}=${shellQuote(values[key] ?? '')}`).join('\n')}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return null;
  }
}

/**
 * Write through a temporary name and rename, because a process killed mid-write
 * would otherwise leave a truncated file — and the next boot would read the
 * credential-encryption key as missing and generate a new one, which does not
 * decrypt anything already stored.
 */
async function writeSecretFile(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(staging, contents, { mode });
    await chmod(staging, mode);
    await rename(staging, path);
  } catch (err) {
    await rm(staging, { force: true });
    throw err;
  }
}

/**
 * Cut the per-audience files for every audience the caller named a directory
 * for.
 *
 * Rewritten whenever the cut disagrees with what is on disk, which is what a
 * restore relies on: it replaces the file these are taken from and leaves the
 * cuts where they are, so a boot that read them unchanged would serve the
 * previous instance's secrets.
 */
async function writeAudienceFiles(
  values: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const written: Record<string, string> = {};

  for (const [audience, { directoryVar, filename, keys, mode }] of Object.entries(
    CONFIG_AUDIENCES,
  )) {
    const directory = env[directoryVar]?.trim();
    if (directory === undefined || directory === '') continue;

    const subset: Record<string, string> = {};
    for (const key of keys) {
      const value = values[key];
      if (value === undefined) {
        throw new Error(
          `${key} is not a value this file establishes, so ${filename} cannot be cut from it.`,
        );
      }
      subset[key] = value;
    }

    const path = join(directory, filename);
    const desired = serializeEnvFile(subset);
    const fileMode = mode;
    if ((await readIfPresent(path)) !== desired) {
      await writeSecretFile(path, desired, fileMode);
    }
    await chmod(path, fileMode);
    written[audience] = path;
  }

  return written;
}

/**
 * Read the instance config, establishing any value it does not yet hold, and
 * apply the result to `env`.
 *
 * A value already present in `env` wins and is written through, so an operator
 * restoring a backup can supply the original key and have the file agree with
 * it rather than quietly generate a second one that decrypts nothing.
 */
export async function ensureInstanceConfig(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstanceConfigResult> {
  const path = join(directory, INSTANCE_CONFIG_FILENAME);

  const contents = await readIfPresent(path);
  const existing: Record<string, string> = contents === null ? {} : parseEnvFile(contents);

  const values = { ...existing };
  const generated: string[] = [];
  const recorded: string[] = [];

  for (const [key, managed] of Object.entries(MANAGED)) {
    const supplied = env[key]?.trim();
    const stored = values[key]?.trim();
    const hasStored = stored !== undefined && stored !== '';
    const hasSupplied = supplied !== undefined && supplied !== '';

    // A supplied value that disagrees with a stored one is refused rather than
    // written through. Overwriting is silent and one-way: the rows in the
    // database stay wrapped with the key being discarded, and this file is the
    // only place that key existed. A stale value left in an env file would
    // otherwise destroy the instance's credentials on an ordinary restart.
    if (hasSupplied && hasStored && supplied !== stored) {
      throw new ConflictingInstanceValueError(key, path, managed.cost);
    }

    let chosen: string;
    let origin: 'supplied' | 'stored' | 'generated';
    if (hasSupplied) {
      chosen = supplied;
      origin = 'supplied';
    } else if (hasStored) {
      chosen = stored;
      origin = 'stored';
    } else {
      chosen = managed.fresh();
      origin = 'generated';
      (managed.kind === 'secret' ? generated : recorded).push(key);
    }

    // Checked before the file is written, not after. A value the API refuses at
    // startup, once stored, is a value every corrected one supplied afterwards
    // conflicts with — so the instance would be unbootable and unfixable from
    // the environment at the same time.
    if (!managed.accepts(chosen)) {
      throw new InvalidInstanceValueError(key, path, origin, managed.requirement);
    }

    values[key] = chosen;
  }

  if (
    generated.length > 0 ||
    recorded.length > 0 ||
    serializeEnvFile(values) !== serializeEnvFile(existing)
  ) {
    await writeSecretFile(path, serializeEnvFile(values));
  }

  // Outside the rewrite branch on purpose: a restored file whose values are
  // already complete needs no write, and correcting its permissions only when
  // something happened to change would leave exactly that file — the one that
  // arrived from a backup at 0644 — readable by every local user.
  await chmod(path, 0o600);

  const audiences = await writeAudienceFiles(values, env);

  for (const [key, value] of Object.entries(values)) {
    env[key] = value;
  }

  return { path, values, generated, recorded, audiences };
}

/**
 * Replace one managed value in the instance file, atomically.
 *
 * Rotating a credential in live Redis and in this process's environment is not
 * a rotation: `instance.env` is what survives a restart, and the ACL file is
 * derived from it at boot. A revocation that skipped this reported success and
 * then handed the old credential back on the next restart.
 *
 * Deliberately narrow. `ensureInstanceConfig` refuses a supplied value that
 * disagrees with a stored one, because overwriting a credential-wrapping key is
 * unrecoverable — this is the one path allowed to replace a value, and it takes
 * the key by name so it cannot be pointed at the others by accident.
 */
export async function rotateInstanceValue(
  directory: string,
  key: 'PHOENIX_HOST_REDIS_PASSWORD',
  value: string,
): Promise<string> {
  const path = join(directory, INSTANCE_CONFIG_FILENAME);
  const contents = await readIfPresent(path);
  if (contents === null) {
    throw new Error(
      `No instance configuration at ${path}, so there is nothing to rotate. ` +
        'It is written at first boot.',
    );
  }
  const values = parseEnvFile(contents);
  values[key] = value;
  await writeSecretFile(path, serializeEnvFile(values));
  return path;
}
