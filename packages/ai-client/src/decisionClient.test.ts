import { describe, expect, it, vi } from 'vitest';
import type { DecisionQuestions, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { createAIClient, decideInBatches } from './client.js';
import { createDefaultModelCatalog } from './catalog.js';
import type { DecideRequest } from './types.js';

const context = {
  tenantId: 'tenant' as TenantId,
  runId: 'run' as SessionId,
  stepExecutionId: 'step' as StepExecutionId,
};

function questions(count: number): DecisionQuestions {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `q_${String(i)}`,
      { type: 'yes_no' as const, instructions: 'x' },
    ]),
  );
}

const answerAll = vi.fn(async (request: DecideRequest) => ({
  model: 'm',
  answers: Object.fromEntries(
    Object.keys(request.questions).map((name) => [
      name,
      { type: 'yes_no' as const, probability: 0.9 },
    ]),
  ),
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
}));

describe('decideInBatches', () => {
  it('sends one request within the limit', async () => {
    answerAll.mockClear();
    await decideInBatches(
      answerAll,
      { model: 'm', state: 's', questions: questions(3), ...context },
      3,
    );
    expect(answerAll).toHaveBeenCalledOnce();
  });

  it('splits past the limit and merges every answer and the usage', async () => {
    answerAll.mockClear();
    const result = await decideInBatches(
      answerAll,
      { model: 'm', state: 's', questions: questions(5), ...context },
      2,
    );
    expect(answerAll).toHaveBeenCalledTimes(3);
    expect(Object.keys(result.answers)).toHaveLength(5);
    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 3, totalTokens: 33 });
  });
});

describe('the decision catalog', () => {
  it('gives every decision model a profile, and only decision models', () => {
    for (const model of createDefaultModelCatalog().listModels()) {
      expect(model.decision !== undefined, model.id).toBe(model.capabilities.decision === true);
    }
  });

  it('refuses images for a model that reads none, naming one that does', async () => {
    const client = createAIClient({ providers: { typesafe: { apiKey: 'k' } } });
    await expect(
      client.decide({
        model: 'jev',
        state: 's',
        questions: questions(1),
        images: [{ data: 'AAAA', mimeType: 'image/png' }],
        ...context,
      }),
    ).rejects.toThrow(/reads no images.*luna-decisions/);
  });
});
