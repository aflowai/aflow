/**
 * What each service of the development stack authenticates with, and whether
 * it does — the readiness `yarn start` prints before anything starts.
 *
 * The stack's Redis password lives in one place, the `REDIS_URL` in `.env`,
 * so every reader of that URL authenticates without knowing a password exists.
 * Compose cannot take part of a variable, so `scripts/infra.mjs` hands it the
 * password as `AFLOW_DEV_REDIS_PASSWORD`; Redis, Redis Commander and pgAdmin
 * all start from that one value.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MCP_TOKEN_ENV, sessionTokenIn } from './mcp-local-setup.mjs';

export const REDIS_URL_KEY = 'REDIS_URL';
export const COMPOSE_PASSWORD_KEY = 'AFLOW_DEV_REDIS_PASSWORD';
export const ADD_PASSWORD_COMMAND = 'yarn redis:password';
export const TOOLS_LOGIN_USER = 'aflow';
export const PGADMIN_LOGIN_EMAIL = 'admin@phoenix.dev';
export const PGADMIN_CONTAINER = 'aflow-pgadmin';
export const PGADMIN_VOLUME = 'pgadmin_login';
export const DEFAULT_COMPOSE_PROJECT = 'aflow-dev';
const COMPOSE_PROJECT_KEY = 'COMPOSE_PROJECT_NAME';
const REDIS_PASSWORD_BYTES = 32;
const DEFAULT_REDIS_PORT = 6379;
const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_REDIS_URL = `redis://localhost:${String(DEFAULT_REDIS_PORT)}`;

/** Hex, so it needs no percent-encoding in the URL and no quoting in compose. */
export function generateRedisPassword() {
  return randomBytes(REDIS_PASSWORD_BYTES).toString('hex');
}

/** The password a Redis URL carries, or undefined when it carries none. */
export function redisPasswordOf(url) {
  const parsed = url === undefined ? null : URL.parse(url);
  if (parsed === null || parsed.password === '') return undefined;
  return decodeURIComponent(parsed.password);
}

export function redisUrlWithoutCredentials(url) {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

const REDIS_URL_LINE = new RegExp(`^(\\s*(?:export\\s+)?${REDIS_URL_KEY}=)(.*)$`, 'm');

/**
 * `.env` with a password written into its `REDIS_URL`, or undefined when that
 * URL already carries one. A file with no `REDIS_URL` gains the local one.
 */
export function envWithRedisPassword(envText, password) {
  const match = REDIS_URL_LINE.exec(envText);
  const current = match?.[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  const named = current !== undefined && current !== '';
  if (named && redisPasswordOf(current) !== undefined) return undefined;
  const url = new URL(named ? current : DEFAULT_REDIS_URL);
  url.password = password;
  if (match === null) {
    const separator = envText === '' || envText.endsWith('\n') ? '' : '\n';
    return `${envText}${separator}${REDIS_URL_KEY}=${url.toString()}\n`;
  }
  return envText.replace(REDIS_URL_LINE, `$1${url.toString()}`);
}

/**
 * The environment `docker compose` runs with: the password from the URL, or an
 * empty one when the URL has none, which the Redis service refuses to start on.
 */
export function composeEnv(processEnv, dotenv) {
  const redisUrl = dotenv[REDIS_URL_KEY] ?? processEnv[REDIS_URL_KEY];
  return { ...processEnv, [COMPOSE_PASSWORD_KEY]: redisPasswordOf(redisUrl) ?? '' };
}

/**
 * Where `pair` wrote this machine's host env, or null when it never ran. The
 * host executor resolves the same directory (`PHOENIX_HOST_POLICY_PATH`, then
 * `PHOENIX_HOST_DIR`, then `~/.aflow`).
 */
export function pairedHostEnvPath(env = process.env) {
  const policyPath = env['PHOENIX_HOST_POLICY_PATH']?.trim();
  const dir =
    policyPath !== undefined && policyPath !== ''
      ? join(policyPath, '..')
      : env['PHOENIX_HOST_DIR']?.trim() || join(homedir(), '.aflow');
  const envPath = join(dir, 'host.env');
  return existsSync(envPath) ? envPath : null;
}

/** The compose project as compose resolves it: the shell, then `.env`, then the file's `name:`. */
export function composeProjectOf(processEnv, dotenv) {
  return processEnv[COMPOSE_PROJECT_KEY] || dotenv[COMPOSE_PROJECT_KEY] || DEFAULT_COMPOSE_PROJECT;
}

/**
 * pgAdmin reads its login only when it initialises an empty volume, so the one
 * it holds is the password as it was then. Writing it at every start would mean
 * discarding pgAdmin's state at every start or reaching into the image's own
 * setup script; removing this volume is what gives it the current password.
 */
export function pgAdminVolume(composeProject) {
  return `${composeProject}_${PGADMIN_VOLUME}`;
}

/** Whether the MCP server's auth file holds a session token: `present`, `absent`, or `no-file`. */
export function mcpTokenState(authFileText) {
  if (authFileText === undefined) return 'no-file';
  return sessionTokenIn(authFileText) === undefined ? 'absent' : 'present';
}

/**
 * How the Redis at `url` answers a PING sent with no password: `open` when it
 * answers, `closed` when it asks for one, `unreachable` when nothing answers.
 */
export function probeRedisWithoutPassword(url) {
  const parsed = url === undefined ? null : URL.parse(url);
  const host = parsed?.hostname || '127.0.0.1';
  const port = Number(parsed?.port || DEFAULT_REDIS_PORT);
  return new Promise((resolve) => {
    let reply = '';
    const socket = connect({ host, port }, () => socket.write('PING\r\n'))
      .on('data', (chunk) => {
        reply += chunk.toString();
        if (!reply.includes('\r\n')) return;
        socket.destroy();
        resolve(reply.startsWith('+PONG') ? 'open' : 'closed');
      })
      .on('error', () => {
        resolve('unreachable');
      })
      // A peer that closes without replying settles nothing else.
      .on('close', () => {
        resolve('unreachable');
      });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      resolve('unreachable');
    });
  });
}

