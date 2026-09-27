import { describe, expect, it } from 'vitest';
import type { DecisionQuestions } from '@aflow/schemas';
import { resolveDecisionAnswers } from './decision.js';
import { AIClientError } from './errors.js';

const questions: DecisionQuestions = {
  team: {
    type: 'choice',
    options: { billing: null, technical: null },
    minConfidence: 0.7,
  },
  frustration: { type: 'score', levels: ['Calm', 'Angry'], minConfidence: 0.6 },
  urgent: { type: 'yes_no', minConfidence: 0.8 },
  refund: { type: 'yes_no' },
};

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveDecisionAnswers(questions, {
    team: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: {} },
    frustration: { type: 'score', score: 0.4, confidence: 0.6, probabilities: {} },
    urgent: { type: 'yes_no', probability: 0.15 },
    refund: { type: 'yes_no', probability: 0.51 },
    ...overrides,
  } as Parameters<typeof resolveDecisionAnswers>[1]);
}

describe('resolveDecisionAnswers', () => {
  it('decides an answer whose confidence meets its minConfidence, inclusively', () => {
    const answers = resolve();
    expect(answers['team']).toMatchObject({ value: 'billing', decided: true });
    expect(answers['frustration']).toMatchObject({ value: 0.4, decided: true });
  });

  it('abstains below minConfidence and still reports the most likely answer', () => {
    const answers = resolve({
      team: { type: 'choice', choice: 'technical', confidence: 0.55, probabilities: {} },
    });
    expect(answers['team']).toMatchObject({ value: 'technical', decided: false });
  });

  it('reads a yes/no’s confidence as the probability of the more likely outcome', () => {
    const answers = resolve();
    expect(answers['urgent']).toEqual({
      type: 'yes_no',
      value: false,
      probability: 0.15,
      confidence: 0.85,
      decided: true,
    });
    expect(resolve({ urgent: { type: 'yes_no', probability: 0.3 } })['urgent']).toMatchObject({
      value: false,
      confidence: 0.7,
      decided: false,
    });
  });

  it('decides every answer to a question with no minConfidence', () => {
    expect(resolve()['refund']).toMatchObject({ value: true, decided: true });
  });

  it('refuses a choice outside the options offered', () => {
    expect(() =>
      resolve({ team: { type: 'choice', choice: 'sales', confidence: 1, probabilities: {} } }),
    ).toThrow(AIClientError);
  });

  it('refuses an answer of the wrong type', () => {
    expect(() =>
      resolve({ urgent: { type: 'score', score: 1, confidence: 1, probabilities: {} } }),
    ).toThrow(/yes_no question and got a score answer/);
  });
});
