/**
 * Contract: a retried operation task's job carries the conversation that
 * started its run, as the first dispatch's does, so a retry of a commission
 * from a conversation continues the session that conversation's runs keep on
 * the executor. A run no conversation started carries none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, TenantId } from '@aflow/schemas';

const OPERATION = 'host.harness.run';
const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = '22222222-2222-4222-9222-222222222222';
const CONVERSATION = '77777777-7777-4777-9777-777777777777';

const mockDispatchClaimedOperationTask = vi.fn();
const mockLoadRun = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionState: () => Promise.resolve(null),
  readSpaceContextGen: () => Promise.resolve(0),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  claimRetriedTask: () => Promise.resolve(true),
}));

vi.mock('../helpers.js', () => ({
  loadRunByRunIdAcrossSpaces: (...args: unknown[]) => mockLoadRun(...args),
  resolveWorkflowForRun: () =>
    Promise.resolve({
      tasks: [
        { taskId: 'commission', name: 'Commission', type: 'operation', operation: OPERATION },
      ],
    }),
  emitTaskUpdate: () => Promise.resolve(),
}));

vi.mock('../../taskHelpers.js', () => ({
  buildTaskInputRef: () => Promise.resolve('inline:e30='),
  buildDelegateTaskInput: () => Promise.reject(new Error('an operation task builds no delegate')),
}));

vi.mock('../taskAuthority.js', () => ({
  resolveWorkflowTaskAuthority: () => Promise.resolve({ activatedByPerson: false }),
}));

vi.mock('../runnerBridge.js', () => ({
  spawnRunnerSession: () => Promise.reject(new Error('an operation task spawns no runner')),
}));

vi.mock('../operationTaskDispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../operationTaskDispatch.js')>();
  return {
    ...actual,
    resolveOperationTaskSnoozeDelayMs: () => Promise.resolve(0),
    dispatchClaimedOperationTask: (...args: unknown[]) => mockDispatchClaimedOperationTask(...args),
  };
});

const { dispatchRetriedTask } = await import('../dispatchRetriedTask.js');

function runStartedBy(sessionId: string | null) {
  return {
    runId: RUN_ID,
    spaceId: '55555555-5555-4555-9555-555555555555',
    workflowSlug: 'commission-change',
    workflowRevision: 1,
    sessionId,
    evalBatchId: null,
    metadata: null,
    tasks: [],
  };
}

async function retry(): Promise<Record<string, unknown>> {
  await dispatchRetriedTask({ db: {}, redis: {}, payloadStore: {} } as never, {
    tenantId: TENANT,
    runId: RUN_ID,
    taskId: 'commission',
    attempt: 2,
    helmsmanSessionId: CONVERSATION as SessionId,
  });
  expect(mockDispatchClaimedOperationTask).toHaveBeenCalledTimes(1);
  return mockDispatchClaimedOperationTask.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  mockDispatchClaimedOperationTask.mockReset().mockResolvedValue('enqueued');
  mockLoadRun.mockReset();
});

describe('a retried operation task', () => {
  it('carries the conversation that started its run', async () => {
    mockLoadRun.mockResolvedValue(runStartedBy(CONVERSATION));
    const dispatched = await retry();
    expect(dispatched['startingConversationId']).toBe(CONVERSATION);
  });

  it('carries none for a run no conversation started', async () => {
    mockLoadRun.mockResolvedValue(runStartedBy(null));
    const dispatched = await retry();
    expect(dispatched).not.toHaveProperty('startingConversationId');
  });
});
