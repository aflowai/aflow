/**
 * Fixture-space reaping (Plan 269 D5): an expired space with a NON-TERMINAL
 * run is never reaped — deleting it would tear a live trial out from under
 * the engine — its expiry is renewed instead; spaces whose runs are all
 * terminal reap through the ordinary cascade.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockCascadeDeleteSpace = vi.fn();
vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    cascadeDeleteSpace: (...a: unknown[]) => mockCascadeDeleteSpace(...a),
  };
});

import { reapExpiredEvalFixtureSpaces } from '../fixtureSpaces.js';

const SCHEMA = 'tenant_test';

function fakeSqlClient(params: { renewedIds: string[]; expiredIds: string[] }) {
  const unsafe = vi
    .fn()
    .mockResolvedValueOnce(params.renewedIds.map((id) => ({ id })))
    .mockResolvedValueOnce(params.expiredIds.map((id) => ({ id })));
  const begin = vi.fn(async (cb: (tx: unknown) => Promise<void>) => cb({}));
  return { client: { unsafe, begin } as never, unsafe, begin };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCascadeDeleteSpace.mockResolvedValue(undefined);
});

describe('reapExpiredEvalFixtureSpaces', () => {
  it('renews expiry on expired spaces with live runs instead of reaping them', async () => {
    const { client, unsafe } = fakeSqlClient({ renewedIds: ['space-live'], expiredIds: [] });

    const result = await reapExpiredEvalFixtureSpaces(client, SCHEMA, {
      limit: 10,
      liveRunRenewalMs: 60 * 60 * 1000,
    });

    expect(result).toEqual({ reaped: 0, renewed: 1 });
    expect(mockCascadeDeleteSpace).not.toHaveBeenCalled();

    const renewalQuery = unsafe.mock.calls[0]![0] as string;
    expect(renewalQuery).toContain('UPDATE');
    expect(renewalQuery).toContain('expires_at = NOW() + (3600');
    expect(renewalQuery).toContain("status NOT IN ('completed', 'failed', 'cancelled')");
    expect(renewalQuery).toContain('EXISTS');
  });

  it('reaps only expired spaces with NO non-terminal runs (guard in the select)', async () => {
    const { client, unsafe } = fakeSqlClient({
      renewedIds: [],
      expiredIds: ['space-a', 'space-b'],
    });

    const result = await reapExpiredEvalFixtureSpaces(client, SCHEMA, {
      limit: 10,
      liveRunRenewalMs: 1000,
    });

    expect(result).toEqual({ reaped: 2, renewed: 0 });
    expect(mockCascadeDeleteSpace).toHaveBeenCalledTimes(2);
    expect(mockCascadeDeleteSpace.mock.calls.map((c) => c[2])).toEqual(['space-a', 'space-b']);

    const selectQuery = unsafe.mock.calls[1]![0] as string;
    expect(selectQuery).toContain('NOT EXISTS');
    expect(selectQuery).toContain("status NOT IN ('completed', 'failed', 'cancelled')");
  });

  it('a failing cascade is isolated — the rest of the page still reaps', async () => {
    const { client } = fakeSqlClient({ renewedIds: [], expiredIds: ['space-a', 'space-b'] });
    mockCascadeDeleteSpace.mockRejectedValueOnce(new Error('fk surprise'));

    const result = await reapExpiredEvalFixtureSpaces(client, SCHEMA, {
      limit: 10,
      liveRunRenewalMs: 1000,
    });

    expect(result).toEqual({ reaped: 1, renewed: 0 });
  });
});