/**
 * Each service's credential state, one line each, and the failure that stops
 * the start when Redis would run, or is running, without its password.
 *
 * @param {{
 *   redisUrl: string | undefined,
 *   redisAnswers: 'open' | 'closed' | 'unreachable',
 *   mcpToken: 'present' | 'absent' | 'no-file',
 *   mcpAuthFile: string,
 *   hostEnvPath: string | null,
 *   composeProject: string,
 * }} input
 */
export function credentialReadiness({
  redisUrl,
  redisAnswers,
  mcpToken,
  mcpAuthFile,
  hostEnvPath,
  composeProject,
}) {
  const lines = [];
  let failure;

  if (redisUrl === undefined || redisPasswordOf(redisUrl) === undefined) {
    lines.push(`Redis: ${REDIS_URL_KEY} carries no password`);
    failure = {
      message: `${REDIS_URL_KEY} in .env carries no password, and the stack's Redis requires one.`,
      remedy:
        `Run \`${ADD_PASSWORD_COMMAND}\` once: it writes a generated password into ` +
        `${REDIS_URL_KEY} and restarts Redis with it. The data stays.`,
    };
  } else if (redisAnswers === 'open') {
    lines.push('Redis: answers without a password');
    failure = {
      message:
        `The Redis at ${redisUrlWithoutCredentials(redisUrl)} answers without a password, ` +
        `although ${REDIS_URL_KEY} carries one: it was started before the password was.`,
      remedy: `Run \`${ADD_PASSWORD_COMMAND}\` to restart it with the password. The data stays.`,
    };
  } else {
    lines.push(`Redis: requires the password ${REDIS_URL_KEY} carries`);
  }

  lines.push(
    mcpToken === 'present'
      ? `MCP server: gives the owner's key only to a session presenting the token in ${mcpAuthFile} (${MCP_TOKEN_ENV})`
      : mcpToken === 'absent'
        ? `MCP server: ${mcpAuthFile} holds no session token, so it refuses every session; yarn mcp:setup adds one`
        : `MCP server: no ${mcpAuthFile} yet, so it refuses every session; yarn mcp:setup writes it once the stack is healthy`,
  );
  lines.push(
    'Redis Commander: off unless `yarn infra:tools`; on 127.0.0.1, ' +
      `logging in as ${TOOLS_LOGIN_USER} with the Redis password`,
  );
  lines.push(
    'pgAdmin: off unless `yarn infra:tools`; on 127.0.0.1, ' +
      `logging in as ${PGADMIN_LOGIN_EMAIL} with the Redis password as it was when pgAdmin ` +
      'was first created; a changed REDIS_URL reaches it only once its volume is removed ' +
      `(\`docker rm -f ${PGADMIN_CONTAINER} && docker volume rm ${pgAdminVolume(composeProject)}\`)`,
  );
  lines.push(
    hostEnvPath === null
      ? 'Host lane: not paired'
      : `Host lane: its own Redis identity, read-only on write approvals, in ${hostEnvPath}`,
  );

  return { lines, ...(failure === undefined ? {} : { failure }) };
}
