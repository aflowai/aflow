/**
 * The environment a checkout's stack processes see, and the one credential in
 * it that belongs to the machine rather than the checkout (Plan 315 D20).
 *
 * Every checkout on a machine shares one Redis container, so its password is
 * the machine's: it lives in `stack.env` in the host directory — the one the
 * sandbox withholds from jobs — written once by the first `yarn start` or
 * `yarn redis:password`. A checkout's `REDIS_URL` names where Redis is, and the
 * password is laid into it here, so no checkout mints a password of its own.
 *
 * Every root script that starts a process reads its environment through
 * `scripts/with-stack-env.mjs`, which composes it here; `scripts/dev.mjs`,
 * `scripts/infra.mjs`, `yarn start` and the integration suites' probe
 * (`scripts/stackRedis.mjs`) read this module directly.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const REDIS_URL_KEY = 'REDIS_URL';
export const REDIS_PASSWORD_KEY = 'REDIS_PASSWORD';
/** The key in `stack.env`, and the variable compose starts Redis with. */
export const STACK_PASSWORD_KEY = 'AFLOW_DEV_REDIS_PASSWORD';
export const STACK_ENV_FILE = 'stack.env';
export const LOCAL_REDIS_URL = 'redis://localhost:6379';
/** The hosts this machine's Redis answers on; `URL` keeps an IPv6 host in brackets. */
export const MACHINE_REDIS_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * The values the dev runner's caller must win with, as JSON. `.env` is merged
 * over the shell, so a value merely exported would be refilled from the file.
 */
export const DEV_ENV_OVERRIDES_KEY = 'PHOENIX_DEV_ENV_OVERRIDES';
const REDIS_PASSWORD_BYTES = 32;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

/** `KEY=value` lines, as both `.env` and the shell-quoted `instance.env` write them. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    const raw = match[2].trim();
    values[match[1]] = /^'.*'$/s.test(raw)
      ? raw.slice(1, -1).replace(/'\\''/g, "'")
      : /^".*"$/s.test(raw)
        ? raw.slice(1, -1)
        : raw.replace(/\s+#.*$/, '');
  }
  return values;
}

export function readEnvFile(path) {
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
}

/**
 * This machine's host directory, as the host executor resolves it:
 * `PHOENIX_HOST_POLICY_PATH`'s directory, then `PHOENIX_HOST_DIR`, then `~/.aflow`.
 */
export function hostDirOf(env = process.env) {
  const policyPath = env['PHOENIX_HOST_POLICY_PATH']?.trim();
  if (policyPath !== undefined && policyPath !== '') return dirname(policyPath);
  return env['PHOENIX_HOST_DIR']?.trim() || join(homedir(), '.aflow');
}

export function stackEnvPath(env = process.env) {
  return join(hostDirOf(env), STACK_ENV_FILE);
}

/** Hex, so it needs no percent-encoding in a URL and no quoting in compose. */
export function generateRedisPassword() {
  return randomBytes(REDIS_PASSWORD_BYTES).toString('hex');
}

/** The machine's Redis password, or undefined while `stack.env` does not exist. */
export function readMachinePassword(path) {
  if (!existsSync(path)) return undefined;
  const password = parseEnvFile(readFileSync(path, 'utf8'))[STACK_PASSWORD_KEY]?.trim();
  if (password === undefined || password === '') {
    throw new Error(
      `${path} holds no ${STACK_PASSWORD_KEY}. Remove the file and run \`yarn redis:password\` ` +
        'to write a new one; every checkout on this machine reads it.',
    );
  }
  return password;
}

/**
 * The machine's Redis password, generating `stack.env` when there is none.
 * Created exclusively, so two checkouts starting at once agree on one password.
 */
export function ensureMachinePassword(path) {
  const existing = readMachinePassword(path);
  if (existing !== undefined) return { password: existing, created: false };
  mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
  try {
    writeFileSync(path, `${STACK_PASSWORD_KEY}=${generateRedisPassword()}\n`, {
      flag: 'wx',
      mode: OWNER_ONLY_FILE,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { password: readMachinePassword(path), created: false };
  }
  return { password: readMachinePassword(path), created: true };
}

/** The password a Redis URL carries, or undefined when it carries none. */
export function redisPasswordOf(url) {
  const parsed = url === undefined ? null : URL.parse(url);
  if (parsed === null || parsed.password === '') return undefined;
  return decodeURIComponent(parsed.password);
}

/** Whether `url` names this machine's Redis: a loopback host, or no URL at all. */
export function isMachineRedisUrl(url) {
  if (url === undefined || url === '') return true;
  const parsed = URL.parse(url);
  return parsed !== null && MACHINE_REDIS_HOSTS.has(parsed.hostname);
}

/**
 * `url` carrying the machine's password: unchanged when it carries a password
 * of its own, names a Redis on another host, or there is no machine password;
 * the local Redis when it is unset.
 */
export function redisUrlWithMachinePassword(url, machinePassword) {
  if (
    machinePassword === undefined ||
    redisPasswordOf(url) !== undefined ||
    !isMachineRedisUrl(url)
  ) {
    return url;
  }
  const parsed = new URL(url || LOCAL_REDIS_URL);
  parsed.password = encodeURIComponent(machinePassword);
  return parsed.toString();
}

/**
 * What a stack process sees: `.env` over the shell, the instance file over
 * both — the order the dev runner merges them in — and `REDIS_URL` carrying the
 * machine's password.
 */
export function stackEnv(processEnv, dotenv, { instance, machinePassword } = {}) {
  const env = { ...processEnv, ...dotenv, ...instance };
  const redisUrl = redisUrlWithMachinePassword(env[REDIS_URL_KEY], machinePassword);
  return redisUrl === undefined ? env : { ...env, [REDIS_URL_KEY]: redisUrl };
}

/** The values the dev runner's caller handed it to win with (`DEV_ENV_OVERRIDES_KEY`). */
export function devEnvOverrides(processEnv) {
  const overrides = processEnv[DEV_ENV_OVERRIDES_KEY];
  return overrides === undefined || overrides === '' ? {} : JSON.parse(overrides);
}

/**
 * Checkout `repo`'s environment, from its `.env` and this machine's
 * `stack.env`, with the values the dev runner's caller must win with over both.
 */
export function loadStackEnv(
  repo,
  processEnv = process.env,
  machineFile = stackEnvPath(processEnv),
) {
  return stackEnv(processEnv, readEnvFile(join(repo, '.env')), {
    instance: devEnvOverrides(processEnv),
    machinePassword: readMachinePassword(machineFile),
  });
}
