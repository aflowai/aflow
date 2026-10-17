import { describe, expect, it } from 'vitest';
import type { DecisionQuestions } from '@aflow/schemas';
import {
  decisionRequestQuestions,
  resolveDecisionAnswers,
  splitDecisionAnswers,
} from './decision.js';
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
      decidedValue: false,
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

  it('carries the value a route reads only where the answer cleared its bar, and null where it did not', () => {
    const sure = resolve();
    expect(sure['team']?.decidedValue).toBe('billing');
    expect(sure['frustration']?.decidedValue).toBe(0.4);
    // A false that cleared the bar is a decided false, never mistaken for none.
    expect(sure['urgent']?.decidedValue).toBe(false);
    const unsure = resolve({
      team: { type: 'choice', choice: 'technical', confidence: 0.55, probabilities: {} },
      frustration: { type: 'score', score: 0.4, confidence: 0.2, probabilities: {} },
      urgent: { type: 'yes_no', probability: 0.3 },
    });
    expect(unsure['team']).toMatchObject({ value: 'technical', decidedValue: null });
    expect(unsure['frustration']).toMatchObject({ value: 0.4, decidedValue: null });
    expect(unsure['urgent']).toMatchObject({ value: false, decidedValue: null });
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

describe('a question asked of each item', () => {
  const each = {
    items: [{ claim: 'leaks a handle' }, { claim: 'a name could be better' }, { claim: 'unsure' }],
    question: {
      type: 'yes_no' as const,
      instructions: 'Names a defect, established by evidence shown',
      minConfidence: 0.8,
    },
  };
  const named: DecisionQuestions = {
    round: { type: 'choice', options: { fix: null, ship: null } },
  };

  it('asks it once per item, each item beside the claim, alongside the named questions', () => {
    const asked = decisionRequestQuestions({ questions: named, each });
    expect(Object.keys(asked)).toEqual(['round', 'each_0', 'each_1', 'each_2']);
    expect(asked['each_1']).toEqual({
      type: 'yes_no',
      instructions: {
        claim: 'Names a defect, established by evidence shown',
        about: 'The item below, one of a list the state describes.',
        item: { claim: 'a name could be better' },
      },
      minConfidence: 0.8,
    });
  });

  it('selects only the items answered true and decided — never one the model was unsure of', () => {
    const input = { questions: named, each };
    const asked = decisionRequestQuestions(input);
    const resolved = resolveDecisionAnswers(asked, {
      round: { type: 'choice', choice: 'fix', confidence: 0.9, probabilities: {} },
      each_0: { type: 'yes_no', probability: 0.95 },
      each_1: { type: 'yes_no', probability: 0.05 },
      each_2: { type: 'yes_no', probability: 0.7 },
    });
    const { answers, each: out } = splitDecisionAnswers(input, resolved);
    expect(Object.keys(answers)).toEqual(['round']);
    expect(out?.answers.map((a) => [a.value, a.decided])).toEqual([
      [true, true],
      [false, true],
      [true, false],
    ]);
    expect(out?.selected).toEqual([{ claim: 'leaks a handle' }]);
    expect(out?.selectedCount).toBe(1);
    expect(out?.undecidedCount).toBe(1);
    expect(JSON.parse(out?.selectedJson ?? '')).toEqual([{ claim: 'leaks a handle' }]);
  });

  it('reports none selected as an empty list in both forms', () => {
    const input = { each: { ...each, items: [{ claim: 'x' }] } };
    const asked = decisionRequestQuestions(input);
    const { each: out } = splitDecisionAnswers(
      input,
      resolveDecisionAnswers(asked, { each_0: { type: 'yes_no', probability: 0.01 } }),
    );
    expect(out?.selected).toEqual([]);
    expect(out?.selectedJson).toBe('[]');
  });
});
