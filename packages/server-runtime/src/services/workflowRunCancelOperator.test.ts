import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@aflow/schemas';

const mockLoadRunById = vi.fn();
const mockEnqueue = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
  enqueueWorkflowHarnessAdvance: (...args: unknown[]) => mockEnqueue(...args),
}));

import { cancelWorkflowRunFromOperatorUi } from './workflowRunCancelOperator.js';

const TENANT = '00000000-0000-4000-8000-000000000001' as unknown as TenantId;
const SPACE = '00000000-0000-4000-8000-000000000003';
const RUN = '00000000-0000-4000-8000-00000000aaaa';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles
const deps = { db: {} as any, redis: {} as any, payloadStore: {} as any };

function call(reason?: string) {
  return cancelWorkflowRunFromOperatorUi(deps, {
    tenantId: TENANT,
    spaceId: SPACE,
    userId: 'operator',
    input: { runId: RUN, ...(reason !== undefined ? { reason } : {}) },
  });
}

describe('cancelWorkflowRunFromOperatorUi', () => {
  beforeEach(() => {
    mockLoadRunById.mockReset();
    mockEnqueue.mockReset();
    mockEnqueue.mockResolvedValue('1-0');
  });

  it('returns WORKFLOW_RUN_NOT_FOUND when the run is missing, no enqueue', async () => {
    mockLoadRunById.mockResolvedValue(null);
    const res = await call();
    expect(res).toEqual({
      ok: false,
      code: 'WORKFLOW_RUN_NOT_FOUND',
      message: expect.any(String),
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'returns WORKFLOW_RUN_ALREADY_TERMINAL for a %s run, no enqueue',
    async (status) => {
      mockLoadRunById.mockResolvedValue({ runId: RUN, status });
      const res = await call();
      expect(res).toMatchObject({ ok: false, code: 'WORKFLOW_RUN_ALREADY_TERMINAL' });
      expect(mockEnqueue).not.toHaveBeenCalled();
    },
  );

  it.each(['running', 'paused'] as const)(
    'enqueues a cancel cascade for a %s run and returns cancelling',
    async (status) => {
      mockLoadRunById.mockResolvedValue({ runId: RUN, status });
      const res = await call('done with it');
      expect(res).toEqual({ ok: true, output: { runId: RUN, status: 'cancelling' } });
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue).toHaveBeenCalledWith(deps.redis, {
        tenantId: TENANT,
        workflowRunId: RUN,
        spaceId: SPACE,
        action: 'cancel',
        // Operator-cancel legibility — this route IS the operator's
        // deliberate stop; the actor must ride the cascade.
        cancelledBy: 'operator',
        reason: 'done with it',
      });
    },
  );

  it('omits reason from the enqueued message when not provided', async () => {
    mockLoadRunById.mockResolvedValue({ runId: RUN, status: 'running' });
    await call();
    expect(mockEnqueue).toHaveBeenCalledWith(deps.redis, {
      tenantId: TENANT,
      workflowRunId: RUN,
      spaceId: SPACE,
      action: 'cancel',
      cancelledBy: 'operator',
    });
  });
});
