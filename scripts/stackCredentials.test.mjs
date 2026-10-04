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
  DEFAULT_COMPOSE_PROJECT,
  PGADMIN_CONTAINER,
  PGADMIN_LOGIN_EMAIL,
  PGADMIN_VOLUME,
  TOOLS_LOGIN_USER,
  composeEnv,
  composeProjectOf,
  credentialReadiness,
  envAdoptingMachinePassword,
  envRedisUrl,
  mcpTokenState,
} from './stackCredentials.mjs';
import {
  REDIS_URL_KEY,
  STACK_ENV_FILE,
  STACK_PASSWORD_KEY,
  generateRedisPassword,
} from './stackEnv.mjs';
import { ADOPT_PASSWORD_COMMAND } from './stackRedis.mjs';

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
    env: { PATH: `${scratch}:${process.env['PATH'] ?? ''}`, [STACK_PASSWORD_KEY]: password },
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
    expect(started.stderr).toContain(STACK_ENV_FILE);
    expect(started.stderr).toContain(ADOPT_PASSWORD_COMMAND);
  });

  it('is asked for health with the password', () => {
    expect(service('redis')).toContain(`REDISCLI_AUTH="$$${STACK_PASSWORD_KEY}"`);
  });

  it.each(['postgres', 'redis', 'redis-commander', 'pgadmin'])(
    '%s publishes on loopback only',
    (name) => {
      const published = [...service(name).matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);
      expect(published.length).toBeGreaterThan(0);
      for (const port of published) expect(port).toMatch(/^127\.0\.0\.1:/);
    },
  );
});

