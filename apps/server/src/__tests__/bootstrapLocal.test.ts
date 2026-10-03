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
  ensured:
    vi.fn<
      (
        redis: unknown,
        input: { defaultPassword: string; hostPassword: string },
      ) => Promise<{ outcome: 'created' | 'asserted' }>
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
  ensureHostIdentityOnRunningServer: boot.ensured,
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
  boot.ensured.mockResolvedValue({ outcome: 'created' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('the full start, on a Redis without an ACL file', () => {
  it('establishes the host identity with the password instance.env holds now', async () => {
    await fullStart();

    expect(boot.ensured).toHaveBeenCalledTimes(1);
    expect(boot.ensured.mock.calls[0]?.[0]).toBe(boot.redis);
    expect(boot.ensured.mock.calls[0]?.[1].hostPassword).toBe(FRESH_STAND_IN);
    expect(console.log).toHaveBeenCalledWith(
      '[bootstrap] created the host identity on the running Redis',
    );
  });

  it('says it brought the grant up to date when the identity was already there', async () => {
    boot.ensured.mockResolvedValueOnce({ outcome: 'asserted' });

    await fullStart();

    expect(console.log).toHaveBeenCalledWith(
      '[bootstrap] asserted the host grant on the running Redis',
    );
  });

  it('establishes nothing where the instance has no host lane', async () => {
    boot.instanceValues = { REDIS_PASSWORD: 'd' };
    vi.stubEnv('PHOENIX_HOST_REDIS_PASSWORD', '');

    await fullStart();

    expect(boot.ensured).not.toHaveBeenCalled();
  });

  it('finishes the start when Redis refuses, and says what it could not do', async () => {
    boot.ensured.mockRejectedValueOnce(new Error('NOPERM this user has no permissions'));

    await fullStart();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not establish the host identity'),
    );
  });
});

describe('the full start, on a Redis that loaded its ACL file', () => {
  it('leaves the host identity to the file', async () => {
    boot.aclOutcome.mockResolvedValue({ outcome: 'loaded' });

    await fullStart();

    expect(boot.ensured).not.toHaveBeenCalled();
  });
});
