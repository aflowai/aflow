import { describe, expect, it, vi } from 'vitest';
import type {
  IdempotencyKey,
  StepDefinition,
  StepExecutionId,
  WorkflowExecutionRef,
} from '@aflow/schemas';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  // Imported by helpers.ts but unused on the emitStepSuccess path.
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
}));

import { emitStepSuccess } from '../helpers.js';
import type { InlineHandlerArgs } from '../types.js';

const STORED_REF = 'gs://bucket/tenants/t/runs/r/steps/s/attempt/0/output.json';

function makeArgs(
  store: ReturnType<typeof vi.fn>,
  shouldStore: ReturnType<typeof vi.fn>,
  workflowExecution?: WorkflowExecutionRef,
): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      shouldStore,
      store,
      retrieve: vi.fn(),
    } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'session-1',
      traceId: 'trace-1',
    } as never,
    stepDef: {
      stepId: 'submit-output',
      stepType: 'agent',
      operation: 'agent.control.submit_output',
    } as unknown as StepDefinition,
    stepExecutionId: 'exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: 0,
    ...(workflowExecution ? { workflowExecution } : {}),
  };
}

describe('emitStepSuccess — Plan 186 §5.B', () => {
  it('offloads to PayloadStore when the output exceeds the inline budget', async () => {
    const store = vi.fn(async () => STORED_REF);
    const shouldStore = vi.fn(() => true);
    const args = makeArgs(store, shouldStore);

    const bigOutput = { fileContent: 'x'.repeat(100 * 1024) };
    await emitStepSuccess(args, bigOutput, Date.now());

    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0]![0]).toMatchObject({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'session-1',
      stepExecutionId: 'exec-1',
      attempt: 1,
      kind: 'output',
      data: bigOutput,
    });

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const msg = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      outputRef: string;
      sessionId?: string;
    };
    expect(msg.status).toBe('SUCCEEDED');
    expect(msg.outputRef).toBe(STORED_REF);
    expect(msg.outputRef.startsWith('inline:')).toBe(false);
    // Session-context inline op → correlated by sessionId, no workflowExecution.
    expect(msg.sessionId).toBe('session-1');
  });

  it('keeps small outputs inline (no offload)', async () => {
    mockAddStepResult.mockClear();
    const store = vi.fn(async () => STORED_REF);
    const shouldStore = vi.fn(() => false);
    const args = makeArgs(store, shouldStore);

    const smallOutput = { valid: true };
    await emitStepSuccess(args, smallOutput, Date.now());

    expect(store).not.toHaveBeenCalled();
    const msg = mockAddStepResult.mock.calls[0]![1] as { outputRef: string };
    expect(msg.outputRef.startsWith('inline:')).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(msg.outputRef.slice('inline:'.length), 'base64').toString('utf-8'),
    ) as Record<string, unknown>;
    expect(decoded).toEqual(smallOutput);
  });

  it('workflow-task dispatch: offloads and correlates by workflowExecution (no sessionId)', async () => {
    mockAddStepResult.mockClear();
    const store = vi.fn(async () => STORED_REF);
    const shouldStore = vi.fn(() => true);
    const workflowExecution: WorkflowExecutionRef = {
      runId: 'wf-run-1',
      taskId: 'task-1',
      attempt: 1,
      dispatchAttemptToken: 'dispatch:wf-run-1:task-1:1',
    };
    const args = makeArgs(store, shouldStore, workflowExecution);

    await emitStepSuccess(args, { fileContent: 'y'.repeat(100 * 1024) }, Date.now());

    expect(store).toHaveBeenCalledTimes(1);
    const msg = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      outputRef: string;
      sessionId?: string;
      workflowExecution?: WorkflowExecutionRef;
    };
    expect(msg.status).toBe('SUCCEEDED');
    expect(msg.outputRef).toBe(STORED_REF);
    // Inline workflow task → correlated by workflowExecution, NOT sessionId.
    expect(msg.workflowExecution).toEqual(workflowExecution);
    expect(msg.sessionId).toBeUndefined();
  });
});
