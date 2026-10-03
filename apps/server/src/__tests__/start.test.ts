/**
 * The server's own start, with the runtime stood in for: what it does once it
 * is listening, every time it starts — not only when the stack is provisioned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    log,
    redis: { call: vi.fn() },
    asserted: vi.fn<(redis: unknown) => Promise<{ outcome: 'asserted' | 'absent' }>>(),
    serve: vi.fn(() => Promise.resolve({ log })),
  };
});

vi.mock('../env.js', () => ({}));
vi.mock('@aflow/schemas', () => ({ resolveEditionDescriptor: () => ({}) }));
vi.mock('@aflow/redis', () => ({ getRedisConnection: () => boot.redis }));
vi.mock('@aflow/server-runtime', () => ({
  closeOnSignal: vi.fn(),
  resolveListenHost: () => '127.0.0.1',
  serve: boot.serve,
}));
vi.mock('@aflow/server-runtime/bootstrap', () => ({
  assertHostGrantOnRunningServer: boot.asserted,
}));

import { start } from '../start.js';

const composition = {} as Parameters<typeof start>[0];
const STALE_STAND_IN = 'stand-in';

beforeEach(() => {
  vi.stubEnv('PHOENIX_HOST_REDIS_PASSWORD', STALE_STAND_IN);
  boot.asserted.mockResolvedValue({ outcome: 'asserted' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('the server’s start', () => {
  it('asserts the host grant on the running Redis each time it starts, and says so', async () => {
    start(composition);
    await vi.waitFor(() => {
      expect(boot.asserted).toHaveBeenCalledTimes(1);
    });
    start(composition);
    await vi.waitFor(() => {
      expect(boot.asserted).toHaveBeenCalledTimes(2);
    });

    // The environment's host password goes nowhere: after a revocation it is
    // the revoked one.
    for (const call of boot.asserted.mock.calls) {
      expect(call).toEqual([boot.redis]);
    }
    await vi.waitFor(() => {
      expect(boot.log.info).toHaveBeenCalledTimes(2);
    });
    expect(boot.log.info).toHaveBeenCalledWith('Asserted the host grant on the running Redis');
  });

  it('creates no host identity when Redis has none, says what does, and keeps serving', async () => {
    boot.asserted.mockResolvedValueOnce({ outcome: 'absent' });

    start(composition);
    await vi.waitFor(() => {
      expect(boot.log.warn).toHaveBeenCalledTimes(1);
    });

    const warning = String(boot.log.warn.mock.calls[0]?.[0]);
    expect(warning).toContain('no host identity');
    expect(warning).toContain('Pairing a machine, or a full start, creates it.');
    expect(boot.asserted.mock.calls).toEqual([[boot.redis]]);
    expect(boot.redis.call).not.toHaveBeenCalled();
    expect(boot.log.info).not.toHaveBeenCalled();
  });

  it('asserts nothing where there is no host lane', async () => {
    vi.stubEnv('PHOENIX_HOST_REDIS_PASSWORD', '');

    start(composition);
    await vi.waitFor(() => {
      expect(boot.serve).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(boot.asserted).not.toHaveBeenCalled();
  });

  it('keeps serving when Redis refuses the assertion, and logs what that leaves refused', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    boot.asserted.mockRejectedValueOnce(new Error('NOPERM this user has no permissions'));

    start(composition);
    await vi.waitFor(() => {
      expect(boot.log.error).toHaveBeenCalledTimes(1);
    });

    expect(String(boot.log.error.mock.calls[0]?.[1])).toContain('a paired machine is refused');
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
