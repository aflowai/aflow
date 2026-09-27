import { beforeEach, describe, it, expect, vi } from 'vitest';

const mockAddStepJob = vi.fn();
const mockDispatchInlineOp = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepJob: (...args: unknown[]) => mockAddStepJob(...args),
}));

vi.mock('../../handlers/dispatchInlineOp.js', () => ({
  dispatchInlineOp: (...args: unknown[]) => mockDispatchInlineOp(...args),
}));

import {
  SNOOZE_OPERATION_ID,
  StepJobMessageSchema,
  TimerItemSchema,
  type TimerItem,
  type WorkflowExecutionRef,
} from '@aflow/schemas';
import { buildWorkflowTimerStepJob } from '../workflowTimerJob.js';
import { processWorkflowCorrelatedTimer } from '../workflowTimerDispatch.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const RUN_ID = '22222222-2222-4222-9222-222222222222';
const STEP_EXEC_ID = '44444444-4444-4444-9444-444444444444';
const SPACE_ID = '55555555-5555-4555-9555-555555555555';

const TOKEN = `dispatch:${RUN_ID}:fetch-data:3`;

const redis = {} as never;
const payloadStore = {} as never;

function poppedWorkflowTimer(overrides: Record<string, unknown> = {}): TimerItem {
  return TimerItemSchema.parse({
    tenantId: TENANT,
    workflowExecution: {
      runId: RUN_ID,
      taskId: 'fetch-data',
      attempt: 3,
      dispatchAttemptToken: TOKEN,
    },
    stepExecutionId: STEP_EXEC_ID,
    stepId: 'fetch-data',
    operationId: 'api.http.call',
    stepType: 'api',
    reason: 'delayed_start',
    attempt: 3,
    inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
    traceId: 'trace-wf',
    dueAtMs: Date.now(),
    spaceId: SPACE_ID,
    credentialOwnerId: 'user-1',
    ...overrides,
  });
}

describe('buildWorkflowTimerStepJob (Plan 194 §4.1)', () => {
  it('mirrors the dispatchTask addStepJob shape: workflowExecution, no sessionId', () => {
    const timer = poppedWorkflowTimer();
    const wfx = timer.workflowExecution as WorkflowExecutionRef;
    const nowMs = Date.now();

    const job = buildWorkflowTimerStepJob(timer, wfx, nowMs);

    // Schema invariant: exactly one of sessionId / workflowExecution.
    const parsed = StepJobMessageSchema.parse(job);
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.workflowExecution).toEqual(wfx);

    expect(parsed.stepExecutionId).toBe(STEP_EXEC_ID);
    expect(parsed.stepId).toBe('fetch-data');
    expect(parsed.stepType).toBe('api');
    expect(parsed.operationId).toBe('api.http.call');
    expect(parsed.attempt).toBe(3);
    // Idempotency key is the claim's per-attempt token — re-dispatch after
    // the delay must not mint a new attempt identity.
    expect(parsed.idempotencyKey).toBe(TOKEN);
    expect(parsed.scheduledAtMs).toBe(nowMs);
    // BYOK context carried on the timer (no session hot state to read at pop).
    expect(parsed.credentialOwnerId).toBe('user-1');
    expect(parsed.spaceId).toBe(SPACE_ID);
  });

  it('omits credentialOwnerId / spaceId when the timer does not carry them', () => {
    const timer = TimerItemSchema.parse({
      tenantId: TENANT,
      workflowExecution: {
        runId: RUN_ID,
        taskId: 'fetch-data',
        attempt: 1,
        dispatchAttemptToken: `dispatch:${RUN_ID}:fetch-data:1`,
      },
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'fetch-data',
      operationId: 'api.http.call',
      stepType: 'api',
      reason: 'delayed_start',
      attempt: 1,
      inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      traceId: 'trace-wf',
      dueAtMs: Date.now(),
    });
    const job = buildWorkflowTimerStepJob(
      timer,
      timer.workflowExecution as WorkflowExecutionRef,
      Date.now(),
    );
    expect('credentialOwnerId' in job).toBe(false);
    expect('spaceId' in job).toBe(false);
    expect(StepJobMessageSchema.parse(job).workflowExecution?.runId).toBe(RUN_ID);
  });
});

// ─── processWorkflowCorrelatedTimer (the actual pop path) ───────────────────

const SNOOZE_TOKEN = `dispatch:${RUN_ID}:wait:2`;

