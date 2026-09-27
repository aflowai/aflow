/**
 * The observation, and what it reports when it cannot be made.
 *
 * The claim is the half that cannot be wrong about itself; every case here is
 * about the half that can.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { EditionDescriptor } from '@aflow/schemas';

const mocks = vi.hoisted(() => ({ hasAvailableExecutor: vi.fn() }));

vi.mock('@aflow/redis', () => ({ hasAvailableExecutor: mocks.hasAvailableExecutor }));

const { readComputeAvailability } = await import('./computeAvailability.js');

const edition = (computeRuntime: 'present' | 'absent'): EditionDescriptor => ({
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: 'a0000000-0000-0000-0000-000000000001' },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime,
});

/** A fresh connection per case: a reading is held against the connection it came from. */
const connection = (): Redis => ({}) as Redis;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readComputeAvailability', () => {
  let redis: Redis;
  beforeEach(() => {
    redis = connection();
  });

  it('reports the executor that is answering', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(true);
    expect(await readComputeAvailability(redis, edition('present'))).toEqual({
      composed: 'present',
      executor: 'up',
    });
  });

  /** The case the claim alone cannot express: composed, and not running. */
  it('reports a composed runtime whose executor is gone', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(false);
    expect(await readComputeAvailability(redis, edition('present'))).toEqual({
      composed: 'present',
      executor: 'down',
    });
  });

  it('asks about compute and nothing else', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(true);
    await readComputeAvailability(redis, edition('present'));
    expect(mocks.hasAvailableExecutor).toHaveBeenCalledWith(redis, 'compute');
  });

  it.each([
    ['no connection', undefined],
    ['a null connection', null],
  ])('cannot ask through %s, and says so rather than guessing', async (_label, connection) => {
    expect(await readComputeAvailability(connection, edition('present'))).toEqual({
      composed: 'present',
      executor: 'unknown',
    });
  });

  /**
   * Reporting `down` for a refused Redis call names the wrong cause on the one
   * screen an operator opens to find the right one.
   */
  it('cannot reach Redis, and does not call that a stopped executor', async () => {
    mocks.hasAvailableExecutor.mockRejectedValue(new Error('READONLY'));
    expect(await readComputeAvailability(redis, edition('present'))).toEqual({
      composed: 'present',
      executor: 'unknown',
    });
  });

  it('carries the claim through unchanged', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(false);
    expect((await readComputeAvailability(connection(), edition('absent'))).composed).toBe(
      'absent',
    );
  });
});

/**
 * `hasAvailableExecutor` scans the keyspace, so a per-request call puts an
 * O(keys) operation on an operator-facing endpoint.
 */
describe('how often the executor is asked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds one reading rather than scanning per call', async () => {
    const redis = connection();
    mocks.hasAvailableExecutor.mockResolvedValue(true);

    await readComputeAvailability(redis, edition('present'));
    await readComputeAvailability(redis, edition('present'));
    await readComputeAvailability(redis, edition('present'));

    expect(mocks.hasAvailableExecutor).toHaveBeenCalledTimes(1);
  });

  it('takes a new one once the old has stood long enough', async () => {
    const redis = connection();
    mocks.hasAvailableExecutor.mockResolvedValue(true);
    await readComputeAvailability(redis, edition('present'));

    vi.advanceTimersByTime(5_000);
    mocks.hasAvailableExecutor.mockResolvedValue(false);

    expect(await readComputeAvailability(redis, edition('present'))).toEqual({
      composed: 'present',
      executor: 'down',
    });
    expect(mocks.hasAvailableExecutor).toHaveBeenCalledTimes(2);
  });

  it('holds nothing across connections', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(true);
    await readComputeAvailability(connection(), edition('present'));
    await readComputeAvailability(connection(), edition('present'));

    expect(mocks.hasAvailableExecutor).toHaveBeenCalledTimes(2);
  });
});
