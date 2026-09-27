import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId, TraceId } from '@aflow/schemas';

const mockScheduleShardTimer = vi.fn();
const mockAddStepJob = vi.fn();
const mockDispatchInlineOp = vi.fn();

vi.mock('@aflow/redis', () => ({
  scheduleShardTimer: (...args: unknown[]) => mockScheduleShardTimer(...args),
  addStepJob: (...args: unknown[]) => mockAddStepJob(...args),
}));

vi.mock('../../../SessionOrchestrator/handlers/dispatchInlineOp.js', () => ({
  dispatchInlineOp: (...args: unknown[]) => mockDispatchInlineOp(...args),
}));

import { SNOOZE_OPERATION_ID, SNOOZE_MIN_MS_DEFAULT } from '@aflow/schemas';
import {
  DISPATCH_PENDING_INTERVAL_MS,
  dispatchClaimedOperationTask,
  operationTaskClaimDueAt,
  resolveOperationTaskSnoozeDelayMs,
} from '../operationTaskDispatch.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = '22222222-2222-4222-9222-222222222222';
const WORKER_SESSION_ID = '44444444-4444-4444-9444-444444444444';
const SPACE_ID = '55555555-5555-4555-9555-555555555555';
const TRACE_ID = 'trace-op-task' as TraceId;
const INPUT_REF = `inline:${Buffer.from('{}').toString('base64')}`;
const TOKEN = `dispatch:${RUN_ID}:wait:2`;

const deps = { redis: {} as never, payloadStore: {} as never };

function baseArgs(operationId: string, snoozeDelayMs = 0) {
  return {
    tenantId: TENANT,
    runId: RUN_ID,
    taskId: 'wait',
    attempt: 2,
    dispatchAttemptToken: TOKEN,
    operationId,
    workerSessionId: WORKER_SESSION_ID,
    inputRef: INPUT_REF,
    traceId: TRACE_ID,
    spaceId: SPACE_ID,
    snoozeDelayMs,
    credentialOwnerId: 'user-1',
  };
}

beforeEach(() => {
  mockScheduleShardTimer.mockReset().mockResolvedValue(undefined);
  mockAddStepJob.mockReset().mockResolvedValue(undefined);
  mockDispatchInlineOp.mockReset().mockResolvedValue(undefined);
});

