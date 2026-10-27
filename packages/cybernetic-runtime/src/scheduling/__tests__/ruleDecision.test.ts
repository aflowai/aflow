/**
 * Contract: `workflow.run.decide` is a rule, not a judgement — the first rule
 * whose comparisons hold over the state decides, the default where none
 * does; a value the state does not hold reads as null; two values of the
 * state compare with each other; and a rule outside the grammar is refused
 * whatever the state, not only on the state that reaches it.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowRunDecideInput } from '@aflow/schemas';
import { decideByRules, parseRuleComparison, RuleDecisionError } from '../ruleDecision.js';

const OTHERWISE = { decision: 'fix', reason: 'Nothing held back.' };

function decide(state: Record<string, unknown>, rules: WorkflowRunDecideInput['rules']) {
  return decideByRules({ state, rules, otherwise: OTHERWISE });
}

describe('decideByRules — a value beside the decision', () => {
  it('hands on the value the rule that held names, and none where it names none', () => {
    const rules: WorkflowRunDecideInput['rules'] = [
      { when: { expression: 'state.lines < 30' }, decision: 'brief', reason: 'Small.', value: 8 },
      { when: { expression: 'state.lines < 300' }, decision: 'standard', reason: 'Medium.' },
    ];
    expect(decide({ lines: 3 }, rules)).toEqual({
      decision: 'brief',
      reason: 'Small.',
      rule: 0,
      value: 8,
    });
    expect(decide({ lines: 100 }, rules)).not.toHaveProperty('value');
    expect(
      decideByRules({
        state: { lines: 1000 },
        rules,
        otherwise: { decision: 'deep', reason: 'Large.', value: 'all' },
      }),
    ).toEqual({ decision: 'deep', reason: 'Large.', rule: null, value: 'all' });
  });
});

describe('decideByRules', () => {
  const rules: WorkflowRunDecideInput['rules'] = [
    {
      when: { expression: "state.checks.state == 'passing'" },
      decision: 'leave',
      reason: 'Green.',
    },
    {
      when: { expression: "state.checks.state != 'failing'" },
      decision: 'wait',
      reason: 'Not red.',
    },
    {
      when: { expression: 'state.checks.firstFailing.id == state.handoff.checkRunId' },
      decision: 'wait',
      reason: 'Acted on already.',
    },
    {
      when: { expression: 'state.handoff.attemptCount >= state.budget' },
      decision: 'abandon',
      reason: 'Spent.',
    },
  ];
  const red = { state: 'failing', firstFailing: { id: '555' } };

  it('takes the first rule that holds, with its reason and its place', () => {
    expect(decide({ checks: { state: 'passing' } }, rules)).toEqual({
      decision: 'leave',
      reason: 'Green.',
      rule: 0,
    });
  });

  it('falls to the default where no rule holds', () => {
    expect(decide({ checks: red, handoff: { attemptCount: 0 }, budget: 3 }, rules)).toEqual({
      ...OTHERWISE,
      rule: null,
    });
  });

  it('compares two values of the state', () => {
    expect(
      decide({ checks: red, handoff: { checkRunId: '555', attemptCount: 1 }, budget: 3 }, rules)
        .decision,
    ).toBe('wait');
    expect(
      decide({ checks: red, handoff: { checkRunId: '554', attemptCount: 3 }, budget: 3 }, rules)
        .decision,
    ).toBe('abandon');
  });

  it('reads a read that did not happen as null, so `!=` holds against it', () => {
    expect(decide({}, rules)).toMatchObject({ decision: 'wait', rule: 1 });
    expect(
      decide({}, [{ when: { expression: 'state.pr == null' }, decision: 'leave', reason: 'None.' }])
        .decision,
    ).toBe('leave');
  });

  it('orders only numbers', () => {
    expect(
      decide({ a: '3', b: 2 }, [
        { when: { expression: 'state.a > state.b' }, decision: 'wait', reason: 'x' },
      ]).decision,
    ).toBe('fix');
  });

  it('combines with anyOf and allOf', () => {
    const combined: WorkflowRunDecideInput['rules'] = [
      { when: { allOf: ['state.a == 1', 'state.b == true'] }, decision: 'wait', reason: 'both' },
      { when: { anyOf: ['state.a == 2', "state.c == 'x'"] }, decision: 'leave', reason: 'either' },
    ];
    expect(decide({ a: 1, b: true }, combined).decision).toBe('wait');
    expect(decide({ a: 1, b: false }, combined).decision).toBe('fix');
    expect(decide({ a: 3, c: 'x' }, combined).decision).toBe('leave');
  });

  it('refuses a rule outside the grammar before it reads any, naming it', () => {
    const malformed: WorkflowRunDecideInput['rules'] = [
      { when: { expression: 'state.a == 1' }, decision: 'wait', reason: 'x' },
      { when: { expression: 'tasks.a.output.b == 1' }, decision: 'leave', reason: 'y' },
    ];
    expect(() => decide({ a: 1 }, malformed)).toThrowError(RuleDecisionError);
    expect(() => decide({ a: 1 }, malformed)).toThrowError(/Rule 1/);
  });
});

describe('parseRuleComparison', () => {
  it.each([
    ["state.a.b[0] == 'x'", { kind: 'literal', value: 'x' }],
    ['state.a != null', { kind: 'literal', value: null }],
    ['state.n >= 3', { kind: 'literal', value: 3 }],
  ])('reads %s', (expression, right) => {
    expect(parseRuleComparison(expression)?.right).toEqual(right);
  });

  it('reads a state path on the right', () => {
    expect(parseRuleComparison('state.a == state.b.c')?.right.kind).toBe('path');
  });

  it.each(['a == 1', 'state.a ~ 1', 'state.a == unquoted', 'state. == 1'])(
    'refuses %s',
    (expression) => {
      expect(parseRuleComparison(expression)).toBeNull();
    },
  );
});
