/**
 * Contract: the server's per-start assertion brings the host grant up to the
 * running code's and never touches the host password; the full start applies
 * the whole identity with the password it has just read, whether or not the
 * identity exists.
 *
 * The environment a server restarts with was read when its supervisor started,
 * so after a revocation the host password in it is the revoked one. An
 * assertion that set it put the revoked credential back on the next restart.
 * A full start reads `instance.env` fresh, so its password is the durable one,
 * and applying it is what retires a live password that drifted from it.
 *
 * The recorded call runs everywhere; the live half, which proves what Redis
 * does with that call, is skipped without a reachable Redis.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HOST_TEST_PASSWORD,
  applyHostGrant,
  hostTestUser,
  redisReachable,
} from './__fixtures__/hostGrantRedis.js';
import {
  applyHostIdentityToRunningServer,
  assertHostGrantOnRunningServer,
  renderRedisAcl,
} from './redisAcl.js';

const ROTATED_STAND_IN = 'rotated-stand-in';
const FRESH_STAND_IN = 'fresh-stand-in';
const REVOKED_STAND_IN = 'revoked-stand-in';
const RETIRED_PATTERN = '~aflow:retired:*';

/** The grant as the renderer writes it, without the identity and its credential. */
const renderedGrant = (
  renderRedisAcl({ defaultPassword: 'd', hostPassword: 'h' })
    .split('\n')
    .find((l) => l.startsWith('user hostexec ')) ?? ''
)
  .split(' ')
  .slice(5);

/** Every `ACL SETUSER` token that sets, adds, removes or resets a password. */
const touchesPassword = (rule: string): boolean =>
  ['resetpass', 'nopass', 'reset'].includes(rule) || /^[<>#!]/.test(rule);

function recordingRedis(existing: boolean): {
  redis: { call: (command: string, ...args: string[]) => Promise<unknown> };
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    redis: {
      call: (command, ...args) => {
        calls.push([command, ...args]);
        if (args[0] === 'GETUSER') return Promise.resolve(existing ? ['flags', ['on']] : null);
        return Promise.resolve('OK');
      },
    },
  };
}

describe('the per-start host grant assertion, as sent', () => {
  it('replaces the grant on an existing user with the rendered one, and sends no password', async () => {
    const { redis, calls } = recordingRedis(true);

    expect(await assertHostGrantOnRunningServer(redis)).toEqual({ outcome: 'asserted' });

    const setuser = calls.find((c) => c[1] === 'SETUSER') ?? [];
    expect(setuser.slice(0, 7)).toEqual([
      'ACL',
      'SETUSER',
      'hostexec',
      'resetkeys',
      'resetchannels',
      'clearselectors',
      '-@all',
    ]);
    // Exactly the rendered grant after the resets, so a pattern the code no
    // longer renders is gone from the user once this lands.
    expect(setuser.slice(7)).toEqual(renderedGrant);
    expect(setuser.filter(touchesPassword)).toEqual([]);
  });

  it('leaves a missing user missing', async () => {
    const { redis, calls } = recordingRedis(false);

    expect(await assertHostGrantOnRunningServer(redis)).toEqual({ outcome: 'absent' });
    expect(calls).toEqual([['ACL', 'GETUSER', 'hostexec']]);
  });
});

describe('the full start’s host identity, as sent', () => {
  const freshlyRead = { defaultPassword: 'd', hostPassword: FRESH_STAND_IN };

  it('replaces an existing user’s password with the one just read, where the restart in place sends none', async () => {
    const { redis, calls } = recordingRedis(true);

    await assertHostGrantOnRunningServer(redis);
    const restartInPlace = calls.splice(0);
    await applyHostIdentityToRunningServer(redis, freshlyRead);

    expect(restartInPlace.flat().filter(touchesPassword)).toEqual([]);
    expect(calls).toEqual([
      ['ACL', 'SETUSER', 'hostexec', 'resetpass', 'on', `>${FRESH_STAND_IN}`, ...renderedGrant],
    ]);
  });
});

const TEST_DB = 14;
const AVAILABLE = await redisReachable(TEST_DB);
const TEST_USER = hostTestUser('assert');
const ABSENT_USER = hostTestUser('absent');
const FULL_START_USER = hostTestUser('full-start');

let admin: Redis | null = null;

beforeAll(() => {
  if (AVAILABLE) admin = new Redis({ host: '127.0.0.1', port: 6379, db: TEST_DB });
});

afterAll(async () => {
  if (admin !== null) {
    await admin
      .call('ACL', 'DELUSER', TEST_USER, ABSENT_USER, FULL_START_USER)
      .catch(() => undefined);
    await admin.quit();
  }
});

