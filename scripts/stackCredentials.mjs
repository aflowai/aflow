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
import { REDIS_URL_KEY, STACK_PASSWORD_KEY, hostDirOf, redisPasswordOf } from './stackEnv.mjs';
import { ADOPT_PASSWORD_COMMAND, redisUrlWithoutCredentials } from './stackRedis.mjs';

export const TOOLS_LOGIN_USER = 'aflow';
export const PGADMIN_LOGIN_EMAIL = 'admin@phoenix.dev';
export const PGADMIN_CONTAINER = 'aflow-pgadmin';
export const PGADMIN_VOLUME = 'pgadmin_login';
export const DEFAULT_COMPOSE_PROJECT = 'aflow-dev';
const COMPOSE_PROJECT_KEY = 'COMPOSE_PROJECT_NAME';

const REDIS_URL_LINE = new RegExp(`^(\\s*(?:export\\s+)?${REDIS_URL_KEY}=)(.*)$`, 'm');

/**
 * `.env` with the password taken out of its `REDIS_URL`, so the checkout uses
 * the machine's; undefined when that URL carries none.
 */
export function envAdoptingMachinePassword(envText) {
  const match = REDIS_URL_LINE.exec(envText);
  const current = match?.[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  if (current === undefined || redisPasswordOf(current) === undefined) return undefined;
  const url = new URL(current);
  url.password = '';
  return envText.replace(REDIS_URL_LINE, `$1${url.toString()}`);
}

/**
 * The environment `docker compose` runs with: the machine's password, or an
 * empty one when there is none, which the Redis service refuses to start on.
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
 * Each service's credential state, one line each, and the failure that stops
 * the start when Redis would run without the machine's password, or this
 * checkout would connect with a password of its own.
 *
 * @param {{
 *   checkoutRedisUrl: string | undefined,
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
  const redisState = redisReadiness({ redisUrl, redis, machineFile });
  lines.push(redisState.line);
  let failure = redisState.failure;

  const checkoutPassword = redisPasswordOf(checkoutRedisUrl);
  if (checkoutPassword !== undefined && checkoutPassword !== machinePassword) {
    lines.push(
      `This checkout: ${REDIS_URL_KEY} in .env carries a password other than the machine's`,
    );
    failure = {
      message:
        `${REDIS_URL_KEY} in .env carries a Redis password of its own, and the Redis every ` +
        `checkout on this machine shares requires the one in ${machineFile}.`,
      remedy:
        `Run \`${ADOPT_PASSWORD_COMMAND}\` once: it takes the password out of ${REDIS_URL_KEY}, ` +
        "so this checkout uses the machine's, and starts Redis with it if it is not already.",
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
