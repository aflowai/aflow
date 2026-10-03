/**
 * The full start's one-shot, with the database and the runtime stood in for:
 * the host identity it establishes on a Redis that takes no ACL file, and the
 * password it uses to do it — the one `instance.env` holds now, not the one in
 * the environment it was started with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FRESH_STAND_IN = 'fresh-stand-in';
const STALE_STAND_IN = 'stale-stand-in';

const boot = vi.hoisted(() => ({
  redis: { call: vi.fn() },
  closed: vi.fn(() => Promise.resolve()),
  aclOutcome: vi.fn<() => Promise<{ outcome: 'loaded' } | { outcome: 'skipped'; reason: null }>>(),
  applied:
    vi.fn<
      (redis: unknown, input: { defaultPassword: string; hostPassword: string }) => Promise<void>
    >(),
  instanceValues: {} as Record<string, string>,
}));

vi.mock('../env.js', () => ({}));
vi.mock('@aflow/schemas', () => ({ resolveEditionDescriptor: () => ({}) }));
vi.mock('@aflow/database', () => ({
  createDatabase: () => ({ sql: {}, db: {}, close: () => Promise.resolve() }),
  getDatabaseConfig: () => ({}),
}));
vi.mock('@aflow/redis', () => ({
  getRedisConnection: () => boot.redis,
  closeRedisConnection: boot.closed,
}));
vi.mock('@aflow/server-runtime/bootstrap', () => ({
  bootstrapLocalEdition: () => Promise.resolve({ steps: [], spaceIds: [] }),
  ensureInstanceConfig: (dir: string) =>
    Promise.resolve({
      path: `${dir}/instance.env`,
      generated: [],
      audiences: {},
      values: boot.instanceValues,
    }),
  findLocalAuthConfigViolations: () => [],
  loadRedisAclIntoRunningServer: boot.aclOutcome,
  applyHostIdentityToRunningServer: boot.applied,
  localOwner: () => ({ userId: 'owner' }),
}));

async function fullStart(): Promise<void> {
  vi.resetModules();
  await import('../bootstrapLocal.js');
  await vi.waitFor(() => {
    expect(boot.closed).toHaveBeenCalledTimes(1);
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('PHOENIX_INSTANCE_DIR', '/Users/example/.aflow/dev-local');
  // What the supervisor captured before a revocation rotated the file.
  vi.stubEnv('PHOENIX_HOST_REDIS_PASSWORD', STALE_STAND_IN);
  boot.instanceValues = { PHOENIX_HOST_REDIS_PASSWORD: FRESH_STAND_IN, REDIS_PASSWORD: 'd' };
  boot.aclOutcome.mockResolvedValue({ outcome: 'skipped', reason: null });
  boot.applied.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('the full start, on a Redis without an ACL file', () => {
  it('applies the host identity with the password instance.env holds now', async () => {
    await fullStart();

    expect(boot.applied).toHaveBeenCalledTimes(1);
    expect(boot.applied.mock.calls[0]?.[0]).toBe(boot.redis);
    expect(boot.applied.mock.calls[0]?.[1].hostPassword).toBe(FRESH_STAND_IN);
    expect(console.log).toHaveBeenCalledWith(
      '[bootstrap] applied the host identity to the running Redis',
    );
  });

  it('applies nothing where the instance has no host lane', async () => {
    boot.instanceValues = { REDIS_PASSWORD: 'd' };
    vi.stubEnv('PHOENIX_HOST_REDIS_PASSWORD', '');

    await fullStart();

    expect(boot.applied).not.toHaveBeenCalled();
  });

  it('finishes the start when Redis refuses, and says what it could not do', async () => {
    boot.applied.mockRejectedValueOnce(new Error('NOPERM this user has no permissions'));

    await fullStart();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not apply the host identity'),
    );
  });
});

describe('the full start, on a Redis that loaded its ACL file', () => {
  it('leaves the host identity to the file', async () => {
    boot.aclOutcome.mockResolvedValue({ outcome: 'loaded' });

    await fullStart();

    expect(boot.applied).not.toHaveBeenCalled();
  });
});