async function authenticates(password: string, username: string = TEST_USER): Promise<boolean> {
  const client = new Redis({
    host: '127.0.0.1',
    port: 6379,
    db: TEST_DB,
    username,
    password,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.quit();
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}

async function liveRules(username: string): Promise<{ keys: string[]; channels: string[] }> {
  const flat = (await admin?.call('ACL', 'GETUSER', username)) as unknown[];
  const field = (name: string): string[] => {
    const value = flat[flat.indexOf(name) + 1];
    return typeof value === 'string' ? value.split(' ').filter(Boolean) : [];
  };
  return { keys: field('keys'), channels: field('channels') };
}

describe.skipIf(!AVAILABLE)('the per-start host grant assertion, on a live Redis', () => {
  it('after a rotation, keeps the rotated password and brings the grant up to date', async () => {
    if (admin === null) return;
    // A user paired under an older release: one grant this code adds is
    // missing, and one it dropped is still there.
    await applyHostGrant(admin, TEST_USER, (rules) => [
      ...rules.filter((rule) => rule !== '~aflow:jobs:browser'),
      RETIRED_PATTERN,
    ]);
    await admin.call('ACL', 'SETUSER', TEST_USER, 'resetpass', `>${ROTATED_STAND_IN}`);

    expect(await assertHostGrantOnRunningServer(admin, TEST_USER)).toEqual({
      outcome: 'asserted',
    });

    expect(await authenticates(ROTATED_STAND_IN)).toBe(true);
    expect(await authenticates(HOST_TEST_PASSWORD)).toBe(false);
    const { keys, channels } = await liveRules(TEST_USER);
    expect(keys).toContain('~aflow:jobs:browser');
    expect(keys).not.toContain(RETIRED_PATTERN);
    expect([...keys, ...channels].sort()).toEqual(
      renderedGrant.filter((rule) => /^(~|%|&)/.test(rule)).sort(),
    );
  });

  it('does not create a user that does not exist', async () => {
    if (admin === null) return;
    await admin.call('ACL', 'DELUSER', ABSENT_USER);

    expect(await assertHostGrantOnRunningServer(admin, ABSENT_USER)).toEqual({
      outcome: 'absent',
    });
    expect(await admin.call('ACL', 'GETUSER', ABSENT_USER)).toBeNull();
  });
});

describe.skipIf(!AVAILABLE)('the full start’s host identity, on a live Redis', () => {
  const freshlyRead = { defaultPassword: 'd', hostPassword: FRESH_STAND_IN };

  it('creates the identity a Redis restart removed, with the password just read', async () => {
    if (admin === null) return;
    await admin.call('ACL', 'DELUSER', FULL_START_USER);

    await applyHostIdentityToRunningServer(admin, freshlyRead, FULL_START_USER);

    expect(await authenticates(FRESH_STAND_IN, FULL_START_USER)).toBe(true);
    const { keys, channels } = await liveRules(FULL_START_USER);
    expect([...keys, ...channels].sort()).toEqual(
      renderedGrant.filter((rule) => /^(~|%|&)/.test(rule)).sort(),
    );
  });

  it('corrects a live password that drifted from instance.env, which the restart in place leaves', async () => {
    if (admin === null) return;
    // A revocation rotated instance.env and then failed at ACL SETUSER: the
    // live user still answers to the credential it meant to revoke.
    await applyHostGrant(admin, FULL_START_USER, (rules) => [
      ...rules.filter((rule) => rule !== '~aflow:jobs:browser'),
      RETIRED_PATTERN,
    ]);
    await admin.call('ACL', 'SETUSER', FULL_START_USER, 'resetpass', `>${REVOKED_STAND_IN}`);

    expect(await assertHostGrantOnRunningServer(admin, FULL_START_USER)).toEqual({
      outcome: 'asserted',
    });
    expect(await authenticates(REVOKED_STAND_IN, FULL_START_USER)).toBe(true);
    expect(await authenticates(FRESH_STAND_IN, FULL_START_USER)).toBe(false);

    await applyHostIdentityToRunningServer(admin, freshlyRead, FULL_START_USER);

    expect(await authenticates(FRESH_STAND_IN, FULL_START_USER)).toBe(true);
    expect(await authenticates(REVOKED_STAND_IN, FULL_START_USER)).toBe(false);
    const { keys } = await liveRules(FULL_START_USER);
    expect(keys).toContain('~aflow:jobs:browser');
    expect(keys).not.toContain(RETIRED_PATTERN);
  });
});
