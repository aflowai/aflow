/**
 * A surface generation that rendered nothing must fail — a SUCCEEDED step
 * with `presentation: rendered_inline` tells the agent the surface is on
 * screen and keeps the failure out of its tool-failure accounting.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorContext, FailureResult } from '@aflow/executor-runtime';
import type {
  PayloadRef,
  SurfaceGenerationEmptyDetails,
  UiSurfaceVisualizeOutput,
} from '@aflow/schemas';
import { SURFACE_GENERATION_EMPTY_ERROR_CODE, toAgentToolError } from '@aflow/schemas';

const modelOutput = vi.hoisted(() => ({ text: '', finishReason: 'stop' }));

vi.mock('../aiClient.js', () => ({
  ByokCredentialError: class ByokCredentialError extends Error {},
  resolveGenerationModel: async () => 'glm-pro',
  getAIClientForContext: async () => ({
    generateTextStream: () => ({
      stream: (async function* () {
        yield { delta: modelOutput.text };
      })(),
      response: Promise.resolve({
        finishReason: modelOutput.finishReason,
        model: 'glm-pro',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      }),
    }),
  }),
}));

const { SurfaceHandler } = await import('./surfaceHandler.js');

const CREATE =
  '{"type":"createSurface","surfaceId":"s1","messageId":"m1","catalogVersion":"v1",' +
  '"timestamp":"2026-03-13T10:00:00Z","components":[{"id":"page","component":"Page",' +
  '"props":{"title":"Sales"},"children":[]}],"rootIds":["page"]}';
const COMPLETE =
  '{"type":"completeSurface","surfaceId":"s1","messageId":"m2","catalogVersion":"v1",' +
  '"timestamp":"2026-03-13T10:00:00Z"}';
// The observed failure: the components array is never closed.
const UNCLOSED_CREATE =
  '{"type":"createSurface","surfaceId":"s1","messageId":"m1","catalogVersion":"v1",' +
  '"timestamp":"2026-03-13T10:00:00Z","components":[{"id":"page","component":"Page",' +
  '"props":{"title":"Sales"},"children":["a"]},"rootIds":["page"]}';

function makeCtx() {
  const writes: Array<{ kind: string; data: unknown }> = [];
  const runEvents: unknown[] = [];
  const ctx = {
    job: { inputRef: 'inline:input' as PayloadRef, sessionId: randomUUID() },
    tenantId: randomUUID(),
    runId: randomUUID(),
    stepExecutionId: randomUUID(),
    attempt: 1,
    operationId: 'ui.surface.visualize',
    readPayload: async () => ({ prompt: 'Chart sales', surfaceId: 's1' }),
    writePayload: async (kind: string, data: unknown) => {
      writes.push({ kind, data });
      return `inline:${kind}` as PayloadRef;
    },
    emitRunEvent: async (event: unknown) => {
      runEvents.push(event);
    },
    emitWorkflowProgress: async () => {},
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
  return { ctx, writes, runEvents };
}

describe('SurfaceHandler — ui.surface.visualize', () => {
  beforeEach(() => {
    modelOutput.finishReason = 'stop';
  });

  it('fails with the assembler diagnostics when no mutation was emitted', async () => {
    modelOutput.text = `${UNCLOSED_CREATE}\n`;
    const { ctx, writes, runEvents } = makeCtx();

    const result = await new SurfaceHandler().execute(ctx);

    expect(result.status).toBe('FAILED');
    const { error } = result as FailureResult;
    expect(error.code).toBe(SURFACE_GENERATION_EMPTY_ERROR_CODE);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('Surface s1 was not rendered');
    const details = error.details as SurfaceGenerationEmptyDetails;
    expect(details.surfaceId).toBe('s1');
    expect(details.mutationCount).toBe(0);
    expect(details.errorCount).toBeGreaterThanOrEqual(1);
    expect(details.errors).toHaveLength(details.errorCount);
    expect(error.message).toContain(details.errors[0]);
    // Nothing claims the surface rendered: no output, no streamed update.
    expect(writes.some((w) => w.kind === 'output')).toBe(false);
    expect(writes.find((w) => w.kind === 'error')?.data).toEqual(error);
    expect(runEvents).toHaveLength(0);
    // The agent sees the diagnostics, not an opaque system error.
    const agentError = toAgentToolError(error);
    expect(agentError.error).toBe('validation');
    expect(agentError.message).toContain('not rendered');
  });

  it('fails when the model emitted nothing at all', async () => {
    modelOutput.text = '';
    modelOutput.finishReason = 'length';
    const { ctx } = makeCtx();

    const result = await new SurfaceHandler().execute(ctx);

    expect(result.status).toBe('FAILED');
    const { error } = result as FailureResult;
    expect(error.code).toBe(SURFACE_GENERATION_EMPTY_ERROR_CODE);
    expect(error.details).toMatchObject({
      mutationCount: 0,
      errorCount: 0,
      finishReason: 'length',
    });
    expect(error.message).toContain('token limit');
  });

  it('fails when mutations arrived but the createSurface was rejected', async () => {
    // The validator rejects the create (an action with no eventName) yet still
    // lets the following completeSurface through — one mutation, nothing to paint.
    const rejectedCreate = CREATE.replace(
      '"children":[]',
      '"children":[],"actions":[{"eventName":"","eventType":"click"}]',
    );
    modelOutput.text = `${rejectedCreate}\n${COMPLETE}\n`;
    const { ctx } = makeCtx();

    const result = await new SurfaceHandler().execute(ctx);

    expect(result.status).toBe('FAILED');
    const { error } = result as FailureResult;
    expect(error.code).toBe(SURFACE_GENERATION_EMPTY_ERROR_CODE);
    expect(error.details).toMatchObject({ mutationCount: 1, errorCount: 1 });
    expect(error.message).toContain('mutation(s) without a createSurface were not rendered');
  });

  it('succeeds and presents inline when the surface was created', async () => {
    modelOutput.text = `${CREATE}\n${COMPLETE}\n`;
    const { ctx, writes, runEvents } = makeCtx();

    const result = await new SurfaceHandler().execute(ctx);

    expect(result.status).toBe('SUCCEEDED');
    const output = writes.find((w) => w.kind === 'output')?.data as UiSurfaceVisualizeOutput;
    expect(output.mutationCount).toBe(2);
    expect(output.presentation).toEqual({
      mode: 'rendered_inline',
      substrate: 'surface',
      surfaceId: 's1',
    });
    expect(runEvents.length).toBeGreaterThan(0);
  });
});
