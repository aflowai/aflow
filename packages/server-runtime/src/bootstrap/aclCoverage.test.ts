/**
 * Contract: the host grant admits every command the executor actually issues.
 *
 * Three attempts to derive this list by reading were wrong — from helper names,
 * from command categories, and from the executor's import graph — because the
 * runtime's Redis surface is larger than any static reading of it. Each miss
 * authenticated, claimed a job, then failed somewhere unrelated-looking, and
 * each was found by reading `ACL LOG` after the fact.
 *
 * So this derives it from behaviour instead. It applies the real grant to a real
 * Redis, issues the commands the runtime issues around a job, and asserts the
 * server refused nothing. A key family the runtime starts touching next year
 * fails here rather than on an operator's machine, and the failure names the key.
 *
 * `hostLaneFeed.test.ts` beside it takes the same grant further: a real job
 * through a real `ExecutorRuntime`, which is what catches a key family only the
 * running code reaches.
 *
 * Skipped without a reachable Redis, like every other real-redis test here.
 */
import { Redis } from 'ioredis';
import { registerExecutorHeartbeat } from '@aflow/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stackRedis } from '../../../../scripts/stackRedis.mjs';

import {
  applyHostGrant,
  hostGrantDenials,
  hostGrantUrl,
  hostTestUser,
} from './__fixtures__/hostGrantRedis.js';

const TEST_DB = 14;
// ACL users are server-wide, not per database: a developer's paired machine
// authenticates as `hostexec` on this same server, so the grant under test is
// applied to a user of this test's own, never to the live one.
const TEST_USER = hostTestUser('acl');

let admin: Redis | null = null;

// Resolved at module scope: `describe.skipIf` is evaluated when the file is
// collected, which is before any `beforeAll` has run.
const STACK_REDIS = await stackRedis(TEST_DB);

beforeAll(async () => {
  if (!STACK_REDIS.available) return;
  admin = new Redis(STACK_REDIS.url);
  await applyHostGrant(admin, TEST_USER);
  // Only the keys this file creates. Never a flush: this database belongs to
  // whoever else is using it.
  await admin.del(
    'aflow:jobs:host',
    'aflow:executor-heartbeat:host:probe',
    'aflow:executor-heartbeat:browser:probe',
    'aflow:executor-seen:host',
    'aflow:executor-seen:browser',
    'aflow:step-inflight:probe',
    'aflow:step:t:probe:state',
    'aflow:session_events:t:s',
    'aflow:shard:0:results',
    'aflow:retention:candidates',
    'aflow:projection:candidates',
    'aflow:projection:order',
    'aflow:host-inventory:probe',
    'aflow:host-machines',
  );
});

afterAll(async () => {
  if (admin !== null) {
    await admin.call('ACL', 'DELUSER', TEST_USER).catch(() => undefined);
    await admin.quit();
  }
});

describe.skipIf(!STACK_REDIS.available)('host redis grant covers the executor', () => {
  it('applies as a valid ACL', async () => {
    const users = (await admin?.call('ACL', 'LIST')) as string[];
    expect(users.some((u) => u.startsWith(`user ${TEST_USER} `))).toBe(true);
  });

  it('refuses nothing while the executor does its own bookkeeping', async () => {
    const host = new Redis(hostGrantUrl(STACK_REDIS.url, TEST_USER));

    // The bookkeeping every executor does around a job, in the order it does it:
    // register itself, claim from its stream, mark the step, report a result.
    await registerExecutorHeartbeat(host, 'host', 'probe');
    // Idempotent: a group left by a previous run is not what this test measures.
    await host
      .call('XGROUP', 'CREATE', 'aflow:jobs:host', 'exec_host', '$', 'MKSTREAM')
      .catch(() => undefined);
    await host.xadd('aflow:jobs:host', '*', 'stepType', 'host');
    await host.call(
      'XREADGROUP',
      'GROUP',
      'exec_host',
      'probe',
      'COUNT',
      '1',
      'STREAMS',
      'aflow:jobs:host',
      '>',
    );
    // The same executor's second runtime, which serves the browser lane.
    await registerExecutorHeartbeat(host, 'browser', 'probe');
    await host
      .call('XGROUP', 'CREATE', 'aflow:jobs:browser', 'exec_browser', '$', 'MKSTREAM')
      .catch(() => undefined);
    await host.call(
      'XREADGROUP',
      'GROUP',
      'exec_browser',
      'probe',
      'COUNT',
      '1',
      'STREAMS',
      'aflow:jobs:browser',
      '>',
    );
    await host.exists('aflow:cancelled:probe:1');
    await host.set('aflow:step-inflight:probe', '1');
    await host
      .multi()
      .hset('aflow:step:t:probe:state', 'status', 'STARTED')
      .sadd('aflow:retention:candidates', 'aflow:jobs:host')
      .exec();
    await host.xadd('aflow:session_events:t:s', '*', 'type', 'delta');
    await host.publish('aflow:pubsub:session:t:s', 'wake');
    await host.setex('aflow:host-inventory:probe', 60, '{}');
    // The commands the executor actually issues. A probe that exercised the set
    // commands this used to use would pass while the running code was refused.
    await host.zadd('aflow:host-machines', Date.now(), 'probe');
    await host.zrem('aflow:host-machines', 'probe');
    await host.xadd('aflow:shard:0:results', '*', 'status', 'SUCCEEDED');
    // Terminal steps arm the projection candidate, in the same transaction that
    // records the result. Absent from an earlier version of this list, which is
    // how it reached an operator's stack instead of this file.
    await host
      .multi()
      .sadd('aflow:projection:candidates', 't:probe')
      .zadd('aflow:projection:order', 'NX', Date.now(), 't:probe')
      .exec();

    // Reading the input and writing the result, which is the step itself rather
    // than bookkeeping around it — and which this probe did not do, so a grant
    // with no payload keyspace passed here and failed every real run.
    //
    // It hid because an `inline:` ref carries its bytes in the message and
    // touches no key at all. A handler tested with inline input and a small
    // output never reaches the store; a step the orchestrator dispatched always
    // does, because an appliance configures no object storage and the payload
    // store is therefore Redis.
    const payloadBase = 'aflow:payload:tenants/t/runs/r/steps/s/attempt/1';
    await host.exists(`${payloadBase}/output.json`);
    await host.set(`${payloadBase}/output.json`, '{"ok":true}');
    await host.set(`${payloadBase}/error.json`, '{"message":"probe"}');
    await host.get('aflow:payload:tenants/t/runs/r/steps/s/attempt/1/input.json');

    await host.quit();

    expect(admin === null ? [] : await hostGrantDenials(admin, TEST_USER)).toEqual([]);
  });

  it('reads a write-approval grant and is refused writing one', async () => {
    const key = 'aflow:write-approval:t:r:probe';
    await admin?.set(key, '{"requestHash":"probe","decision":"approved"}');
    const host = new Redis(hostGrantUrl(STACK_REDIS.url, TEST_USER));
    try {
      expect(await host.get(key)).toContain('"decision":"approved"');
      await expect(host.set(key, '{"requestHash":"forged","decision":"approved"}')).rejects.toThrow(
        /NOPERM/,
      );
      expect(await admin?.get(key)).toContain('"requestHash":"probe"');
    } finally {
      await host.quit();
      await admin?.del(key);
    }
  });
});
