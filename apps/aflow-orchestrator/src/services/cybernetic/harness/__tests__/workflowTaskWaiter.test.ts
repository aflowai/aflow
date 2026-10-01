/**
 * Contract: a workflow task that started a run is answered when that run
 * ends, through the same result path an executor's answer takes, and by
 * nothing before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantId } from '@aflow/schemas';

const mockLoadPendingWaiters = vi.fn();
const mockLoadWorkflowTaskByWorkerSession = vi.fn();
const mockMarkWaiterNotified = vi.fn();
const mockBuildWorkflowRunDetail = vi.fn();
vi.mock('@aflow/cybernetic-runtime', () => ({
  loadPendingWaiters: (...args: unknown[]) => mockLoadPendingWaiters(...args),
  loadWorkflowTaskByWorkerSession: (...args: unknown[]) =>
    mockLoadWorkflowTaskByWorkerSession(...args),
  markWaiterNotified: (...args: unknown[]) => mockMarkWaiterNotified(...args),
  buildWorkflowRunDetail: (...args: unknown[]) => mockBuildWorkflowRunDetail(...args),
  rehydrateParkedStep: vi.fn().mockResolvedValue(false),
  surfaceWorkflowResumeContract: vi.fn().mockResolvedValue(null),
}));

const mockAddStepResult = vi.fn();
const mockGetStepState = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getStepState: (...args: unknown[]) => mockGetStepState(...args),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
  updateSessionState: vi.fn(),
  updateStepState: vi.fn(),
}));

vi.mock('../helpers.js', () => ({
  emitTerminalRunUpdate: vi.fn().mockResolvedValue(undefined),
  loadRunByRunIdAcrossSpaces: vi.fn().mockResolvedValue({ spaceId: 'space-1' }),
}));

vi.mock('../sessionWakeup.js', () => ({ deliverSessionWakeup: vi.fn() }));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

import { notifyWaiters } from '../waiters.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const CHILD_RUN = 'review-run-1';
const PARENT_RUN = 'publish-run-1';
const WORKER = '77777777-2222-3333-4444-555555555555';

const stored: unknown[] = [];
const deps = {
  db: {} as never,
  redis: {} as never,
  payloadStore: {
    store: vi.fn((entry: { data: unknown }) => {
      stored.push(entry.data);
      return Promise.resolve(`gs://bucket/envelope-${String(stored.length)}`);
    }),
    retrieve: vi.fn(),
  } as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  stored.length = 0;
  mockLoadPendingWaiters.mockResolvedValue([
    { id: 'waiter-1', waiterSessionId: WORKER, waiterStepExecutionId: WORKER },
  ]);
  mockLoadWorkflowTaskByWorkerSession.mockResolvedValue({
    runId: PARENT_RUN,
    taskId: 'review-commit',
    attempt: 1,
  });
  // A run that promoted an approving verdict — which a run that did not
  // complete can also have done on the way.
  mockBuildWorkflowRunDetail.mockResolvedValue({
    tasks: [],
    result: { output: { verdict: 'approve', reviewSummary: 'Fine.' } },
  });
});

describe('a workflow task waiting on the run it started', () => {
  it('is answered on completion, as its own task, with the run’s output', async () => {
    await notifyWaiters(deps, { tenantId: TENANT, runId: CHILD_RUN, outcome: 'completed' });

    expect(mockLoadWorkflowTaskByWorkerSession).toHaveBeenCalledWith(
      deps.db,
      TENANT,
      WORKER,
    );
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const [, result] = mockAddStepResult.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(result).toMatchObject({
      tenantId: TENANT,
      workflowExecution: {
        runId: PARENT_RUN,
        taskId: 'review-commit',
        attempt: 1,
        dispatchAttemptToken: `dispatch:${PARENT_RUN}:review-commit:1`,
      },
      stepExecutionId: WORKER,
      stepId: 'review-commit',
      operationId: 'workflow.run.start',
      status: 'SUCCEEDED',
      outputRef: 'gs://bucket/envelope-1',
    });
    expect(result).not.toHaveProperty('sessionId');
    expect(stored[0]).toMatchObject({
      runId: CHILD_RUN,
      outcome: 'completed',
      result: { output: { verdict: 'approve' } },
    });
    expect(mockMarkWaiterNotified).toHaveBeenCalledWith(deps.db, TENANT, {
      waiterId: 'waiter-1',
      outcome: 'completed',
    });
    // Never treated as a Helmsman's parked step.
    expect(mockGetStepState).not.toHaveBeenCalled();
  });

  it('carries no output from a run that did not complete, whatever it promoted', async () => {
    for (const outcome of ['failed', 'cancelled'] as const) {
      vi.clearAllMocks();
      stored.length = 0;
      await notifyWaiters(deps, { tenantId: TENANT, runId: CHILD_RUN, outcome });

      expect(mockAddStepResult).toHaveBeenCalledOnce();
      expect(stored[0]).toMatchObject({ runId: CHILD_RUN, outcome });
      expect(stored[0]).not.toHaveProperty('result');
      expect(mockMarkWaiterNotified).toHaveBeenCalledWith(deps.db, TENANT, {
        waiterId: 'waiter-1',
        outcome,
      });
    }
  });

  it('stays waiting through a pause and a takeover', async () => {
    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: CHILD_RUN,
      outcome: 'paused',
      pauseVersion: 1,
    });
    await notifyWaiters(deps, { tenantId: TENANT, runId: CHILD_RUN, outcome: 'handed_off' });

    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();
    expect(mockGetStepState).not.toHaveBeenCalled();
  });

  it('leaves a Helmsman’s parked step to the session path', async () => {
    mockLoadWorkflowTaskByWorkerSession.mockResolvedValue(null);
    mockGetStepState.mockResolvedValue(null);

    await notifyWaiters(deps, { tenantId: TENANT, runId: CHILD_RUN, outcome: 'completed' });

    expect(mockGetStepState).toHaveBeenCalled();
    const results = mockAddStepResult.mock.calls as Array<[unknown, Record<string, unknown>]>;
    expect(results.some(([, r]) => r['workflowExecution'] !== undefined)).toBe(false);
  });
});
