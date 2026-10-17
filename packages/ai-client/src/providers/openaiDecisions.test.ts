import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { DecisionQuestions, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { decideWithOpenAI, toOpenAIQuestion } from './openaiDecisions.js';

const context = {
  tenantId: 'tenant' as TenantId,
  runId: 'run' as SessionId,
  stepExecutionId: 'step' as StepExecutionId,
};

const questions: DecisionQuestions = {
  team: {
    type: 'choice',
    instructions: 'Which team owns this',
    options: { billing: 'Payments', technical: null },
  },
  severity: { type: 'score', levels: ['minor', null, { level: 'critical' }] },
  urgent: { type: 'yes_no', criteria: { true: 'Says today', false: 'No deadline' } },
};

function clientAnswering(response: unknown) {
  const post = vi.fn(async () => response);
  return { client: { post } as unknown as OpenAI, post };
}

const RESPONSE = {
  model: 'gpt-6-luna',
  answers: [
    {
      type: 'choice',
      name: 'team',
      choice: 'billing',
      confidence: 0.9,
      probabilities: [
        { value: 'billing', probability: 0.9 },
        { value: 'technical', probability: 0.1 },
      ],
    },
    {
      type: 'score',
      name: 'severity',
      score: 1.4,
      confidence: 0.6,
      probabilities: [
        { value: 0, label: 'minor', probability: 0.1 },
        { value: 1, label: 'level 1', probability: 0.4 },
        { value: 2, label: 'level 2', probability: 0.5 },
      ],
    },
    { type: 'refusal', name: 'urgent' },
  ],
  usage: { input_tokens: 300, output_tokens: 12 },
};

describe('OpenAI Decisions', () => {
  it('states every question in the provider’s vocabulary', () => {
    expect(toOpenAIQuestion('team', questions['team']!)).toEqual({
      type: 'choice',
      name: 'team',
      instructions: 'Which team owns this',
      choices: [{ value: 'billing', description: 'Payments' }, { value: 'technical' }],
    });
    expect(toOpenAIQuestion('severity', questions['severity']!)).toEqual({
      type: 'score',
      name: 'severity',
      instructions: 'Rate the input against the levels, lowest first.',
      levels: [
        { label: 'minor' },
        { label: 'level 1' },
        { label: 'level 2', description: '{"level":"critical"}' },
      ],
    });
    expect(toOpenAIQuestion('urgent', questions['urgent']!)).toEqual({
      type: 'predicate',
      name: 'urgent',
      instructions: 'True when: Says today\nFalse when: No deadline',
    });
  });

  it('posts text state as the input and reads the answers back, a refusal included', async () => {
    const { client, post } = clientAnswering(RESPONSE);
    const result = await decideWithOpenAI(client, {
      model: 'gpt-6-luna',
      state: { ticket: 'Charged twice' },
      questions,
      ...context,
    });

    const [path, options] = post.mock.calls[0] as unknown as [string, { body: { input: unknown } }];
    expect(path).toBe('/decisions');
    expect(options.body.input).toBe('{"ticket":"Charged twice"}');
    expect(result.answers).toEqual({
      team: {
        type: 'choice',
        choice: 'billing',
        confidence: 0.9,
        probabilities: { billing: 0.9, technical: 0.1 },
      },
      severity: {
        type: 'score',
        score: 1.4,
        confidence: 0.6,
        probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
      },
      urgent: { type: 'refusal' },
    });
    expect(result.usage).toEqual({ promptTokens: 300, completionTokens: 12, totalTokens: 312 });
  });

  it('sends images as data URLs in a user message beside the state', async () => {
    const { client, post } = clientAnswering({ ...RESPONSE, answers: [RESPONSE.answers[0]] });
    await decideWithOpenAI(client, {
      model: 'gpt-6-luna',
      state: 'Is this damaged?',
      questions: { team: questions['team']! },
      images: [{ data: 'AAAA', mimeType: 'image/png' }],
      ...context,
    });
    const [, options] = post.mock.calls[0] as unknown as [string, { body: { input: unknown } }];
    expect(options.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Is this damaged?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    ]);
  });

  it('keys an answer that echoes no name by its position', async () => {
    const { client } = clientAnswering({
      ...RESPONSE,
      answers: [{ ...RESPONSE.answers[0], name: null }],
    });
    const result = await decideWithOpenAI(client, {
      model: 'gpt-6-luna',
      state: 'x',
      questions: { team: questions['team']! },
      ...context,
    });
    expect(Object.keys(result.answers)).toEqual(['team']);
  });

  it('reads a boolean choice value as its label', async () => {
    const { client } = clientAnswering({
      ...RESPONSE,
      answers: [
        {
          type: 'choice',
          name: 'flag',
          choice: true,
          confidence: 0.8,
          probabilities: [{ value: true, probability: 0.8 }],
        },
      ],
    });
    const result = await decideWithOpenAI(client, {
      model: 'gpt-6-luna',
      state: 'x',
      questions: { flag: { type: 'choice', options: { true: null, false: null } } },
      ...context,
    });
    expect(result.answers['flag']).toMatchObject({ choice: 'true' });
  });
});
