/**
 * What each service of the development stack authenticates with, and whether
 * it does — the readiness `yarn start` prints before anything starts.
 *
 * The stack's Redis password is the machine's, in `stack.env`
 * (`scripts/stackEnv.mjs`), because every checkout shares one Redis container.
 * Compose is handed it as `AFLOW_DEV_REDIS_PASSWORD` by `scripts/infra.mjs`;
 * Redis, Redis Commander and pgAdmin all start from that one value, and every
 * checkout's `REDIS_URL` is given it by the loader.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { MCP_TOKEN_ENV, sessionTokenIn } from './mcp-local-setup.mjs';
import {
  REDIS_URL_KEY,
  STACK_PASSWORD_KEY,
  hostDirOf,
  isMachineRedisUrl,
  redisPasswordOf,
} from './stackEnv.mjs';
import { ADOPT_PASSWORD_COMMAND, redisUrlWithoutCredentials } from './stackRedis.mjs';

export const TOOLS_LOGIN_USER = 'aflow';
export const PGADMIN_LOGIN_EMAIL = 'admin@phoenix.dev';
export const PGADMIN_CONTAINER = 'aflow-pgadmin';
export const PGADMIN_VOLUME = 'pgadmin_login';
export const DEFAULT_COMPOSE_PROJECT = 'aflow-dev';
const COMPOSE_PROJECT_KEY = 'COMPOSE_PROJECT_NAME';

const REDIS_URL_LINE = new RegExp(`^(\\s*(?:export\\s+)?${REDIS_URL_KEY}=)(.*)$`, 'm');

/** The `REDIS_URL` `.env` sets, unquoted, or undefined when it sets none. */
export function envRedisUrl(envText) {
  return REDIS_URL_LINE.exec(envText)?.[2]
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * `.env` with the password taken out of its `REDIS_URL`, so the checkout uses
 * the machine's; undefined when that URL carries none, or names a Redis on
 * another host, whose password is that Redis's own.
 */
export function envAdoptingMachinePassword(envText) {
  const current = envRedisUrl(envText);
  if (
    current === undefined ||
    redisPasswordOf(current) === undefined ||
    !isMachineRedisUrl(current)
  ) {
    return undefined;
  }
  const url = new URL(current);
  url.password = '';
  return envText.replace(REDIS_URL_LINE, `$1${url.toString()}`);
}

/**
 * The environment `docker compose` runs with: the machine's password, or an
 * empty one when there is none, which the Redis service refuses to start on.
 *
 * The one merge where the caller does not win: every checkout's compose drives
 * the same Redis container, so a password exported in one shell would recreate
 * it under every other checkout's services.
 */
export function composeEnv(processEnv, machinePassword) {
  return { ...processEnv, [STACK_PASSWORD_KEY]: machinePassword ?? '' };
}

/** Where `pair` wrote this machine's host env, or null when it never ran. */
export function pairedHostEnvPath(env = process.env) {
  const envPath = join(hostDirOf(env), 'host.env');
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

/** The Redis line, and the failure when the Redis does not hold the machine's password. */
function redisReadiness({ redisUrl, redis, machineFile }) {
  const at = redisUrlWithoutCredentials(redisUrl);
  const restart =
    `Run \`${ADOPT_PASSWORD_COMMAND}\` to restart it with this machine's password, which every ` +
    "checkout's services use. The data stays.";
  switch (redis.outcome) {
    case 'accepted':
      return { line: `Redis: accepts this machine's password (${machineFile})` };
    case 'no-password-required':
      return {
        line: 'Redis: requires no password',
        failure: {
          message: `The Redis at ${at} requires no password: it was started before ${machineFile} was written.`,
          remedy: restart,
        },
      };
    case 'refused':
      return {
        line: `Redis: refuses this machine's password (${redis.reason})`,
        failure: {
          message:
            `The Redis at ${at} refuses this machine's password in ${machineFile} ` +
            `(${redis.reason}): it was started with another one.`,
          remedy: restart,
        },
      };
    case 'unreachable':
      return {
        line: `Redis: not running yet; started next with this machine's password (${machineFile})`,
      };
  }
}

/**
 * A Redis on another host, which the checkout's `REDIS_URL` names: its own,
 * checked with the credential that URL carries, and failed only where it
 * refuses it. The machine's password and `yarn redis:password` are for this
 * machine's Redis alone.
 */
function ownRedisReadiness({ redisUrl, redis, source }) {
  const at = redisUrlWithoutCredentials(redisUrl);
  const own = `Redis: this checkout's own, at ${new URL(redisUrl).host}`;
  switch (redis.outcome) {
    case 'accepted':
      return { line: `${own}; accepts the credential ${REDIS_URL_KEY} carries` };
    case 'no-password-required':
      return { line: `${own}; requires no password` };
    case 'refused':
      return {
        line: `${own}; refuses the credential ${REDIS_URL_KEY} carries (${redis.reason})`,
        failure: {
          message:
            `The Redis at ${at}, which ${REDIS_URL_KEY} in ${source} names, refuses the ` +
            `credential it carries (${redis.reason}).`,
          remedy:
            `Put the password that Redis requires in ${REDIS_URL_KEY}. This machine's password ` +
            `is for its own Redis alone, and \`${ADOPT_PASSWORD_COMMAND}\` leaves a URL naming ` +
            'another host as it is.',
        },
      };
    case 'unreachable':
      return { line: `${own}; not answering (${redis.reason})` };
  }
}

/**
 * Each service's credential state, one line each, and the failure that stops
 * the start when this machine's Redis would run without the machine's
 * password, this checkout would connect to it with a password of its own, or
 * a Redis of the checkout's own on another host refuses its credential.
 *
 * @param {{
 *   checkoutRedisUrl: string | undefined,
 *   checkoutRedisSource: '.env' | 'the shell',
 *   machinePassword: string,
 *   machineFile: string,
 *   redisUrl: string,
 *   redis: { outcome: 'accepted' | 'no-password-required' | 'refused' | 'unreachable', reason?: string },
 *   mcpToken: 'present' | 'absent' | 'no-file',
 *   mcpAuthFile: string,
 *   hostEnvPath: string | null,
 *   composeProject: string,
 * }} input
 */
export function credentialReadiness({
  checkoutRedisUrl,
  checkoutRedisSource,
  machinePassword,
  machineFile,
  redisUrl,
  redis,
  mcpToken,
  mcpAuthFile,
  hostEnvPath,
  composeProject,
}) {
  const lines = [];
  const redisState = isMachineRedisUrl(redisUrl)
    ? redisReadiness({ redisUrl, redis, machineFile })
    : ownRedisReadiness({ redisUrl, redis, source: checkoutRedisSource });
  lines.push(redisState.line);
  let failure = redisState.failure;

  const checkoutPassword = redisPasswordOf(checkoutRedisUrl);
  if (!isMachineRedisUrl(redisUrl)) {
    lines.push(
      `This checkout: ${REDIS_URL_KEY} in ${checkoutRedisSource} names its own Redis, at ` +
        `${new URL(redisUrl).host}, with the credential it carries`,
    );
  } else if (checkoutPassword !== undefined && checkoutPassword !== machinePassword) {
    lines.push(
      `This checkout: ${REDIS_URL_KEY} in ${checkoutRedisSource} carries a password other than the machine's`,
    );
    failure = {
      message:
        `${REDIS_URL_KEY} in ${checkoutRedisSource} carries a Redis password of its own, and the ` +
        `Redis every checkout on this machine shares requires the one in ${machineFile}.`,
      remedy:
        checkoutRedisSource === '.env'
          ? `Run \`${ADOPT_PASSWORD_COMMAND}\` once: it takes the password out of ${REDIS_URL_KEY}, ` +
            "so this checkout uses the machine's, and starts Redis with it if it is not already."
          : `Unset ${REDIS_URL_KEY} in the shell, or take the password out of it, so the ` +
            "machine's is laid in.",
    };
  } else {
    lines.push(`This checkout: ${REDIS_URL_KEY} uses the machine's password`);
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
      `logging in as ${TOOLS_LOGIN_USER} with this machine's Redis password`,
  );
  lines.push(
    'pgAdmin: off unless `yarn infra:tools`; on 127.0.0.1, ' +
      `logging in as ${PGADMIN_LOGIN_EMAIL} with the Redis password as it was when pgAdmin ` +
      'was first created; a changed one reaches it only once its volume is removed ' +
      `(\`docker rm -f ${PGADMIN_CONTAINER} && docker volume rm ${pgAdminVolume(composeProject)}\`)`,
  );
  lines.push(
    hostEnvPath === null
      ? 'Host lane: not paired'
      : `Host lane: its own Redis identity, read-only on write approvals, in ${hostEnvPath}`,
  );

  return { lines, ...(failure === undefined ? {} : { failure }) };
}
