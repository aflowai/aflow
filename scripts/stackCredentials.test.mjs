/**
 * Every service of the development stack requires a credential (Plan 315 D20).
 *
 * The compose file is read as text and the Redis service's own start script is
 * run, under a stand-in for the image's entrypoint, with and without the
 * password — so what is held is the configuration the stack starts from, not a
 * restatement of it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ADD_PASSWORD_COMMAND,
  COMPOSE_PASSWORD_KEY,
  DEFAULT_COMPOSE_PROJECT,
  PGADMIN_CONTAINER,
  PGADMIN_LOGIN_EMAIL,
  PGADMIN_VOLUME,
  REDIS_URL_KEY,
  TOOLS_LOGIN_USER,
  composeEnv,
  composeProjectOf,
  credentialReadiness,
  envWithRedisPassword,
  generateRedisPassword,
  mcpTokenState,
  redisPasswordOf,
} from './stackCredentials.mjs';

const COMPOSE = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const PASSWORD = generateRedisPassword();
const SERVICE_INDENT = '  ';
const BLOCK_INDENT = '        ';

/** One service's block of the compose file, up to the next service or section. */
function service(name) {
  const lines = COMPOSE.split('\n');
  const start = lines.indexOf(`${SERVICE_INDENT}${name}:`);
  if (start < 0) throw new Error(`docker-compose.yml has no service ${name}`);
  const end = lines.findIndex((line, i) => i > start && /^ {0,2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The redis service's `sh -c` script, as compose hands it to the container. */
function redisStartScript() {
  const block = service('redis').split('\n');
  const from = block.findIndex((line) => line.trim() === '- |') + 1;
  const script = [];
  for (const line of block.slice(from)) {
    if (!line.startsWith(BLOCK_INDENT)) break;
    script.push(line.slice(BLOCK_INDENT.length));
  }
  return script.join('\n').replaceAll('$$', '$');
}

let scratch;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** Runs the start script with the image's entrypoint replaced by one that records its arguments. */
function startRedis(password) {
  scratch = mkdtempSync(join(tmpdir(), 'dev-redis-'));
  const entrypoint = join(scratch, 'docker-entrypoint.sh');
  writeFileSync(entrypoint, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(entrypoint, 0o755);
  return spawnSync('sh', ['-c', redisStartScript()], {
    encoding: 'utf8',
    env: { PATH: `${scratch}:${process.env['PATH'] ?? ''}`, [COMPOSE_PASSWORD_KEY]: password },
  });
}

describe("the stack's Redis, as compose starts it", () => {
  it('requires the password, so a client that sends none is refused', () => {
    const started = startRedis(PASSWORD);
    expect(started.status).toBe(0);
    const args = started.stdout.trim().split('\n');
    expect(args[0]).toBe('redis-server');
    expect(args[args.indexOf('--requirepass') + 1]).toBe(PASSWORD);
  });

  it('does not start without one, and says which setting and which command', () => {
    const started = startRedis('');
    expect(started.status).not.toBe(0);
    expect(started.stdout).toBe('');
    expect(started.stderr).toContain(REDIS_URL_KEY);
    expect(started.stderr).toContain(ADD_PASSWORD_COMMAND);
  });

  it('is asked for health with the password', () => {
    expect(service('redis')).toContain(`REDISCLI_AUTH="$$${COMPOSE_PASSWORD_KEY}"`);
  });

  it.each(['redis', 'redis-commander', 'pgadmin'])('%s publishes on loopback only', (name) => {
    const published = [...service(name).matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);
    expect(published.length).toBeGreaterThan(0);
    for (const port of published) expect(port).toMatch(/^127\.0\.0\.1:/);
  });
});

describe('the admin tools', () => {
  const password = `\${${COMPOSE_PASSWORD_KEY}:-}`;

  it('put Redis Commander behind the Redis password, and give it that password for Redis', () => {
    const block = service('redis-commander');
    expect(block).toContain(`HTTP_USER: ${TOOLS_LOGIN_USER}`);
    expect(block).toContain(`HTTP_PASSWORD: ${password}`);
    expect(block).toContain(`REDIS_HOSTS: local:redis:6379:0:${password}`);
  });

  it('run pgAdmin in server mode, behind a login with the same password', () => {
    const block = service('pgadmin');
    expect(block).not.toContain('PGADMIN_CONFIG_SERVER_MODE');
    expect(block).toContain(`PGADMIN_DEFAULT_EMAIL: ${PGADMIN_LOGIN_EMAIL}`);
    expect(block).toContain(`PGADMIN_DEFAULT_PASSWORD: ${password}`);
  });

  it('keep pgAdmin’s login in the volume the readiness names, in the container it names', () => {
    const block = service('pgadmin');
    expect(block).toContain(`container_name: ${PGADMIN_CONTAINER}`);
    expect(block).toContain(`- ${PGADMIN_VOLUME}:/var/lib/pgadmin`);
    expect(COMPOSE).toMatch(new RegExp(`^name: ${DEFAULT_COMPOSE_PROJECT}$`, 'm'));
  });

  it('stay off unless asked for', () => {
    for (const name of ['redis-commander', 'pgadmin']) {
      expect(service(name)).toMatch(/profiles:\n\s+- tools/);
    }
  });
});

describe('the password in REDIS_URL', () => {
  it('is read back as written', () => {
    expect(redisPasswordOf(`redis://:${PASSWORD}@localhost:6379`)).toBe(PASSWORD);
    expect(redisPasswordOf('redis://localhost:6379')).toBeUndefined();
    expect(redisPasswordOf(undefined)).toBeUndefined();
  });

  it('is written into a URL that has none, keeping its host and every other line', () => {
    const env = `DATABASE_URL=postgres://x\n${REDIS_URL_KEY}=redis://localhost:6379\nPORT=3000\n`;
    expect(envWithRedisPassword(env, PASSWORD)).toBe(
      `DATABASE_URL=postgres://x\n${REDIS_URL_KEY}=redis://:${PASSWORD}@localhost:6379\nPORT=3000\n`,
    );
  });

  it('is added with the local URL to a file that names none', () => {
    expect(envWithRedisPassword('PORT=3000', PASSWORD)).toBe(
      `PORT=3000\n${REDIS_URL_KEY}=redis://:${PASSWORD}@localhost:6379\n`,
    );
  });

  it('is left alone where the URL already carries one', () => {
    expect(
      envWithRedisPassword(`${REDIS_URL_KEY}=redis://:kept@localhost:6379\n`, PASSWORD),
    ).toBeUndefined();
  });

  it('is what compose is handed, and nothing when the URL carries none', () => {
    const url = `redis://:${PASSWORD}@localhost:6379`;
    expect(composeEnv({}, { [REDIS_URL_KEY]: url })[COMPOSE_PASSWORD_KEY]).toBe(PASSWORD);
    expect(composeEnv({ [REDIS_URL_KEY]: url }, {})[COMPOSE_PASSWORD_KEY]).toBe(PASSWORD);
    expect(
      composeEnv({}, { [REDIS_URL_KEY]: 'redis://localhost:6379' })[COMPOSE_PASSWORD_KEY],
    ).toBe('');
  });
});

describe('the boot readiness', () => {
  const ready = {
    redisUrl: `redis://:${PASSWORD}@localhost:6379`,
    redisAnswers: 'closed',
    mcpToken: 'present',
    mcpAuthFile: 'mcp.local.json',
    hostEnvPath: '/home/dev/.aflow/host.env',
    composeProject: DEFAULT_COMPOSE_PROJECT,
  };

  it('fails a Redis URL without a password, naming it and the command that adds one', () => {
    const readiness = credentialReadiness({ ...ready, redisUrl: 'redis://localhost:6379' });
    expect(readiness.failure?.message).toContain(REDIS_URL_KEY);
    expect(readiness.failure?.remedy).toContain(ADD_PASSWORD_COMMAND);
    expect(readiness.lines[0]).toBe(`Redis: ${REDIS_URL_KEY} carries no password`);
  });

  it('fails when there is no Redis URL at all', () => {
    expect(credentialReadiness({ ...ready, redisUrl: undefined }).failure).toBeDefined();
  });

  it('fails a Redis that answers without the password the URL carries', () => {
    const readiness = credentialReadiness({ ...ready, redisAnswers: 'open' });
    expect(readiness.failure?.message).toContain('redis://localhost:6379');
    expect(readiness.failure?.message).not.toContain(PASSWORD);
    expect(readiness.failure?.remedy).toContain(ADD_PASSWORD_COMMAND);
  });

  it('names every service’s credential, and passes when each has one', () => {
    for (const redisAnswers of ['closed', 'unreachable']) {
      const readiness = credentialReadiness({ ...ready, redisAnswers });
      expect(readiness.failure).toBeUndefined();
      expect(readiness.lines.map((line) => line.split(':')[0])).toEqual([
        'Redis',
        'MCP server',
        'Redis Commander',
        'pgAdmin',
        'Host lane',
      ]);
    }
  });

  it('says when the MCP server has no token to check sessions against', () => {
    const lines = (mcpToken) => credentialReadiness({ ...ready, mcpToken }).lines[1];
    expect(lines('absent')).toContain('refuses every session');
    expect(lines('no-file')).toContain('refuses every session');
    expect(lines('present')).toContain('AFLOW_MCP_LOCAL_TOKEN');
  });

  it('reads the token state from the file', () => {
    expect(mcpTokenState(undefined)).toBe('no-file');
    expect(mcpTokenState('{"apiKey":"phx_x"}')).toBe('absent');
    expect(mcpTokenState('{"apiKey":"phx_x","sessionToken":""}')).toBe('absent');
    expect(mcpTokenState('{"apiKey":"phx_x","sessionToken":"t"}')).toBe('present');
  });

  it('names a paired machine’s own credential, and an unpaired one', () => {
    expect(credentialReadiness(ready).lines[4]).toContain('/home/dev/.aflow/host.env');
    expect(credentialReadiness({ ...ready, hostEnvPath: null }).lines[4]).toBe(
      'Host lane: not paired',
    );
  });
});

describe('pgAdmin’s login in the readiness', () => {
  it('says it is the password pgAdmin was created with, and how a changed one reaches it', () => {
    const line = credentialReadiness({
      redisUrl: `redis://:${PASSWORD}@localhost:6379`,
      redisAnswers: 'closed',
      mcpToken: 'present',
      mcpAuthFile: 'mcp.local.json',
      hostEnvPath: null,
      composeProject: 'kept-data',
    }).lines[3];
    expect(line).toContain(PGADMIN_LOGIN_EMAIL);
    expect(line).toContain('first created');
    expect(line).toContain(
      `docker rm -f ${PGADMIN_CONTAINER} && docker volume rm kept-data_${PGADMIN_VOLUME}`,
    );
    expect(line).not.toContain('infra:reset');
  });

  it('names the volume under the project compose uses: the shell, then .env, then the file', () => {
    const named = { COMPOSE_PROJECT_NAME: 'from-file' };
    expect(composeProjectOf({ COMPOSE_PROJECT_NAME: 'from-shell' }, named)).toBe('from-shell');
    expect(composeProjectOf({}, named)).toBe('from-file');
    expect(composeProjectOf({}, {})).toBe(DEFAULT_COMPOSE_PROJECT);
  });
});
