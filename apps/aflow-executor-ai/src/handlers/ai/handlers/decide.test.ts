/**
 * ai.decision.decide as a step: the questions a request asks reach the model
 * as one pass, an item the model declines is never selected, and an `each`
 * over an empty list is answered without a model or the credential for one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  AiDecideOutputSchema,
  DECISION_NO_MODEL,
  type AiDecideInput,
  type TenantId,
} from '@aflow/schemas';
import { getAIClientForContext } from '../aiClient.js';
import { handleDecide } from './decide.js';
import { resolveDecisionModel } from './decisionModel.js';
import type { HandlerDeps } from './types.js';

vi.mock('../aiClient.js', () => ({ getAIClientForContext: vi.fn() }));
vi.mock('./decisionModel.js', () => ({ resolveDecisionModel: vi.fn() }));
vi.mock('@aflow/executor-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/executor-runtime')>()),
  successWithData: vi.fn((_ctx: unknown, data: unknown) =>
    Promise.resolve({ status: 'SUCCEEDED', data }),
  ),
}));

const decide = vi.fn();
const getModel = vi.fn(() => ({ decision: { confidence: 'calibrated' } }));

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
    vi.mocked(getAIClientForContext).mockResolvedValue({ decide, getModel } as never);
    vi.mocked(resolveDecisionModel).mockResolvedValue('jev');
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

  it('never selects an item the model declined, and counts it undecided, beside a named question', async () => {
    decide.mockResolvedValue({
      model: 'luna-decisions',
      answers: {
        route: { type: 'choice', choice: 'fix', confidence: 0.9, probabilities: { fix: 0.9 } },
        each_0: { type: 'refusal' },
        each_1: { type: 'yes_no', probability: 0.95 },
      },
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
    });
    const output = await run({
      state: { verdict: 'request_changes' },
      questions: {
        route: {
          type: 'choice',
          options: { fix: 'Fix it.', ship: 'Ship it.' },
          minConfidence: 0.8,
        },
      },
      each: { items: [{ claim: 'declined' }, { claim: 'leaks' }], question: FINDING },
    });
    expect(output.answers['route']).toMatchObject({ decidedValue: 'fix', decided: true });
    expect(output.each?.answers[0]).toEqual({
      type: 'refusal',
      decidedValue: null,
      decided: false,
    });
    expect(output.each?.selected).toEqual([{ claim: 'leaks' }]);
    expect(output.each?.undecidedCount).toBe(1);
    expect(output.calibration).toBe('calibrated');
  });

  it('asks no model, and needs no credential, for an empty list — and selects nothing', async () => {
    const output = await run({ state: {}, each: { items: [], question: FINDING } });
    expect(resolveDecisionModel).not.toHaveBeenCalled();
    expect(getAIClientForContext).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(output.each).toMatchObject({ selected: [], selectedCount: 0, selectedJson: '[]' });
    expect(output.usage.totalTokens).toBe(0);
    // Nothing was asked, so no model answered and no confidence is claimed calibrated.
    expect(output.model).toBe(DECISION_NO_MODEL);
    expect(output.calibration).toBe('self_reported');
  });
});
