/**
 * ai.decision.decide as a step: the questions a request asks reach the model
 * as one pass, and an `each` over an empty list is answered without one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { AiDecideOutputSchema, type AiDecideInput, type TenantId } from '@aflow/schemas';
import { getAIClientForContext } from '../aiClient.js';
import { handleDecide } from './decide.js';
import type { HandlerDeps } from './types.js';

vi.mock('../aiClient.js', () => ({ getAIClientForContext: vi.fn() }));
vi.mock('@aflow/executor-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/executor-runtime')>()),
  successWithData: vi.fn((_ctx: unknown, data: unknown) =>
    Promise.resolve({ status: 'SUCCEEDED', data }),
  ),
}));

const decide = vi.fn();

function fakeCtx(): ExecutorContext {
  return {
    job: { tenantId: 'tenant-d', stepExecutionId: 'step-d', attempt: 1 },
    tenantId: 'tenant-d' as TenantId,
    runId: 'run-d',
    log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  } as unknown as ExecutorContext;
}

const deps = {
  payloadStore: {} as HandlerDeps['payloadStore'],
  handleError: (_ctx: ExecutorContext, label: string, error: unknown) => {
    throw new Error(`${label}: ${String(error)}`);
  },
  validateToolArgs: () => null,
} satisfies HandlerDeps;

const FINDING = {
  type: 'yes_no' as const,
  instructions: 'Names a defect, established by evidence shown',
  minConfidence: 0.8,
};

async function run(input: AiDecideInput) {
  const result = (await handleDecide(fakeCtx(), input, deps)) as unknown as { data: unknown };
  return AiDecideOutputSchema.parse(result.data);
}

describe('ai.decision.decide — a question of each item', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAIClientForContext).mockResolvedValue({ decide } as never);
  });

  it('asks every item in the one call, and hands back only the items judged true and decided', async () => {
    decide.mockResolvedValue({
      model: 'jev-1.13.0',
      answers: {
        each_0: { type: 'yes_no', probability: 0.97 },
        each_1: { type: 'yes_no', probability: 0.6 },
      },
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
    });
    const output = await run({
      state: { verdict: 'request_changes' },
      each: { items: [{ claim: 'leaks' }, { claim: 'maybe' }], question: FINDING },
    });
    expect(decide).toHaveBeenCalledOnce();
    expect(Object.keys(decide.mock.calls[0]![0].questions as object)).toEqual(['each_0', 'each_1']);
    expect(output.answers).toEqual({});
    expect(output.each?.selected).toEqual([{ claim: 'leaks' }]);
    expect(output.each?.undecidedCount).toBe(1);
  });

  it('asks no model, and needs no credential, for an empty list — and selects nothing', async () => {
    const output = await run({ state: {}, each: { items: [], question: FINDING } });
    expect(getAIClientForContext).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(output.each).toMatchObject({ selected: [], selectedCount: 0, selectedJson: '[]' });
    expect(output.usage.totalTokens).toBe(0);
  });
});
