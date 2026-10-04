/**
 * The stack's environment, and the Redis password in it that belongs to the
 * machine rather than to any one checkout (Plan 315 D20).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEV_ENV_OVERRIDES_KEY,
  STACK_ENV_FILE,
  STACK_PASSWORD_KEY,
  ensureMachinePassword,
  generateRedisPassword,
  hostDirOf,
  loadStackEnv,
  parseEnvFile,
  readMachinePassword,
  redisPasswordOf,
  stackEnv,
  stackEnvPath,
} from './stackEnv.mjs';

const MACHINE = generateRedisPassword();
const OWN = generateRedisPassword();

let scratch;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function dir() {
  scratch = mkdtempSync(join(tmpdir(), 'stack-env-'));
  return scratch;
}

describe('the environment a stack process sees', () => {
  it('parses .env and the shell-quoted instance file alike', () => {
    expect(
      parseEnvFile(
        [
          '# a comment',
          "QUOTED='it'\\''s'",
          'DOUBLE="two words"',
          'BARE=value # trailing',
          'export EXPORTED=yes',
        ].join('\n'),
      ),
    ).toEqual({ QUOTED: "it's", DOUBLE: 'two words', BARE: 'value', EXPORTED: 'yes' });
  });

  it('merges as the dev runner does: .env over the shell, the instance file over both', () => {
    const merged = stackEnv(
      { A: 'shell', B: 'shell' },
      { A: 'dotenv', C: 'dotenv' },
      { instance: { C: 'instance' } },
    );
    expect(merged).toEqual({ A: 'dotenv', B: 'shell', C: 'instance' });
  });

  it('gives every checkout’s REDIS_URL the machine’s password, keeping where it points', () => {
    const env = stackEnv(
      { REDIS_URL: 'redis://127.0.0.1:6380' },
      { REDIS_URL: 'redis://localhost:6379/2' },
      { machinePassword: MACHINE },
    );
    expect(env['REDIS_URL']).toBe(`redis://:${MACHINE}@localhost:6379/2`);
    expect(stackEnv({}, {}, { machinePassword: MACHINE })['REDIS_URL']).toBe(
      `redis://:${MACHINE}@localhost:6379`,
    );
  });

  it('gives the machine’s password to the machine’s own Redis on every loopback name', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(
        stackEnv({}, { REDIS_URL: `redis://${host}:6379` }, { machinePassword: MACHINE })[
          'REDIS_URL'
        ],
      ).toBe(`redis://:${MACHINE}@${host}:6379`);
    }
  });

  it('never sends the machine’s password to a Redis on another host', () => {
    for (const url of [
      'redis://redis.internal.example:6379',
      'rediss://managed.example.com:6380/0',
      'redis://10.0.0.5:6379',
    ]) {
      expect(stackEnv({}, { REDIS_URL: url }, { machinePassword: MACHINE })['REDIS_URL']).toBe(url);
    }
  });

  it('leaves a URL carrying a password of its own as it is, for the readiness to name', () => {
    const own = `redis://:${OWN}@localhost:6379`;
    expect(stackEnv({}, { REDIS_URL: own }, { machinePassword: MACHINE })['REDIS_URL']).toBe(own);
  });

  it('changes nothing where the machine has no password, as in CI', () => {
    expect(stackEnv({ REDIS_URL: 'redis://localhost:6379' }, {})).toEqual({
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(stackEnv({}, {})).toEqual({});
  });

  it('is read from a checkout’s .env and the machine file', () => {
    const repo = dir();
    writeFileSync(join(repo, '.env'), 'REDIS_URL=redis://localhost:6379\n');
    const machineFile = join(repo, STACK_ENV_FILE);
    writeFileSync(machineFile, `${STACK_PASSWORD_KEY}=${MACHINE}\n`);
    expect(loadStackEnv(repo, {}, machineFile)['REDIS_URL']).toBe(
      `redis://:${MACHINE}@localhost:6379`,
    );
    expect(redisPasswordOf(loadStackEnv(repo, {}, machineFile)['REDIS_URL'])).toBe(MACHINE);
  });

  it('lays the values the dev runner’s caller must win with over the checkout’s .env', () => {
    const repo = dir();
    writeFileSync(join(repo, '.env'), 'PHOENIX_EDITION=enterprise\nKEPT=dotenv\n');
    const overrides = { [DEV_ENV_OVERRIDES_KEY]: '{"PHOENIX_EDITION":"community-local"}' };
    const env = loadStackEnv(repo, overrides, join(repo, STACK_ENV_FILE));
    expect(env['PHOENIX_EDITION']).toBe('community-local');
    expect(env['KEPT']).toBe('dotenv');
  });
});

describe('the machine’s password', () => {
  it('lives in the host directory the sandbox withholds, resolved as the host executor does', () => {
    expect(hostDirOf({ PHOENIX_HOST_POLICY_PATH: '/srv/host/host-policy.json' })).toBe('/srv/host');
    expect(hostDirOf({ PHOENIX_HOST_DIR: '/srv/other' })).toBe('/srv/other');
    expect(stackEnvPath({})).toMatch(/\.aflow\/stack\.env$/);
  });

  it('is written once, readable by its owner alone, and the same on every later read', () => {
    const machineFile = join(dir(), 'host', STACK_ENV_FILE);
    const first = ensureMachinePassword(machineFile);
    expect(first.created).toBe(true);
    expect(first.password).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(machineFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(machineFile, 'utf8')).toBe(`${STACK_PASSWORD_KEY}=${first.password}\n`);
    expect(ensureMachinePassword(machineFile)).toEqual({
      password: first.password,
      created: false,
    });
    expect(readMachinePassword(machineFile)).toBe(first.password);
  });

  it('is absent until written, and a file without it is refused by name', () => {
    const host = dir();
    expect(readMachinePassword(join(host, STACK_ENV_FILE))).toBeUndefined();
    mkdirSync(join(host, 'empty'));
    writeFileSync(join(host, 'empty', STACK_ENV_FILE), '# nothing\n');
    expect(() => readMachinePassword(join(host, 'empty', STACK_ENV_FILE))).toThrow(
      new RegExp(`holds no ${STACK_PASSWORD_KEY}.*yarn redis:password`),
    );
  });
});
