/**
 * The eval-batch cycle must hand every tenant it claims back to the pointer.
 *
 * A claim leases a tenant away from every other instance, so a cycle that
 * returns without settling or releasing one has parked that tenant's batches for
 * the length of the lease — its trials keep burning budget with nobody observing
 * them. And a cycle that reported more work would re-arm at zero delay against a
 * tenant that stays due for as long as its batch runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantId } from '@aflow/schemas';

const claimDueEvalBatchTenants = vi.fn();
const settleEvalBatchTenantDue = vi.fn();
const releaseEvalBatchTenantClaim = vi.fn();
const processTenant = vi.fn();

vi.mock('@aflow/database', () => ({
  claimDueEvalBatchTenants: (...args: unknown[]) => claimDueEvalBatchTenants(...args),
  settleEvalBatchTenantDue: (...args: unknown[]) => settleEvalBatchTenantDue(...args),
  releaseEvalBatchTenantClaim: (...args: unknown[]) => releaseEvalBatchTenantClaim(...args),
}));

vi.mock('../EvalBatchEngine.js', () => ({
  EvalBatchEngine: class {
    processTenant(tenantId: TenantId, options: { signal?: AbortSignal }): Promise<unknown> {
      return processTenant(tenantId, options) as Promise<unknown>;
    }
  },
}));

const { createEvalBatchWorker } = await import('../evalBatchWorkerLoop.js');

function worker(
  overrides: { maxBatch?: number; maxCycleMs?: number; mode?: 'enabled' | 'observe' } = {},
): ReturnType<typeof createEvalBatchWorker> {
  return createEvalBatchWorker(
    { sqlClient: {} as never, harnessDeps: {} as never },
    { maxBatch: 10, ...overrides },
  );
}

describe('eval-batch worker cycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimDueEvalBatchTenants.mockResolvedValue([]);
    settleEvalBatchTenantDue.mockResolvedValue({ drained: false, rearmed: false });
    releaseEvalBatchTenantClaim.mockResolvedValue(undefined);
    processTenant.mockResolvedValue({ batches: 1, errors: 0 });
  });

  it('touches no tenant when nothing is due', async () => {
    const result = await worker().runOnce();

    expect(result).toEqual({ candidates: 0 });
    expect(processTenant).not.toHaveBeenCalled();
    expect(settleEvalBatchTenantDue).not.toHaveBeenCalled();
  });

  it('never claims a tenant the pointer does not nominate', async () => {
    // A tenant with no batch and no expiring fixture space holds no pointer
    // row, so the only read a cycle makes cannot return it — the engine is
    // never handed a tenant it would find nothing to do in.
    claimDueEvalBatchTenants.mockResolvedValue([]);

    await worker().runOnce();

    expect(claimDueEvalBatchTenants).toHaveBeenCalledTimes(1);
    expect(processTenant).not.toHaveBeenCalled();
  });

  it('advances and settles every tenant it claimed', async () => {
    claimDueEvalBatchTenants.mockResolvedValue([
      { tenantId: 'tenant-a', armedSeq: '3' },
      { tenantId: 'tenant-b', armedSeq: '7' },
    ]);

    const result = await worker().runOnce();

    expect(result.candidates).toBe(2);
    expect(result.processed).toBe(2);
    expect(processTenant.mock.calls.map((c) => c[0])).toEqual(['tenant-a', 'tenant-b']);
    expect(settleEvalBatchTenantDue.mock.calls.map((c) => c[1])).toEqual([
      { tenantId: 'tenant-a', armedSeq: '3' },
      { tenantId: 'tenant-b', armedSeq: '7' },
    ]);
  });

  it('passes the cycle signal through so a stopped cycle stops mid-tenant', async () => {
    claimDueEvalBatchTenants.mockResolvedValue([{ tenantId: 'tenant-a', armedSeq: '1' }]);

    await worker().runOnce();

    const [, options] = processTenant.mock.calls[0] as [TenantId, { signal?: AbortSignal }];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('still settles a tenant whose pass threw', async () => {
    // Otherwise one failing tenant holds its own lease for a full cycle budget
    // while the pointer keeps saying it is due.
    claimDueEvalBatchTenants.mockResolvedValue([{ tenantId: 'tenant-a', armedSeq: '1' }]);
    processTenant.mockRejectedValue(new Error('tenant exploded'));

    const result = await worker().runOnce();

    expect(result.failed).toBe(1);
    expect(settleEvalBatchTenantDue).toHaveBeenCalledTimes(1);
  });

  it('a tenant whose batches reported errors is not counted clean', async () => {
    claimDueEvalBatchTenants.mockResolvedValue([{ tenantId: 'tenant-a', armedSeq: '1' }]);
    processTenant.mockResolvedValue({ batches: 2, errors: 1 });

    const result = await worker().runOnce();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    // Unclean is not unsettled: the pointer still moves, so the leftover work
    // comes back on the tenant's next due time instead of holding the lease.
    expect(settleEvalBatchTenantDue).toHaveBeenCalledTimes(1);
  });

  it('counts but leaves the pointer untouched in observe mode', async () => {
    claimDueEvalBatchTenants.mockResolvedValue([{ tenantId: 'tenant-a', armedSeq: '1' }]);

    const result = await worker({ mode: 'observe' }).runOnce();

    expect(result).toEqual({ candidates: 1 });
    expect(processTenant).not.toHaveBeenCalled();
    expect(settleEvalBatchTenantDue).not.toHaveBeenCalled();
    // A held lease keeps the tenant from whatever else would have advanced it.
    expect(releaseEvalBatchTenantClaim).toHaveBeenCalledTimes(1);
  });

  it('releases an unprocessed claim when the cycle is out of budget', async () => {
    claimDueEvalBatchTenants.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [
        { tenantId: 'tenant-a', armedSeq: '1' },
        { tenantId: 'tenant-b', armedSeq: '1' },
      ];
    });

    const result = await worker({ maxCycleMs: 1 }).runOnce();

    expect(result.processed).toBe(0);
    expect(processTenant).not.toHaveBeenCalled();
    expect(releaseEvalBatchTenantClaim.mock.calls.map((c) => c[1])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
  });

  it('never reports more work, even on a full batch', async () => {
    // A live batch keeps its tenant due, so `hasMore` here is not a backlog
    // signal — it is a zero-delay re-arm against work that cannot drain.
    claimDueEvalBatchTenants.mockResolvedValue(
      Array.from({ length: 2 }, (_, i) => ({ tenantId: `t-${String(i)}`, armedSeq: '1' })),
    );

    const result = await worker({ maxBatch: 2 }).runOnce();

    expect(result.hasMore).toBeUndefined();
  });
});
