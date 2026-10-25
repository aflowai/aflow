/**
 * ai.model.probe_reasoning as a step: the model is resolved from the catalog
 * before any credential is, the probe runs on the client the space's stored
 * credential built, and a probe that measured nothing fails rather than
 * reading as a measurement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { AIClientError, createDefaultModelCatalog, type AIProviderAdapter } from '@aflow/ai-client';
import { ReasoningProbeResultSchema, type AflowError, type TenantId } from '@aflow/schemas';
import { getAIClientForContext } from '../aiClient.js';
import { handleProbeReasoning } from './probeReasoning.js';
import type { HandlerDeps } from './types.js';

vi.mock('../aiClient.js', () => ({ getAIClientForContext: vi.fn() }));

const catalog = createDefaultModelCatalog();
const reasoningModel = catalog
  .listModels()
  .find((m) => m.capabilities.chat && m.capabilities.reasoning === true && !m.deprecated)!;

function fakeCtx() {
  const written: Array<{ kind: string; data: unknown }> = [];
  const ctx = {
    job: {
      tenantId: 'tenant-p',
      stepExecutionId: 'step-p',
      attempt: 1,
      credentialOwnerId: 'user-p',
      spaceId: 'space-p',
    },
    tenantId: 'tenant-p' as TenantId,
    runId: 'run-p',
    log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    writePayload: vi.fn((kind: string, data: unknown) => {
      written.push({ kind, data });
      return Promise.resolve(`inline:${kind}`);
    }),
  } as unknown as ExecutorContext;
  return { ctx, written };
}

const handleError = vi.fn((_ctx: ExecutorContext, label: string, error: unknown) =>
  Promise.resolve({ status: 'FAILED', label, error } as never),
);
const deps = {
  payloadStore: {} as HandlerDeps['payloadStore'],
  handleError,
  validateToolArgs: () => null,
} satisfies HandlerDeps;

function adapterAnswering(fail: (effort: string) => Error | null): AIProviderAdapter {
  return {
    generateTextStream(request) {
      const error = fail(request.reasoning?.effort ?? '');
      async function* stream() {
        if (error) throw error;
        yield* [];
      }
      return {
        stream: stream(),
        response: error
          ? Promise.reject(error)
          : Promise.resolve({
              content: null,
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
              model: request.model,
              provider: reasoningModel.provider,
            }),
      };
    },
  } as AIProviderAdapter;
}

function clientWith(adapter: AIProviderAdapter) {
  return {
    getAdapter: vi.fn(() => Promise.resolve(adapter)),
    modelCatalog: catalog,
  } as never;
}

describe('ai.model.probe_reasoning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a model id the catalog does not carry, before resolving any credential', async () => {
    const { ctx } = fakeCtx();
    const result = (await handleProbeReasoning(ctx, { model: 'gemini-4-argon' }, deps)) as {
      status: string;
      error: AflowError;
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.classification).toBe('validation');
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toMatch(/No model "gemini-4-argon" in the model catalog/);
    expect(result.error.message).toMatch(/Reasoning models the probe can measure/);
    expect(getAIClientForContext).not.toHaveBeenCalled();
  });

  it('measures with the client built from the space’s stored credential and reports the spend', async () => {
    const adapter = adapterAnswering((effort) =>
      effort === 'off'
        ? new AIClientError('off unsupported', 'invalid_request', 'google', false)
        : null,
    );
    const client = clientWith(adapter);
    vi.mocked(getAIClientForContext).mockResolvedValue(client);
    const { ctx, written } = fakeCtx();

    const result = (await handleProbeReasoning(ctx, { model: reasoningModel.id }, deps)) as {
      status: string;
      costJson?: Record<string, unknown>;
    };

    expect(result.status).toBe('SUCCEEDED');
    expect(getAIClientForContext).toHaveBeenCalledWith(ctx, reasoningModel.id);
    const output = ReasoningProbeResultSchema.parse(written.find((w) => w.kind === 'output')?.data);
    expect(output.modelId).toBe(reasoningModel.id);
    expect(output.rejected).toEqual(['off']);
    expect(output.accepted).toEqual(['low', 'medium', 'high']);
    expect(['match', 'drift']).toContain(output.drift.verdict);
    expect(result.costJson).toMatchObject({ model: reasoningModel.id, totalTokens: 90 });
  });

  it('fails, naming the credential, when the provider refused it on every rung', async () => {
    const refused = new AIClientError('API key not valid', 'auth', 'google', false);
    vi.mocked(getAIClientForContext).mockResolvedValue(clientWith(adapterAnswering(() => refused)));
    const { ctx } = fakeCtx();

    const result = (await handleProbeReasoning(ctx, { model: reasoningModel.id }, deps)) as {
      status: string;
      error: AflowError;
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('REASONING_PROBE_NOTHING_MEASURED');
    expect(result.error.classification).toBe('configuration');
    expect(result.error.message).toMatch(/Settings → Credentials/);
  });

  it('hands a missing stored credential to the shared error path', async () => {
    const missing = new Error('No credential for google in this space');
    vi.mocked(getAIClientForContext).mockRejectedValue(missing);
    const { ctx } = fakeCtx();

    await handleProbeReasoning(ctx, { model: reasoningModel.id }, deps);
    expect(handleError).toHaveBeenCalledWith(ctx, 'Reasoning ladder probe failed', missing);
  });
});
