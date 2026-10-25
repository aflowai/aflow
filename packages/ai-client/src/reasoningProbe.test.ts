import { describe, expect, it } from 'vitest';
import { ReasoningDriftReportSchema, ReasoningProbeResultSchema } from '@aflow/schemas';
import { createDefaultModelCatalog } from './catalog.js';
import { AIClientError } from './errors.js';
import {
  buildReasoningDriftReport,
  probeReasoningLadder,
  reasoningProbeLackedCredentials,
  reasoningProbeUsage,
  resolveReasoningProbeTarget,
  type ReasoningProbeAdapter,
  type ReasoningProbeOptions,
} from './reasoningProbe.js';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ModelDefinition,
  ReasoningEffort,
  TextStreamChunk,
} from './types.js';

type RungBehaviour = 'accept' | 'truncate' | Error;

const attribution = {
  tenantId: 'tenant-probe',
  runId: 'run-probe',
  stepExecutionId: 'step-probe',
} as ReasoningProbeOptions['attribution'];

const MODEL: ModelDefinition = {
  id: 'probe-test-model',
  provider: 'google',
  providerModelId: 'probe-test-model-001',
  displayName: 'Probe Test Model',
  contextWindow: 1000,
  maxOutputTokens: 1000,
  capabilities: {
    chat: true,
    completion: false,
    embedding: false,
    vision: false,
    audio: false,
    functionCalling: true,
    jsonMode: true,
    streaming: true,
    reasoning: true,
  },
  pricing: { promptPer1M: 1, completionPer1M: 1, currency: 'USD' },
  reasoning: { supported: ['low', 'medium', 'high'], default: 'medium' },
};

function fakeProvider(behaviour: Record<ReasoningEffort, RungBehaviour>) {
  const requests: GenerateTextRequest[] = [];
  const adapter: ReasoningProbeAdapter = {
    generateTextStream(request) {
      requests.push(request);
      const effort = request.reasoning?.effort ?? 'medium';
      const outcome = behaviour[effort];
      const response: Promise<GenerateTextResponse> =
        outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve({
              content: null,
              toolCalls: [],
              finishReason: outcome === 'truncate' ? 'length' : 'tool_calls',
              usage: {
                promptTokens: 20,
                completionTokens: 30,
                totalTokens: 50,
                reasoningTokens: 10,
              },
              model: request.model,
              provider: 'google',
            });
      async function* stream(): AsyncGenerator<TextStreamChunk> {
        if (outcome instanceof Error) throw outcome;
        yield* [];
      }
      return { stream: stream(), response };
    },
  };
  return { adapter, requests };
}

const badRequest = (message: string) =>
  new AIClientError(message, 'invalid_request', 'google', false, {
    providerErrorCode: 'INVALID_ARGUMENT',
  });

describe('probeReasoningLadder', () => {
  it('sends one minimal request per rung straight to the provider, unclamped', async () => {
    const { adapter, requests } = fakeProvider({
      off: 'accept',
      low: 'accept',
      medium: 'accept',
      high: 'accept',
    });
    await probeReasoningLadder({
      model: MODEL,
      getAdapter: () => Promise.resolve(adapter),
      attribution,
    });

    expect(requests.map((r) => r.reasoning?.effort)).toEqual(['off', 'low', 'medium', 'high']);
    for (const request of requests) {
      expect(request.model).toBe('probe-test-model-001');
      expect(request.maxTokens).toBe(1024);
      expect(request.maxRetries).toBe(0);
      expect(request.messages).toHaveLength(1);
      expect(request.tools).toHaveLength(1);
    }
  });

  it('records an accepted rung with its usage and a rejected rung with the provider’s words', async () => {
    const { adapter } = fakeProvider({
      off: badRequest('Thinking level MINIMAL is not supported for this model.'),
      low: 'accept',
      medium: 'accept',
      high: 'truncate',
    });
    const result = await probeReasoningLadder({
      model: MODEL,
      getAdapter: () => Promise.resolve(adapter),
      attribution,
      now: () => new Date('2026-10-25T12:00:00Z'),
    });

    expect(ReasoningProbeResultSchema.parse(result)).toEqual(result);
    expect(result.accepted).toEqual(['low', 'medium', 'high']);
    expect(result.rejected).toEqual(['off']);
    expect(result.rungs[0]).toMatchObject({
      effort: 'off',
      outcome: 'rejected',
      error: {
        code: 'invalid_request',
        providerErrorCode: 'INVALID_ARGUMENT',
        message: 'Thinking level MINIMAL is not supported for this model.',
      },
    });
    expect(result.rungs[1]).toMatchObject({
      outcome: 'accepted',
      finishReason: 'tool_calls',
      usage: { totalTokens: 50, reasoningTokens: 10 },
    });
    expect(result.rungs[3]).toMatchObject({ outcome: 'accepted', truncated: true });
    expect(result.drift.verdict).toBe('match');
    expect(reasoningProbeUsage(result)).toMatchObject({ totalTokens: 150, reasoningTokens: 30 });
  });

  it('counts a rung that ran out of output budget as accepted', async () => {
    const truncated = new AIClientError('max tokens', 'output_truncated', 'google', false);
    const { adapter } = fakeProvider({
      off: badRequest('no'),
      low: 'accept',
      medium: 'accept',
      high: truncated,
    });
    const result = await probeReasoningLadder({
      model: MODEL,
      getAdapter: () => Promise.resolve(adapter),
      attribution,
    });
    expect(result.rungs[3]).toMatchObject({ outcome: 'accepted', truncated: true });
    expect(result.drift.verdict).toBe('match');
  });

  it('treats a provider error that says nothing about the rung as inconclusive, never as a rejection', async () => {
    const { adapter } = fakeProvider({
      off: badRequest('no'),
      low: 'accept',
      medium: new AIClientError('Resource exhausted', 'rate_limit', 'google', true),
      high: new AIClientError('upstream 503', 'provider_error', 'google', true),
    });
    const result = await probeReasoningLadder({
      model: MODEL,
      getAdapter: () => Promise.resolve(adapter),
      attribution,
    });

    expect(result.rejected).toEqual(['off']);
    expect(result.rungs[2]).toMatchObject({ outcome: 'inconclusive', reason: 'transient' });
    expect(result.rungs[3]).toMatchObject({ outcome: 'inconclusive', reason: 'transient' });
    expect(result.drift.verdict).toBe('inconclusive');
    expect(result.drift.inconclusive).toEqual(['medium', 'high']);
    expect(result.drift.suggestedProfile).toBeUndefined();
  });

  it('reads a provider with no usable key as a credential failure on every rung', async () => {
    const result = await probeReasoningLadder({
      model: MODEL,
      getAdapter: () => Promise.reject(new Error('Provider google is not configured')),
      attribution,
    });
    expect(
      result.rungs.every((r) => r.outcome === 'inconclusive' && r.reason === 'credential'),
    ).toBe(true);
    expect(reasoningProbeLackedCredentials(result)).toBe(true);
  });

  it('reports drift in both directions, with the profile to write', async () => {
    const { adapter } = fakeProvider({
      off: 'accept',
      low: 'accept',
      medium: badRequest('effort medium unsupported'),
      high: 'accept',
    });
    const result = await probeReasoningLadder({
      model: MODEL,
      getAdapter: () => Promise.resolve(adapter),
      attribution,
    });

    expect(result.drift).toMatchObject({
      verdict: 'drift',
      declared: { supported: ['low', 'medium', 'high'], default: 'medium' },
      measured: ['off', 'low', 'high'],
      withheld: ['off'],
      rejectedButDeclared: ['medium'],
      defaultRejected: true,
      inconclusive: [],
      suggestedProfile: { supported: ['off', 'low', 'high'] },
    });
    expect(result.drift.suggestedProfile?.default).toBeUndefined();
    expect(result.drift.summary).toMatch(/withholds/);
    expect(result.drift.summary).toMatch(/choose a default/);
  });
});

