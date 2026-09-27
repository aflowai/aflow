/**
 * The reconciler cycle must hand every tenant it claims back to the pointer.
 *
 * A claim leases a tenant away from every other instance, so a cycle that
 * returns without settling or releasing one has parked that tenant's runs for
 * the length of the lease — and a cycle that settles a tenant it never
 * reconciled has moved the pointer past work nobody did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimDueWorkflowRunTenants = vi.fn();
const settleWorkflowRunTenantDue = vi.fn();
const releaseWorkflowRunTenantClaim = vi.fn();
const reconcileStaleRunForTenant = vi.fn();
const reconcileOrphanedRunsForTenant = vi.fn();
const backfillMissingEvaluationEnvelopes = vi.fn();

vi.mock('@aflow/database', () => ({
  claimDueWorkflowRunTenants: (...args: unknown[]) => claimDueWorkflowRunTenants(...args),
  settleWorkflowRunTenantDue: (...args: unknown[]) => settleWorkflowRunTenantDue(...args),
  releaseWorkflowRunTenantClaim: (...args: unknown[]) => releaseWorkflowRunTenantClaim(...args),
}));

vi.mock('../WorkflowRunHarness.js', () => ({
  reconcileStaleRunForTenant: (...args: unknown[]) => reconcileStaleRunForTenant(...args),
  reconcileOrphanedRunsForTenant: (...args: unknown[]) => reconcileOrphanedRunsForTenant(...args),
}));

vi.mock('../evaluationEnvelopeBackfill.js', () => ({
  backfillMissingEvaluationEnvelopes: (...args: unknown[]) =>
    backfillMissingEvaluationEnvelopes(...args),
}));

const { createWorkflowRunSweeper } = await import('../workflowRunSweeperLoop.js');

const CLEAN_STALE = {
  scanned: 0,
  orphans: 0,
  redrives: 0,
  bumps: 0,
  operationBumps: 0,
  zombies: 0,
  escalations: 0,
  errors: 0,
};
const CLEAN_ORPHAN = { scanned: 0, recovered: 0, failed: 0, skipped: 0, errors: 0 };
const CLEAN_BACKFILL = { scanned: 0, crashWindowWrites: 0, historicalPlainWrites: 0, errors: 0 };

function sweeper(
  overrides: { maxBatch?: number; maxCycleMs?: number } = {},
): ReturnType<typeof createWorkflowRunSweeper> {
  return createWorkflowRunSweeper(
    { sqlClient: {} as never, harnessDeps: {} as never },
    { maxBatch: 10, ...overrides },
  );
}

describe('workflow-run sweeper cycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimDueWorkflowRunTenants.mockResolvedValue([]);
    settleWorkflowRunTenantDue.mockResolvedValue({ drained: false, rearmed: false });
    releaseWorkflowRunTenantClaim.mockResolvedValue(undefined);
    reconcileStaleRunForTenant.mockResolvedValue(CLEAN_STALE);
    reconcileOrphanedRunsForTenant.mockResolvedValue(CLEAN_ORPHAN);
    backfillMissingEvaluationEnvelopes.mockResolvedValue(CLEAN_BACKFILL);
  });

  it('touches no tenant when nothing is due', async () => {
    const result = await sweeper().runOnce();

    expect(result).toEqual({ candidates: 0 });
    expect(reconcileStaleRunForTenant).not.toHaveBeenCalled();
    expect(settleWorkflowRunTenantDue).not.toHaveBeenCalled();
  });

  it('reconciles and settles every tenant it claimed', async () => {
    claimDueWorkflowRunTenants.mockResolvedValue([
      { tenantId: 'tenant-a', armedSeq: '3' },
      { tenantId: 'tenant-b', armedSeq: '7' },
    ]);

    const result = await sweeper().runOnce();

    expect(result.candidates).toBe(2);
    expect(result.processed).toBe(2);
    expect(reconcileStaleRunForTenant.mock.calls.map((c) => c[1])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    expect(reconcileOrphanedRunsForTenant.mock.calls.map((c) => c[1])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    // The envelope repair rides the same claim — nothing else revisits a
    // terminal run, so a tenant reconciled without it stays half-converged.
    expect(backfillMissingEvaluationEnvelopes.mock.calls.map((c) => c[1])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    expect(settleWorkflowRunTenantDue.mock.calls.map((c) => c[1])).toEqual([
      { tenantId: 'tenant-a', armedSeq: '3' },
      { tenantId: 'tenant-b', armedSeq: '7' },
    ]);
  });

  it('still settles a tenant whose reconcile threw', async () => {
    // Otherwise one failing tenant holds its own lease for a full cycle budget
    // while the pointer keeps saying it is due.
    claimDueWorkflowRunTenants.mockResolvedValue([{ tenantId: 'tenant-a', armedSeq: '1' }]);
    reconcileStaleRunForTenant.mockRejectedValue(new Error('tenant exploded'));

    const result = await sweeper().runOnce();

    expect(result.failed).toBe(1);
    expect(settleWorkflowRunTenantDue).toHaveBeenCalledTimes(1);
  });

  it('a tenant whose envelope repair reported errors is not counted clean', async () => {
    claimDueWorkflowRunTenants.mockResolvedValue([{ tenantId: 'tenant-a', armedSeq: '1' }]);
    backfillMissingEvaluationEnvelopes.mockResolvedValue({
      ...CLEAN_BACKFILL,
      scanned: 3,
      errors: 1,
    });

    const result = await sweeper().runOnce();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    // Unclean is not unsettled: the pointer still moves, so the leftover runs
    // come back on the tenant's next due time instead of holding the lease.
    expect(settleWorkflowRunTenantDue).toHaveBeenCalledTimes(1);
  });

  it('counts but leaves the pointer untouched in observe mode', async () => {
    claimDueWorkflowRunTenants.mockResolvedValue([{ tenantId: 'tenant-a', armedSeq: '1' }]);

    const result = await createWorkflowRunSweeper(
      { sqlClient: {} as never, harnessDeps: {} as never },
      { maxBatch: 10, mode: 'observe' },
    ).runOnce();

    expect(result).toEqual({ candidates: 1 });
    expect(reconcileStaleRunForTenant).not.toHaveBeenCalled();
    expect(backfillMissingEvaluationEnvelopes).not.toHaveBeenCalled();
    expect(settleWorkflowRunTenantDue).not.toHaveBeenCalled();
    // A held lease keeps the tenant from whatever else would have reconciled it.
    expect(releaseWorkflowRunTenantClaim).toHaveBeenCalledTimes(1);
  });

  it('releases an unprocessed claim when the cycle is out of budget', async () => {
    claimDueWorkflowRunTenants.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [
        { tenantId: 'tenant-a', armedSeq: '1' },
        { tenantId: 'tenant-b', armedSeq: '1' },
      ];
    });

    const result = await sweeper({ maxCycleMs: 1 }).runOnce();

    expect(result.processed).toBe(0);
    expect(reconcileStaleRunForTenant).not.toHaveBeenCalled();
    expect(releaseWorkflowRunTenantClaim.mock.calls.map((c) => c[1])).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
  });

  it('re-arms immediately when the batch came back full', async () => {
    claimDueWorkflowRunTenants.mockResolvedValue(
      Array.from({ length: 2 }, (_, i) => ({ tenantId: `t-${String(i)}`, armedSeq: '1' })),
    );

    const result = await sweeper({ maxBatch: 2 }).runOnce();

    expect(result.hasMore).toBe(true);
  });
});
