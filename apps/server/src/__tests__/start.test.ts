/**
 * The server's own start, with the runtime stood in for: what it does once it
 * is listening, every time it starts — not only when the stack is provisioned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => {
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    log,
    redis: { call: vi.fn() },
    asserted: vi.fn<(redis: unknown, input: unknown) => Promise<void>>(),
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
  applyHostIdentityToRunningServer: boot.asserted,
}));

import { start } from '../start.js';

const composition = {} as Parameters<typeof start>[0];
const HOST_STAND_IN = 'stand-in-host';
const DEFAULT_STAND_IN = 'stand-in-default';

beforeEach(() => {
  vi.stubEnv('PHOENIX_HOST_REDIS_PASSWORD', HOST_STAND_IN);
  vi.stubEnv('REDIS_PASSWORD', DEFAULT_STAND_IN);
  boot.asserted.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('the server’s start', () => {
  it('asserts the host identity on the running Redis each time it starts, and says so', async () => {
    start(composition);
    await vi.waitFor(() => {
      expect(boot.asserted).toHaveBeenCalledTimes(1);
    });
    start(composition);
    await vi.waitFor(() => {
      expect(boot.asserted).toHaveBeenCalledTimes(2);
    });

    for (const [redis, input] of boot.asserted.mock.calls) {
      expect(redis).toBe(boot.redis);
      expect(input).toEqual({
        defaultPassword: DEFAULT_STAND_IN,
        hostPassword: HOST_STAND_IN,
      });
    }
    await vi.waitFor(() => {
      expect(boot.log.info).toHaveBeenCalledTimes(2);
    });
    expect(boot.log.info).toHaveBeenCalledWith('Asserted the host identity on the running Redis');
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
