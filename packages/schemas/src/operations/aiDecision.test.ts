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

  it('refuses a yes_no that states no claim', () => {
    expect(parse({ u: { type: 'yes_no' } }).success).toBe(false);
    expect(parse({ u: { type: 'yes_no', criteria: { true: 'Asks for a refund' } } }).success).toBe(
      true,
    );
  });

  it('refuses an empty question set', () => {
    expect(parse({}).success).toBe(false);
  });

  it('takes a question of each item alone, named questions alone, or both — never neither', () => {
    const each = { items: [{ claim: 'a' }], question: { type: 'yes_no', instructions: 'Defect' } };
    const named = { u: { type: 'yes_no', instructions: 'x' } };
    expect(AiDecideInputSchema.safeParse({ state: 'x', each }).success).toBe(true);
    expect(AiDecideInputSchema.safeParse({ state: 'x', each, questions: named }).success).toBe(
      true,
    );
    expect(AiDecideInputSchema.safeParse({ state: 'x' }).success).toBe(false);
  });

  it('refuses a named question under the name an item is asked by, and an each that cannot be asked', () => {
    const each = { items: [{ claim: 'a' }], question: { type: 'yes_no', instructions: 'Defect' } };
    const clash = { each_0: { type: 'yes_no', instructions: 'x' } };
    expect(AiDecideInputSchema.safeParse({ state: 'x', each, questions: clash }).success).toBe(
      false,
    );
    for (const bad of [
      { ...each, question: { type: 'yes_no' } },
      { ...each, items: Array<unknown>(51).fill({}) },
    ]) {
      expect(AiDecideInputSchema.safeParse({ state: 'x', each: bad }).success).toBe(false);
    }
  });

  it('refuses an item that cannot be read as instructions: a number, a boolean or null', () => {
    const question = { type: 'yes_no', instructions: 'Defect' };
    for (const item of [3, true, null]) {
      const result = AiDecideInputSchema.safeParse({
        state: 'x',
        each: { items: [item], question },
      });
      expect(result.success, String(item)).toBe(false);
    }
    for (const item of ['a claim', { claim: 'a' }, ['a', 'b']]) {
      const result = AiDecideInputSchema.safeParse({
        state: 'x',
        each: { items: [item], question },
      });
      expect(result.success, JSON.stringify(item)).toBe(true);
    }
  });

  it('takes an empty list, which a step reads only when the list it binds came back empty', () => {
    const each = { items: [], question: { type: 'yes_no', instructions: 'Defect' } };
    expect(AiDecideInputSchema.safeParse({ state: 'x', each }).success).toBe(true);
  });

  it('refuses a minConfidence outside 0..1', () => {
    expect(parse({ u: { type: 'yes_no', instructions: 'x', minConfidence: 1.5 } }).success).toBe(
      false,
    );
  });
});
