/**
 * Rung 3's executor half: the model it is allowed to reach, the ceiling it
 * stops at, and the spend it declares.
 *
 * Each of these fails silently if it drifts. A ceiling that downgraded to the
 * contract example would keep answering plausibly while the scenario stopped
 * being rehearsed; a cancelled step that still dialled would burn a provider
 * call nothing can use; and unaccounted spend is exactly the free-mock illusion
 * that produces a real invoice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulationGenerationUnavailableError } from '@aflow/integration-simulator';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { GenerationAsk } from '@aflow/integration-simulator';
import { StepUsageBreakdownSchema } from '@aflow/schemas';
import { ApiExecutionError } from '../types.js';

const provider = vi.hoisted(() => ({
  resolvable: new Set<string>(['anthropic-sonnet']),
  calls: [] as Array<Record<string, unknown>>,
  answer: { status: 200, body: { ok: true }, mutations: [] } as unknown,
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } as Record<string, number>,
  cost: { promptCost: 0.001, completionCost: 0.002, totalCost: 0.003, currency: 'USD' },
}));

vi.mock('@aflow/credential-resolver', () => ({
  ByokCredentialError: class ByokCredentialError extends Error {},
  createByokAiClientFactory: () => ({
    canResolveModel: (model: string) => Promise.resolve(provider.resolvable.has(model)),
    getClientForModel: (model: string) =>
      Promise.resolve({
        providerId: 'anthropic',
        client: {
          generateJson: (request: Record<string, unknown>) => {
            provider.calls.push(request);
            return Promise.resolve({
              data: provider.answer,
              rawContent: JSON.stringify(provider.answer),
              usage: provider.usage,
              cost: provider.cost,
              model,
              provider: 'anthropic',
              finishReason: 'stop',
            });
          },
        },
      }),
  }),
}));

const { createGenerateSimulatedAnswer } = await import('./generateAnswer.js');

const db = {} as PostgresJsDatabase;

function ask(): GenerationAsk {
  return {
    endpoint: {
      endpointId: 'getOrder',
      name: 'Get order',
      method: 'GET',
      pathTemplate: '/orders/{orderId}',
      params: [{ name: 'orderId', location: 'path', required: true }],
    },
    request: {
      method: 'GET',
      url: 'https://bnpl.invalid/v1/orders/ord_1',
      endpointId: 'getOrder',
      params: { orderId: 'ord_1' },
      body: undefined,
    },
    success: { status: 200, schema: { type: 'object' } },
    collections: [{ collection: 'orders', identityField: 'id', schema: { type: 'object' } }],
    domainBrief: 'A buy-now-pay-later provider.',
    world: {
      collections: [
        {
          collection: 'orders',
          identityField: 'id',
          matched: [{ id: 'ord_1', body: { id: 'ord_1', total: 400 } }],
          sample: [],
          truncated: false,
        },
      ],
    },
    clockMs: Date.parse('2026-01-01T00:00:00.000Z'),
    priorCalls: [{ endpointId: 'listOrders', status: 200 }],
    outputSchema: { type: 'object' },
  };
}

function context(signal?: AbortSignal): ExecutorContext {
  return {
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    runId: 'run-1',
    stepExecutionId: 'step-1',
    logicalExecutionId: 'logical-1',
    attempt: 1,
    callerModel: undefined,
    signal: signal ?? new AbortController().signal,
    job: { spaceId: 'space-1', credentialOwnerId: 'user-1' },
  } as unknown as ExecutorContext;
}

let claimed = 0;

function generator(params: {
  max: number;
  used?: number;
  signal?: AbortSignal;
}): ReturnType<typeof createGenerateSimulatedAnswer> {
  claimed = params.used ?? 0;
  return createGenerateSimulatedAnswer(context(params.signal), {
    db,
    simulationId: 'sim_bnpl',
    budget: {
      maxGeneratedCallsPerRun: params.max,
      // Stands in for the conditional UPDATE the executor runs: claims are
      // durable and monotonic, and the ceiling refuses rather than the caller
      // counting for itself.
      claimSlot: () => {
        claimed += 1;
        return Promise.resolve(claimed > params.max ? null : claimed);
      },
    },
  });
}

async function aflowErrorOf(promise: Promise<unknown>): Promise<{
  code: string;
  message: string;
  retryable: boolean;
}> {
  try {
    await promise;
    throw new Error('the generation port resolved where it was expected to refuse');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiExecutionError);
    const { aflowError } = error as ApiExecutionError;
    return {
      code: aflowError.code,
      message: aflowError.message,
      retryable: aflowError.retryable,
    };
  }
}

beforeEach(() => {
  provider.calls.length = 0;
  provider.resolvable = new Set(['anthropic-sonnet']);
  provider.answer = { status: 200, body: { ok: true }, mutations: [] };
  provider.usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
});

describe('the generated-call ceiling', () => {
  it('refuses the call rather than downgrading it, and names the ceiling', async () => {
    const failure = await aflowErrorOf(generator({ max: 3, used: 3 }).generate(ask()));

    expect(failure.code).toBe('API_SIMULATION_GENERATION_LIMIT');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('maxGeneratedCallsPerRun of 3');
    // The refusal is the answer. A downgrade would have produced a body.
    expect(provider.calls).toHaveLength(0);
  });

  it('counts what this call generates against the same ceiling', async () => {
    const gen = generator({ max: 1, used: 0 });

    await expect(gen.generate(ask())).resolves.toMatchObject({ status: 200 });
    const failure = await aflowErrorOf(gen.generate(ask()));

    expect(failure.code).toBe('API_SIMULATION_GENERATION_LIMIT');
    expect(provider.calls).toHaveLength(1);
  });

  it('generates nothing at all when the policy allows nothing', async () => {
    const failure = await aflowErrorOf(generator({ max: 0 }).generate(ask()));

    expect(failure.code).toBe('API_SIMULATION_GENERATION_LIMIT');
    expect(provider.calls).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('aborts before dialling the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const gen = generator({ max: 5, signal: controller.signal });

    await expect(gen.generate(ask())).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
    expect(gen.spend()).toBeUndefined();
  });

  it('hands the step signal to the model call, so an abort mid-flight lands', async () => {
    const controller = new AbortController();
    await generator({ max: 5, signal: controller.signal }).generate(ask());

    expect(provider.calls[0]?.['signal']).toBe(controller.signal);
  });
});

describe('spend', () => {
  it('reports a well-formed usage breakdown the step result can carry as costJson', async () => {
    const gen = generator({ max: 5 });
    await gen.generate(ask());

    const spend = gen.spend();
    expect(StepUsageBreakdownSchema.safeParse(spend).success).toBe(true);
    expect(spend).toMatchObject({
      provider: 'anthropic',
      model: 'anthropic-sonnet',
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      totalCostUsd: 0.003,
    });
  });

  it('sums every generation the call made', async () => {
    const gen = generator({ max: 5 });
    await gen.generate(ask());
    await gen.generate(ask());

    expect(gen.spend()?.totalTokens).toBe(240);
    expect(gen.spend()?.totalCostUsd).toBeCloseTo(0.006, 6);
  });

  it('reports nothing when the provider billed nothing', async () => {
    provider.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const gen = generator({ max: 5 });
    await gen.generate(ask());

    expect(gen.spend()).toBeUndefined();
  });
});

describe('model access', () => {
  it('signals that it cannot generate when the space can resolve no model', async () => {
    provider.resolvable = new Set();

    // Typed distinctly from a bad answer or a spent ceiling, because the
    // operator's fix differs — connect a provider, rather than fix a schema or
    // raise a budget. It still fails the call: answering from the contract
    // example would present wiring as behaviour.
    await expect(generator({ max: 5 }).generate(ask())).rejects.toBeInstanceOf(
      SimulationGenerationUnavailableError,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('sends the simulator schema as the provider structured-output constraint', async () => {
    const asked = ask();
    await generator({ max: 5 }).generate(asked);

    expect(provider.calls[0]?.['rawJsonSchema']).toBe(asked.outputSchema);
  });
});

describe('the generated envelope', () => {
  it('fails loud when the model answers outside the shape the request required', async () => {
    provider.answer = {
      body: { ok: true },
      mutations: [{ collection: 'orders', op: 'upsert', entityId: 'ord_2' }],
    };
    const failure = await aflowErrorOf(generator({ max: 5 }).generate(ask()));

    expect(failure.code).toBe('API_SIMULATION_CONTRACT_VIOLATION');
  });

  it('stamps the success status the endpoint declares rather than one the model chose', async () => {
    // The generation schema carries no `status` at all: with one legal value
    // it is a constant the model can only echo or drop, and dropping it failed
    // the whole call.
    provider.answer = { status: 201, body: { ok: true } };

    await expect(generator({ max: 5 }).generate(ask())).resolves.toMatchObject({ status: 200 });
  });

  it('carries the mutations through as the world store expects them', async () => {
    provider.answer = {
      body: { id: 'ord_2' },
      mutations: [{ collection: 'orders', op: 'create', entityId: 'ord_2', body: { id: 'ord_2' } }],
    };

    await expect(generator({ max: 5 }).generate(ask())).resolves.toEqual({
      status: 200,
      body: { id: 'ord_2' },
      mutations: [{ collection: 'orders', op: 'create', entityId: 'ord_2', body: { id: 'ord_2' } }],
    });
  });
});

describe('the spend reaches run accounting', () => {
  async function source(file: string): Promise<string> {
    const fs = await import('node:fs/promises');
    return fs.readFile(new URL(file, import.meta.url), 'utf8');
  }

  it('is carried out of the simulated call rather than left in the generator', async () => {
    const src = await source('./execute.ts');

    expect(src).toContain('generator.spend()');
    expect(src).toContain('usage?: StepUsageBreakdown');
  });

  it('lands on the step result as costJson, which is what run accounting reads', async () => {
    const src = await source('../ApiCallHandler.ts');

    expect(src).toContain('{ costJson: simulated.usage }');
  });
});
