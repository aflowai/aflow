import { describe, expect, it, vi } from 'vitest';
import type { AIClient, DecideRequest } from '@aflow/ai-client';
import type { JudgeCriterion } from '@aflow/schemas';
import { callJudgeModel } from '../judgeCall.js';

const criterion: JudgeCriterion = {
  type: 'judge',
  name: 'Reply quality',
  rubric: [
    { criterion: 'Grounded', scale: 'binary', description: 'Cites only what the tools returned' },
    {
      criterion: 'Polite',
      scale: 'binary',
      description: 'Courteous to the customer',
      minConfidence: 0.8,
    },
    { criterion: 'Resolved', scale: 'binary', description: 'Answers the question asked' },
  ],
  reads: [],
};

function decisionClient(probabilities: number[]) {
  const decide = vi.fn(async (request: DecideRequest) => ({
    model: 'jev-1.13.0',
    provider: 'typesafe' as const,
    usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
    cost: { promptCost: 0.0000042, completionCost: 0, totalCost: 0.0000042, currency: 'USD' },
    answers: Object.fromEntries(
      Object.keys(request.questions).map((name, i) => [
        name,
        { type: 'yes_no' as const, probability: probabilities[i]! },
      ]),
    ),
  }));
  const generateJson = vi.fn();
  const client = {
    decide,
    generateJson,
  } as unknown as AIClient;
  return { client, decide, generateJson };
}

const call = (client: AIClient) =>
  callJudgeModel({
    client,
    model: 'jev',
    criterion,
    evidence: { taskSummaries: [{ taskId: 'reply', status: 'succeeded', summary: 'Replied.' }] },
    tenantId: 'tenant',
    attributionId: 'run',
  });

describe('a decision model as the judge', () => {
  it('asks each rubric entry as a yes/no about the evidence, never the rubric as state', async () => {
    const { client, decide, generateJson } = decisionClient([0.9, 0.9, 0.1]);
    await call(client);

    expect(generateJson).not.toHaveBeenCalled();
    const request = decide.mock.calls[0]![0];
    expect(Object.keys(request.questions)).toEqual(['entry_1', 'entry_2', 'entry_3']);
    expect(request.questions['entry_2']).toMatchObject({
      type: 'yes_no',
      instructions: 'Polite: Courteous to the customer',
      minConfidence: 0.8,
    });
    expect(request.state).toContain('## Run Artifacts');
    expect(request.state).not.toContain('## Rubric');
  });

  it('maps confident answers to pass and fail, and an unconfident one to unclear', async () => {
    const { client } = decisionClient([0.93, 0.7, 0.05]);
    const { verdict } = await call(client);
    expect(verdict.entries.map((e) => [e.criterion, e.verdict])).toEqual([
      ['Grounded', 'pass'],
      ['Polite', 'unclear'],
      ['Resolved', 'fail'],
    ]);
    expect(verdict.entries[0]!.rationale).toContain('0.930');
  });
});