describe('resolveOperationTaskSnoozeDelayMs (pre-claim)', () => {
  it('returns 0 for non-snooze operations without touching the payload store', async () => {
    const retrieve = vi.fn();
    const delay = await resolveOperationTaskSnoozeDelayMs(
      { retrieve } as never,
      'api.http.call',
      INPUT_REF,
    );
    expect(delay).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('resolves the clamped delay from the task input for snooze', async () => {
    const retrieve = vi.fn(async () => ({ durationMs: 5_000 }));
    const delay = await resolveOperationTaskSnoozeDelayMs(
      { retrieve } as never,
      SNOOZE_OPERATION_ID,
      INPUT_REF,
    );
    expect(delay).toBe(5_000);
    expect(retrieve).toHaveBeenCalledWith(INPUT_REF);
  });

  it('clamps sub-minimum durations up to SNOOZE_MIN_MS', async () => {
    const retrieve = vi.fn(async () => ({ durationMs: 1 }));
    const delay = await resolveOperationTaskSnoozeDelayMs(
      { retrieve } as never,
      SNOOZE_OPERATION_ID,
      INPUT_REF,
    );
    expect(delay).toBe(SNOOZE_MIN_MS_DEFAULT);
  });

  it('throws (pre-claim) for durations over SNOOZE_MAX_MS, teaching resume_run schedules', async () => {
    const retrieve = vi.fn(async () => ({ durationMs: 24 * 60 * 60_000 }));
    await expect(
      resolveOperationTaskSnoozeDelayMs({ retrieve } as never, SNOOZE_OPERATION_ID, INPUT_REF),
    ).rejects.toThrow(/agent\.schedule\.create/);
  });
});

describe('operationTaskClaimDueAt', () => {
  it('extends the completion_pending window by the snooze delay', () => {
    const before = Date.now();
    const dueAt = operationTaskClaimDueAt(120_000).getTime();
    const after = Date.now();
    expect(dueAt).toBeGreaterThanOrEqual(before + 120_000 + DISPATCH_PENDING_INTERVAL_MS);
    expect(dueAt).toBeLessThanOrEqual(after + 120_000 + DISPATCH_PENDING_INTERVAL_MS);
  });

  it('is the plain supervision window for non-snooze (delay 0)', () => {
    const before = Date.now();
    const dueAt = operationTaskClaimDueAt(0).getTime();
    expect(dueAt).toBeGreaterThanOrEqual(before + DISPATCH_PENDING_INTERVAL_MS);
  });
});

describe('dispatchClaimedOperationTask', () => {
  it('snooze: schedules a workflow-correlated delayed_start timer — never inline, never enqueue', async () => {
    const before = Date.now();
    const mode = await dispatchClaimedOperationTask(deps, baseArgs(SNOOZE_OPERATION_ID, 5_000));
    const after = Date.now();

    expect(mode).toBe('snooze_timer');
    // The founding bug: the retry path ran the inline no-op IMMEDIATELY.
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
    expect(mockAddStepJob).not.toHaveBeenCalled();

    expect(mockScheduleShardTimer).toHaveBeenCalledTimes(1);
    const timer = mockScheduleShardTimer.mock.calls[0]![1] as Record<string, unknown>;
    expect(timer['workflowExecution']).toEqual({
      runId: RUN_ID,
      taskId: 'wait',
      attempt: 2,
      dispatchAttemptToken: TOKEN,
    });
    expect(timer['sessionId']).toBeUndefined();
    expect(timer['reason']).toBe('delayed_start');
    expect(timer['stepExecutionId']).toBe(WORKER_SESSION_ID);
    expect(timer['operationId']).toBe(SNOOZE_OPERATION_ID);
    expect(timer['stepType']).toBe('agent');
    expect(timer['inputRef']).toBe(INPUT_REF);
    expect(timer['credentialOwnerId']).toBe('user-1');
    expect(timer['spaceId']).toBe(SPACE_ID);
    // The wait IS the delay before dispatch.
    expect(timer['dueAtMs']).toBeGreaterThanOrEqual(before + 5_000);
    expect(timer['dueAtMs']).toBeLessThanOrEqual(after + 5_000);
  });

  it('safelisted inline op: runs in-process with the claim envelope and token as idempotency key', async () => {
    const mode = await dispatchClaimedOperationTask(deps, baseArgs('workflow.learn'));

    expect(mode).toBe('inline');
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();
    expect(mockAddStepJob).not.toHaveBeenCalled();

    expect(mockDispatchInlineOp).toHaveBeenCalledTimes(1);
    const call = mockDispatchInlineOp.mock.calls[0]!;
    // Positional contract of dispatchInlineOp(redis, payloadStore, context,
    // stepDef, stepExecutionId, idempotencyKey, inputRef, attempt, now,
    // parentStepExecutionId, workflowExecution).
    const context = call[2] as Record<string, unknown>;
    expect(context['tenantId']).toBe(TENANT);
    // Synthetic session: the claim's worker session id, NOT the workflow run id.
    expect(context['runId']).toBe(WORKER_SESSION_ID);
    const stepDef = call[3] as Record<string, unknown>;
    expect(stepDef['operation']).toBe('workflow.learn');
    expect(stepDef['stepId']).toBe('wait');
    expect(call[4]).toBe(WORKER_SESSION_ID);
    expect(call[5]).toBe(TOKEN);
    expect(call[6]).toBe(INPUT_REF);
    expect(call[7]).toBe(2);
    expect(call[9]).toBeUndefined();
    expect(call[10]).toEqual({
      runId: RUN_ID,
      taskId: 'wait',
      attempt: 2,
      dispatchAttemptToken: TOKEN,
    });
  });

  it('inline op NOT on the workflow-task safelist: throws without dispatching', async () => {
    await expect(
      dispatchClaimedOperationTask(deps, baseArgs('agent.manage.update')),
    ).rejects.toThrow(/not on the workflow-task safelist/);
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
    expect(mockAddStepJob).not.toHaveBeenCalled();
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();
  });

  it('executor op: enqueues the workflow step job (workflowExecution, no sessionId)', async () => {
    const mode = await dispatchClaimedOperationTask(deps, baseArgs('api.http.call'));

    expect(mode).toBe('enqueued');
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();

    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
    const job = mockAddStepJob.mock.calls[0]![1] as Record<string, unknown>;
    expect(job['workflowExecution']).toEqual({
      runId: RUN_ID,
      taskId: 'wait',
      attempt: 2,
      dispatchAttemptToken: TOKEN,
    });
    expect(job['sessionId']).toBeUndefined();
    expect(job['idempotencyKey']).toBe(TOKEN);
    expect(job['stepExecutionId']).toBe(WORKER_SESSION_ID);
    expect(job['operationId']).toBe('api.http.call');
    expect(job['stepType']).toBe('api');
    expect(job['credentialOwnerId']).toBe('user-1');
    expect(job['spaceId']).toBe(SPACE_ID);
  });

  /**
   * What an executor can key unrepeatable work on. The claim mints a worker
   * session per attempt, so the step execution id names the attempt; the run
   * and the task are the only handles both attempts at one task share.
   */
  it('gives a retried task a new step execution id under the same run and task', async () => {
    await dispatchClaimedOperationTask(deps, {
      ...baseArgs('ai.media.video'),
      attempt: 1,
      dispatchAttemptToken: `dispatch:${RUN_ID}:wait:1`,
    });
    await dispatchClaimedOperationTask(deps, {
      ...baseArgs('ai.media.video'),
      attempt: 2,
      workerSessionId: '66666666-6666-4666-9666-666666666666',
      dispatchAttemptToken: `dispatch-retry:${RUN_ID}:wait:2`,
    });

    const [first, second] = mockAddStepJob.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(first!['stepExecutionId']).not.toBe(second!['stepExecutionId']);
    const firstExecution = first!['workflowExecution'] as Record<string, unknown>;
    const secondExecution = second!['workflowExecution'] as Record<string, unknown>;
    expect(secondExecution['runId']).toBe(firstExecution['runId']);
    expect(secondExecution['taskId']).toBe(firstExecution['taskId']);
    // Per-attempt by construction, so it names the attempt and not the work.
    expect(secondExecution['dispatchAttemptToken']).not.toBe(
      firstExecution['dispatchAttemptToken'],
    );
  });

  it('omits credentialOwnerId when the claim context has none', async () => {
    const { credentialOwnerId: _drop, ...args } = baseArgs('api.http.call');
    await dispatchClaimedOperationTask(deps, args);
    const job = mockAddStepJob.mock.calls[0]![1] as Record<string, unknown>;
    expect('credentialOwnerId' in job).toBe(false);
  });
});
