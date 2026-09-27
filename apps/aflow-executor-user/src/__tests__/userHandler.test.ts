import { describe, it, expect, vi } from 'vitest';
import type { ExecutorContext, StepResult, PausedResult } from '@aflow/executor-runtime';
import type { OperationId, PayloadRef, StepExecutionId } from '@aflow/schemas';
import { UserHandler } from '../handlers/userInputHandler.js';

interface CapturedWrite {
  kind: 'output' | 'error' | 'input_request' | 'body';
  data: unknown;
}

function makeCtx(opts: {
  operationId: OperationId;
  input: Record<string, unknown>;
  capture: CapturedWrite[];
}): ExecutorContext {
  return {
    operationId: opts.operationId,
    stepExecutionId: 'step-exec-1' as StepExecutionId,
    tenantId: 't-1' as never,
    runId: 'run-1' as never,
    traceId: 'trace-1',
    idempotencyKey: 'idem-1',
    attempt: 1,
    job: { inputRef: 'inline:e30=' } as never,
    readPayload: vi.fn(async () => opts.input as never),
    writePayload: vi.fn(async (kind, data) => {
      opts.capture.push({ kind, data });
      return 'inline:written' as PayloadRef;
    }),
    outputExists: vi.fn(async () => null),
    resolveInput: vi.fn(),
    streamProgress: vi.fn(),
  } as unknown as ExecutorContext;
}

function makeHandler(): UserHandler {
  return new UserHandler({ redis: {} as never });
}

function assertPaused(result: StepResult): PausedResult {
  expect(result.status).toBe('PAUSED');
  return result as PausedResult;
}

describe('UserHandler — user.interaction.ask pause payload (Plan 156)', () => {
  it('persists kind="input", prompt, and stepExecutionId', async () => {
    const capture: CapturedWrite[] = [];
    const ctx = makeCtx({
      operationId: 'user.interaction.ask' as OperationId,
      input: { prompt: 'What city?' },
      capture,
    });
    const result = await new UserHandler({ redis: {} as never }).execute(ctx);
    assertPaused(result);
    expect(capture).toHaveLength(1);
    const payload = capture[0]!.data as Record<string, unknown>;
    expect(payload['kind']).toBe('input');
    expect(payload['prompt']).toBe('What city?');
    expect(payload['stepExecutionId']).toBe('step-exec-1');
    expect(typeof payload['requestedAt']).toBe('string');
  });

  it('threads inputSchema, uiHints, timeoutSeconds, gateContext, relatesTo through', async () => {
    const capture: CapturedWrite[] = [];
    const ctx = makeCtx({
      operationId: 'user.interaction.ask' as OperationId,
      input: {
        prompt: 'Pick one',
        inputSchema: { type: 'string', enum: ['a', 'b'] },
        uiHints: { mode: 'choices', submitLabel: 'Use this' },
        timeoutSeconds: 600,
        defaultOnTimeout: 'a',
        gateContext: {
          operationId: 'memory.store.delete',
          reason: 'op_always_requires_approval',
          callInputRef: 'inline:e30=',
          gateRequestId: 'gate-1',
        },
        relatesTo: [{ kind: 'step', id: 'parent-1' }],
      },
      capture,
    });
    await makeHandler().execute(ctx);
    const payload = capture[0]!.data as Record<string, unknown>;
    expect(payload['inputSchema']).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(payload['uiHints']).toEqual({ mode: 'choices', submitLabel: 'Use this' });
    expect(payload['timeoutSeconds']).toBe(600);
    expect(payload['defaultOnTimeout']).toBe('a');
    expect((payload['gateContext'] as Record<string, unknown>)['gateRequestId']).toBe('gate-1');
    expect(Array.isArray(payload['relatesTo'])).toBe(true);
  });
});

describe('UserHandler — user.interaction.approve pause payload (Plan 156)', () => {
  it('persists kind="approval", title, description, and a synthesized prompt', async () => {
    const capture: CapturedWrite[] = [];
    const ctx = makeCtx({
      operationId: 'user.interaction.approve' as OperationId,
      input: {
        title: 'Delete 432 rows',
        description: 'Permanently removes rows where …',
        reviewData: { affectedRows: 432 },
        policy: { minApprovals: 1, requireAll: false },
      },
      capture,
    });
    const result = await makeHandler().execute(ctx);
    assertPaused(result);
    const payload = capture[0]!.data as Record<string, unknown>;
    expect(payload['kind']).toBe('approval');
    expect(payload['title']).toBe('Delete 432 rows');
    expect(payload['description']).toBe('Permanently removes rows where …');
    // Synthesized prompt — keeps StepService.waitForInput, the run-view
    // reducer, and other `event.metadata.prompt` consumers rendering the
    // approval text without per-consumer fallback logic.
    expect(payload['prompt']).toBe('Delete 432 rows\n\nPermanently removes rows where …');
    expect((payload['reviewData'] as Record<string, unknown>)['affectedRows']).toBe(432);
    expect((payload['policy'] as Record<string, unknown>)['minApprovals']).toBe(1);
    // Legacy fields the old handler used don't leak through.
    expect(payload['contextData']).toBeUndefined();
    expect(payload['timeoutMs']).toBeUndefined();
  });

  it('threads gateContext (synthetic gate steps) through to the pause payload', async () => {
    const capture: CapturedWrite[] = [];
    const ctx = makeCtx({
      operationId: 'user.interaction.approve' as OperationId,
      input: {
        title: 'Approve MCP call',
        description: 'mcp_stripe.charges.create requires approval',
        gateContext: {
          operationId: 'mcp.tool.call',
          reason: 'binding_requires_approval',
          bindingId: 'stripe-default',
          callInputRef: 'inline:e30=',
          gateRequestId: 'gate-xyz',
        },
      },
      capture,
    });
    await makeHandler().execute(ctx);
    const payload = capture[0]!.data as Record<string, unknown>;
    const gate = payload['gateContext'] as Record<string, unknown>;
    expect(gate['bindingId']).toBe('stripe-default');
    expect(gate['reason']).toBe('binding_requires_approval');
  });

  it('writes a `prompt` field every downstream consumer can read uniformly', async () => {
    const capture: CapturedWrite[] = [];
    const ctx = makeCtx({
      operationId: 'user.interaction.approve' as OperationId,
      input: {
        title: 'Delete records',
        description: 'About to permanently delete 50 rows.',
      },
      capture,
    });
    await makeHandler().execute(ctx);
    const payload = capture[0]!.data as Record<string, unknown>;
    expect(payload['prompt']).toBe('Delete records\n\nAbout to permanently delete 50 rows.');
  });
});
