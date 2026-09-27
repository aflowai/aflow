import { describe, expect, it } from 'vitest';
import { AiDecideInputSchema } from './aiDecision.js';

const choiceWith = (count: number) => ({
  type: 'choice',
  options: Object.fromEntries(Array.from({ length: count }, (_, i) => [`o${String(i)}`, null])),
});

function parse(questions: Record<string, unknown>) {
  return AiDecideInputSchema.safeParse({ state: 'x', questions });
}

describe('AiDecideInputSchema', () => {
  it('accepts every question type together', () => {
    expect(
      parse({
        team: choiceWith(2),
        frustration: { type: 'score', levels: ['low', null, { level: 'high' }] },
        urgent: { type: 'yes_no', criteria: { true: 'time-sensitive' }, minConfidence: 0.8 },
      }).success,
    ).toBe(true);
  });

  it('bounds a choice to 2..255 options', () => {
    expect(parse({ team: choiceWith(1) }).success).toBe(false);
    expect(parse({ team: choiceWith(255) }).success).toBe(true);
    expect(parse({ team: choiceWith(256) }).success).toBe(false);
  });

  it('bounds a score to 2..10 levels', () => {
    expect(parse({ s: { type: 'score', levels: ['a'] } }).success).toBe(false);
    expect(parse({ s: { type: 'score', levels: Array(11).fill(null) } }).success).toBe(false);
  });

  it('holds question names to what a predicate path can carry', () => {
    const result = parse({ 'Needs Review': { type: 'yes_no' } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('answers.<name>');
  });

  it('refuses an empty question set', () => {
    expect(parse({}).success).toBe(false);
  });

  it('refuses a minConfidence outside 0..1', () => {
    expect(parse({ u: { type: 'yes_no', minConfidence: 1.5 } }).success).toBe(false);
  });
});