describe('the admin tools', () => {
  const password = `\${${STACK_PASSWORD_KEY}:-}`;

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

describe('a checkout adopting the machine’s password', () => {
  it('takes a password of its own out of REDIS_URL, keeping its host and every other line', () => {
    const env = `DATABASE_URL=postgres://x\n${REDIS_URL_KEY}=redis://:${PASSWORD}@localhost:6379\nPORT=3000\n`;
    expect(envAdoptingMachinePassword(env)).toBe(
      `DATABASE_URL=postgres://x\n${REDIS_URL_KEY}=redis://localhost:6379\nPORT=3000\n`,
    );
  });

  it('leaves a URL carrying none, or a file naming none, alone', () => {
    expect(envAdoptingMachinePassword(`${REDIS_URL_KEY}=redis://localhost:6379\n`)).toBeUndefined();
    expect(envAdoptingMachinePassword('PORT=3000\n')).toBeUndefined();
  });

  it('never rewrites a URL naming another host, whose password is that Redis’s own', () => {
    for (const url of [
      `rediss://default:${PASSWORD}@managed.example.com:6380`,
      `redis://:${PASSWORD}@10.0.0.5:6379/2`,
    ]) {
      expect(envAdoptingMachinePassword(`${REDIS_URL_KEY}='${url}'\n`)).toBeUndefined();
      expect(envRedisUrl(`${REDIS_URL_KEY}='${url}'\n`)).toBe(url);
    }
  });

  it('hands compose the machine’s password, and nothing when the machine has none', () => {
    expect(composeEnv({ PATH: '/bin' }, PASSWORD)).toEqual({
      PATH: '/bin',
      [STACK_PASSWORD_KEY]: PASSWORD,
    });
    expect(composeEnv({ [STACK_PASSWORD_KEY]: 'shell' }, undefined)[STACK_PASSWORD_KEY]).toBe('');
  });
});

describe('the boot readiness', () => {
  const MACHINE_FILE = `/home/dev/.aflow/${STACK_ENV_FILE}`;
  const ready = {
    checkoutRedisUrl: 'redis://localhost:6379',
    checkoutRedisSource: '.env',
    machinePassword: PASSWORD,
    machineFile: MACHINE_FILE,
    redisUrl: `redis://:${PASSWORD}@localhost:6379`,
    redis: { outcome: 'accepted' },
    mcpToken: 'present',
    mcpAuthFile: 'mcp.local.json',
    hostEnvPath: '/home/dev/.aflow/host.env',
    composeProject: DEFAULT_COMPOSE_PROJECT,
  };

  it('passes a Redis that accepts the machine’s password, naming where it lives', () => {
    const readiness = credentialReadiness(ready);
    expect(readiness.failure).toBeUndefined();
    expect(readiness.lines[0]).toBe(`Redis: accepts this machine's password (${MACHINE_FILE})`);
  });

  it('passes a Redis not yet running, which is started next with the machine’s password', () => {
    const readiness = credentialReadiness({
      ...ready,
      redis: { outcome: 'unreachable', reason: 'ECONNREFUSED' },
    });
    expect(readiness.failure).toBeUndefined();
    expect(readiness.lines[0]).toContain('not running yet');
  });

  it('fails a Redis that requires no password, never echoing the password', () => {
    const readiness = credentialReadiness({ ...ready, redis: { outcome: 'no-password-required' } });
    expect(readiness.lines[0]).toBe('Redis: requires no password');
    expect(readiness.failure?.message).toContain('redis://localhost:6379');
    expect(readiness.failure?.message).not.toContain(PASSWORD);
    expect(readiness.failure?.remedy).toContain(ADOPT_PASSWORD_COMMAND);
  });

  it('fails a Redis that refuses the machine’s password, with its reply', () => {
    const readiness = credentialReadiness({
      ...ready,
      redis: { outcome: 'refused', reason: 'WRONGPASS invalid username-password pair' },
    });
    expect(readiness.lines[0]).toContain('refuses this machine');
    expect(readiness.failure?.message).toContain('WRONGPASS');
    expect(readiness.failure?.message).toContain(MACHINE_FILE);
    expect(readiness.failure?.message).not.toContain(PASSWORD);
    expect(readiness.failure?.remedy).toContain(ADOPT_PASSWORD_COMMAND);
  });

  it('names a checkout whose .env carries another password, and the command that adopts the machine’s', () => {
    const other = generateRedisPassword();
    const readiness = credentialReadiness({
      ...ready,
      checkoutRedisUrl: `redis://:${other}@localhost:6379`,
    });
    expect(readiness.lines[1]).toContain('carries a password other than the machine');
    expect(readiness.failure?.message).toContain(`${REDIS_URL_KEY} in .env`);
    expect(readiness.failure?.message).toContain(MACHINE_FILE);
    expect(readiness.failure?.message).not.toContain(other);
    expect(readiness.failure?.remedy).toContain(ADOPT_PASSWORD_COMMAND);
  });

  it('names a REDIS_URL with its own password set in the shell, and how to clear it there', () => {
    const readiness = credentialReadiness({
      ...ready,
      checkoutRedisUrl: `redis://:${generateRedisPassword()}@localhost:6379`,
      checkoutRedisSource: 'the shell',
    });
    expect(readiness.failure?.message).toContain(`${REDIS_URL_KEY} in the shell`);
    expect(readiness.failure?.remedy).toContain(`Unset ${REDIS_URL_KEY} in the shell`);
  });

  describe('a REDIS_URL naming another host', () => {
    const own = generateRedisPassword();
    const remote = {
      ...ready,
      checkoutRedisUrl: `rediss://default:${own}@managed.example.com:6380`,
      redisUrl: `rediss://default:${own}@managed.example.com:6380`,
    };

    it('is the checkout’s own Redis, passing on the credential it carries', () => {
      const readiness = credentialReadiness(remote);
      expect(readiness.failure).toBeUndefined();
      expect(readiness.lines[0]).toBe(
        `Redis: this checkout's own, at managed.example.com:6380; accepts the credential ${REDIS_URL_KEY} carries`,
      );
      expect(readiness.lines[1]).toContain('names its own Redis, at managed.example.com:6380');
      expect(readiness.lines.join('\n')).not.toContain(own);
    });

    it('is never asked for the machine’s password, and one asking for none is not a failure', () => {
      const readiness = credentialReadiness({
        ...remote,
        redis: { outcome: 'no-password-required' },
      });
      expect(readiness.failure).toBeUndefined();
      expect(readiness.lines.join('\n')).not.toContain(MACHINE_FILE);
    });

    it('fails where it refuses its own credential, without offering the machine’s', () => {
      const readiness = credentialReadiness({
        ...remote,
        redis: { outcome: 'refused', reason: 'WRONGPASS invalid username-password pair' },
      });
      expect(readiness.failure?.message).toContain('rediss://managed.example.com:6380');
      expect(readiness.failure?.message).toContain('WRONGPASS');
      expect(readiness.failure?.message).not.toContain(own);
      expect(readiness.failure?.remedy).toContain('leaves a URL naming another host as it is');
    });
  });

  it('passes a checkout whose .env carries the machine’s own password', () => {
    expect(
      credentialReadiness({ ...ready, checkoutRedisUrl: `redis://:${PASSWORD}@localhost:6379` })
        .failure,
    ).toBeUndefined();
  });

  it('names every service’s credential', () => {
    expect(credentialReadiness(ready).lines.map((line) => line.split(':')[0])).toEqual([
      'Redis',
      'This checkout',
      'MCP server',
      'Redis Commander',
      'pgAdmin',
      'Host lane',
    ]);
  });

  it('says when the MCP server has no token to check sessions against', () => {
    const lines = (mcpToken) => credentialReadiness({ ...ready, mcpToken }).lines[2];
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
    expect(credentialReadiness(ready).lines[5]).toContain('/home/dev/.aflow/host.env');
    expect(credentialReadiness({ ...ready, hostEnvPath: null }).lines[5]).toBe(
      'Host lane: not paired',
    );
  });

  it('says pgAdmin holds the password it was created with, and how a changed one reaches it', () => {
    const line = credentialReadiness({ ...ready, composeProject: 'kept-data' }).lines[4];
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