function poppedSnoozeTimer(): TimerItem {
  return TimerItemSchema.parse({
    tenantId: TENANT,
    workflowExecution: {
      runId: RUN_ID,
      taskId: 'wait',
      attempt: 2,
      dispatchAttemptToken: SNOOZE_TOKEN,
    },
    stepExecutionId: STEP_EXEC_ID,
    stepId: 'wait',
    operationId: SNOOZE_OPERATION_ID,
    stepType: 'agent',
    reason: 'delayed_start',
    attempt: 2,
    inputRef: `inline:${Buffer.from(JSON.stringify({ durationMs: 5000 })).toString('base64')}`,
    traceId: 'trace-snooze',
    dueAtMs: Date.now(),
    spaceId: SPACE_ID,
  });
}

describe('processWorkflowCorrelatedTimer (Plan 194 §4.1)', () => {
  beforeEach(() => {
    mockAddStepJob.mockReset().mockResolvedValue(undefined);
    mockDispatchInlineOp.mockReset().mockResolvedValue(undefined);
  });

  it('snooze (inline) pops into dispatchInlineOp with the claim envelope — never addStepJob', async () => {
    const timer = poppedSnoozeTimer();
    const wfx = timer.workflowExecution as WorkflowExecutionRef;

    await processWorkflowCorrelatedTimer(redis, payloadStore, timer, wfx);

    // Snooze's stepType 'agent' has no executor — re-enqueueing would strand it.
    expect(mockAddStepJob).not.toHaveBeenCalled();
    expect(mockDispatchInlineOp).toHaveBeenCalledTimes(1);

    // Positional contract of dispatchInlineOp(redis, payloadStore, context,
    // stepDef, stepExecutionId, idempotencyKey, resolvedInputRef, attempt,
    // now, parentStepExecutionId, workflowExecution).
    const call = mockDispatchInlineOp.mock.calls[0]!;
    const context = call[2] as Record<string, unknown>;
    expect(context['tenantId']).toBe(TENANT);
    // Synthetic session id = the claim's worker session id (stepExecutionId),
    // NOT the workflow run id.
    expect(context['runId']).toBe(STEP_EXEC_ID);
    expect(context['spaceId']).toBe(SPACE_ID);
    const stepDef = call[3] as Record<string, unknown>;
    expect(stepDef['operation']).toBe(SNOOZE_OPERATION_ID);
    expect(stepDef['stepId']).toBe('wait');
    expect(call[4]).toBe(STEP_EXEC_ID);
    // Idempotency key is the claim's per-attempt token, so the emitted
    // result matches the row claimed before the wait.
    expect(call[5]).toBe(SNOOZE_TOKEN);
    expect(call[6]).toBe(timer.inputRef);
    expect(call[7]).toBe(2);
    expect(call[9]).toBeUndefined();
    expect(call[10]).toEqual(wfx);
  });

  it('non-inline op pops into addStepJob with the workflow envelope — never dispatchInlineOp', async () => {
    const timer = poppedWorkflowTimer();
    const wfx = timer.workflowExecution as WorkflowExecutionRef;

    await processWorkflowCorrelatedTimer(redis, payloadStore, timer, wfx);

    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
    expect(mockAddStepJob).toHaveBeenCalledTimes(1);
    const job = StepJobMessageSchema.parse(mockAddStepJob.mock.calls[0]![1]);
    expect(job.workflowExecution).toEqual(wfx);
    expect(job.sessionId).toBeUndefined();
    expect(job.idempotencyKey).toBe(TOKEN);
    expect(job.stepExecutionId).toBe(STEP_EXEC_ID);
  });

  it('swallows re-dispatch failures (completion_pending sweeper is the safety net)', async () => {
    mockDispatchInlineOp.mockRejectedValueOnce(new Error('redis down'));
    const snooze = poppedSnoozeTimer();
    await expect(
      processWorkflowCorrelatedTimer(
        redis,
        payloadStore,
        snooze,
        snooze.workflowExecution as WorkflowExecutionRef,
      ),
    ).resolves.toBeUndefined();

    mockAddStepJob.mockRejectedValueOnce(new Error('stream gone'));
    const job = poppedWorkflowTimer();
    await expect(
      processWorkflowCorrelatedTimer(
        redis,
        payloadStore,
        job,
        job.workflowExecution as WorkflowExecutionRef,
      ),
    ).resolves.toBeUndefined();
  });
});