describe('buildReasoningDriftReport', () => {
  const request = {
    providerModelId: 'm',
    maxTokens: 1024,
    toolChoice: 'auto' as const,
    tools: ['record_answer'],
  };

  it('compares sets by membership, not order, and has a stable shape', () => {
    const report = buildReasoningDriftReport({ supported: ['high', 'low'] }, [
      {
        effort: 'off',
        outcome: 'rejected',
        request: { ...request, effort: 'off' },
        error: { code: 'invalid_request', message: 'x', retryable: false },
      },
      {
        effort: 'low',
        outcome: 'accepted',
        request: { ...request, effort: 'low' },
        finishReason: 'stop',
      },
      {
        effort: 'medium',
        outcome: 'rejected',
        request: { ...request, effort: 'medium' },
        error: { code: 'invalid_request', message: 'x', retryable: false },
      },
      {
        effort: 'high',
        outcome: 'accepted',
        request: { ...request, effort: 'high' },
        finishReason: 'stop',
      },
    ]);
    expect(ReasoningDriftReportSchema.parse(report)).toEqual(report);
    expect(Object.keys(report).sort()).toEqual(
      [
        'declared',
        'defaultRejected',
        'inconclusive',
        'measured',
        'rejectedButDeclared',
        'summary',
        'verdict',
        'withheld',
      ].sort(),
    );
    expect(report.verdict).toBe('match');
  });

  it('calls a ladder the provider wholly rejects drift without suggesting an empty profile', () => {
    const rejected = (effort: ReasoningEffort) => ({
      effort,
      outcome: 'rejected' as const,
      request: { ...request, effort },
      error: { code: 'invalid_request', message: 'x', retryable: false },
    });
    const report = buildReasoningDriftReport({ supported: ['low'] }, [
      rejected('off'),
      rejected('low'),
      rejected('medium'),
      rejected('high'),
    ]);
    expect(report.verdict).toBe('drift');
    expect(report.suggestedProfile).toBeUndefined();
    expect(report.summary).toMatch(/accepted no rung/);
  });
});

describe('resolveReasoningProbeTarget', () => {
  const catalog = createDefaultModelCatalog();

  it('refuses a model the catalog does not carry, teaching how a catalog id is spelled', () => {
    const target = resolveReasoningProbeTarget('gemini-4-argon', catalog);
    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.reason).toBe('unknown_model');
    expect(target.message).toMatch(/No model "gemini-4-argon" in the model catalog/);
    expect(target.message).toMatch(/catalogModels\.ts/);
    expect(target.message).toMatch(/"vendor\/model"/);
    expect(target.message).toMatch(/Closest catalog ids: .*gemini-/);
    expect(target.message).toMatch(/Reasoning models the probe can measure: /);
  });

  it('refuses a catalog model with no reasoning ladder', () => {
    const embedding = catalog.listModels().find((m) => m.capabilities.embedding);
    expect(embedding).toBeDefined();
    const target = resolveReasoningProbeTarget(embedding!.id, catalog);
    expect(target).toMatchObject({ ok: false, reason: 'not_reasoning' });
  });

  it('resolves an alias to its catalog model', () => {
    const withAlias = catalog
      .listModels()
      .find((m) => m.capabilities.reasoning === true && m.capabilities.chat && m.aliases?.length);
    expect(withAlias).toBeDefined();
    const target = resolveReasoningProbeTarget(withAlias!.aliases![0]!, catalog);
    expect(target).toMatchObject({ ok: true, model: { id: withAlias!.id } });
  });
});
