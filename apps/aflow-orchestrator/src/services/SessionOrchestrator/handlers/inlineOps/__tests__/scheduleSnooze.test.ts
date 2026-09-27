import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IdempotencyKey,
  StepDefinition,
  StepExecutionId,
  WorkflowExecutionRef,
} from '@aflow/schemas';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  // Imported by helpers.ts / StepService but unused on the snooze path.
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  atomicCompleteStep: vi.fn(),
}));

import { SNOOZE_MIN_MS_DEFAULT, SNOOZE_OPERATION_ID } from '@aflow/schemas';
import { handleScheduleSnoozeInline } from '../scheduleSnooze.js';
import type { InlineHandlerArgs } from '../types.js';

const WFX: WorkflowExecutionRef = {
  runId: 'wf-run-1',
  taskId: 'wait',
  attempt: 2,
  dispatchAttemptToken: 'dispatch:wf-run-1:wait:2',
};

function makeArgs(input: unknown, workflowExecution?: WorkflowExecutionRef): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(async () => input),
      shouldStore: vi.fn(() => false),
      store: vi.fn(),
    } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'session-1',
      traceId: 'trace-snooze',
    } as never,
    stepDef: {
      stepId: 'wait',
      stepType: 'agent',
      operation: SNOOZE_OPERATION_ID,
    } as unknown as StepDefinition,
    stepExecutionId: 'exec-1' as StepExecutionId,
    idempotencyKey: 'dispatch:wf-run-1:wait:2' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 2,
    scheduledAtMs: 0,
    ...(workflowExecution ? { workflowExecution } : {}),
  };
}

function decodeInlineRef(ref: string): Record<string, unknown> {
  expect(ref.startsWith('inline:')).toBe(true);
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf-8')) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  mockAddStepResult.mockReset();
});

describe('handleScheduleSnoozeInline (Plan 194 §4.1)', () => {
  it('workflow-task dispatch: emits a workflowExecution-correlated SUCCEEDED with { requestedMs, waitedMs, resumedAt }', async () => {
    await handleScheduleSnoozeInline(makeArgs({ durationMs: 5_000 }, WFX));

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('SUCCEEDED');
    // Correlation: workflow task → workflowExecution, NOT sessionId.
    expect(msg['workflowExecution']).toEqual(WFX);
    expect(msg['sessionId']).toBeUndefined();
    expect(msg['operationId']).toBe(SNOOZE_OPERATION_ID);
    expect(msg['idempotencyKey']).toBe('dispatch:wf-run-1:wait:2');
    expect(msg['attempt']).toBe(2);

    const output = decodeInlineRef(msg['outputRef'] as string);
    expect(output['requestedMs']).toBe(5_000);
    expect(output['waitedMs']).toBe(5_000);
    expect(typeof output['resumedAt']).toBe('string');
    expect(Number.isNaN(Date.parse(output['resumedAt'] as string))).toBe(false);
  });

  it('reports the clamped wait when the request was below the platform minimum', async () => {
    await handleScheduleSnoozeInline(makeArgs({ durationMs: 1 }, WFX));

    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const output = decodeInlineRef(msg['outputRef'] as string);
    expect(output['requestedMs']).toBe(1);
    expect(output['waitedMs']).toBe(SNOOZE_MIN_MS_DEFAULT);
  });

  it('session dispatch: emits a sessionId-correlated SUCCEEDED', async () => {
    await handleScheduleSnoozeInline(makeArgs({ durationMs: 2_000 }));

    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('SUCCEEDED');
    expect(msg['sessionId']).toBe('session-1');
    expect(msg['workflowExecution']).toBeUndefined();
  });

  it('invalid input (over SNOOZE_MAX_MS) emits a validation FAILED teaching resume_run schedules', async () => {
    await handleScheduleSnoozeInline(makeArgs({ durationMs: 24 * 60 * 60_000 }, WFX));

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('FAILED');
    expect(msg['workflowExecution']).toEqual(WFX);
    const error = msg['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNOOZE_INVALID_INPUT');
    expect(error['classification']).toBe('validation');
    expect(error['message']).toMatch(/agent\.schedule\.create/);
  });
});
