/**
 * Contract: an executor whose credential the server refuses waits and says so,
 * rather than exiting into a silence the appliance reads as a lane that is down.
 */
import { describe, expect, it } from 'vitest';

import { waitForRedisCredential } from '../index.js';

function probeThatFails(times: number) {
  let calls = 0;
  const quits: number[] = [];
  const connect = () => {
    const n = ++calls;
    return {
      ping: async () => {
        if (n <= times)
          throw new Error('WRONGPASS invalid username-password pair or user is disabled.');
        return 'PONG';
      },
      quit: async () => {
        quits.push(n);
        return 'OK';
      },
      status: 'ready',
      disconnect: () => undefined,
    } as unknown as import('ioredis').default;
  };
  return { connect, calls: () => calls, quits };
}

describe('waitForRedisCredential', () => {
  it('returns as soon as the server accepts the credential', async () => {
    const probe = probeThatFails(0);
    const errors: unknown[] = [];
    await waitForRedisCredential(
      {} as never,
      { error: (m, meta) => errors.push([m, meta]) },
      probe.connect,
      async () => undefined,
    );
    expect(probe.calls()).toBe(1);
    expect(errors).toHaveLength(0);
  });

  it('retries with a growing delay, naming the refusal each time, and quits every probe', async () => {
    const probe = probeThatFails(3);
    const errors: Array<Record<string, unknown>> = [];
    const sleeps: number[] = [];
    await waitForRedisCredential(
      {} as never,
      { error: (_m, meta) => errors.push(meta ?? {}) },
      probe.connect,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(probe.calls()).toBe(4);
    expect(sleeps).toEqual([5_000, 15_000, 30_000]);
    expect(errors.map((e) => e['attempt'])).toEqual([1, 2, 3]);
    expect(String(errors[0]?.['error'])).toContain('WRONGPASS');
    expect(probe.quits).toEqual([1, 2, 3, 4]);
  });
});
