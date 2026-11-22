/**
 * The directive ask rule (Plan 345 D): a raise to `full` rests on a whole
 * message that is an imperative addressed to the agent with full autonomy as
 * its object. Five steps refuse the rest, each with its own finding.
 */
import { describe, expect, it } from 'vitest';
import { directiveAsk } from '../spaceAutonomyDirective.js';

describe('directiveAsk', () => {
  it('accepts an imperative whose object is full autonomy', () => {
    for (const words of [
      'set full autonomy',
      'Please set full autonomy for this space.',
      'give yourself full autonomy',
      'Grant full autonomy now',
      'ok, switch this space to full autonomy',
      'Full autonomy please.. nothing waits on me.',
      'the full autonomy, please',
    ]) {
      expect(directiveAsk(words), words).toEqual({ kind: 'asks' });
    }
  });

  it('reads absolute, complete and total as naming the raise', () => {
    expect(directiveAsk('absolute autonomy please.. nothing waits on me')).toEqual({
      kind: 'asks',
    });
    expect(directiveAsk('Give it complete autonomy')).toEqual({ kind: 'asks' });
    expect(directiveAsk('set total autonomy')).toEqual({ kind: 'asks' });
  });

  it('refuses a message that does not name the raise', () => {
    for (const words of ['yes', 'autonomy please', 'go full speed', 'set it up']) {
      expect(directiveAsk(words), words).toEqual({ kind: 'names_no_raise' });
    }
  });

  it('keeps the negating-word step, ahead of the question and condition steps', () => {
    expect(directiveAsk('please do not set full autonomy')).toEqual({
      kind: 'refuses_raise',
      word: 'not',
    });
    expect(directiveAsk('Full autonomy? No.')).toEqual({ kind: 'refuses_raise', word: 'no' });
    expect(directiveAsk('If CI fails, never set full autonomy')).toMatchObject({
      kind: 'refuses_raise',
    });
  });

  it('refuses a question', () => {
    for (const words of [
      'What does full autonomy mean?',
      'Should I give you full autonomy?',
      'should I give you full autonomy',
      'can you set full autonomy',
      'set full autonomy?',
      'I wonder whether to set full autonomy',
    ]) {
      expect(directiveAsk(words), words).toEqual({ kind: 'question' });
    }
  });

  it('refuses a condition', () => {
    expect(directiveAsk('If CI passes, set full autonomy')).toEqual({
      kind: 'conditional',
      word: 'if',
    });
    expect(directiveAsk('set full autonomy once the review is green')).toEqual({
      kind: 'conditional',
      word: 'once',
    });
    expect(directiveAsk('Set full autonomy unless the operator objects')).toEqual({
      kind: 'conditional',
      word: 'unless',
    });
  });

  it('refuses a message that names the raise but directs nothing', () => {
    for (const words of [
      'full autonomy is what we discussed',
      'I like full autonomy',
      'full autonomy',
      'nothing waits on me, full autonomy for the record',
    ]) {
      expect(directiveAsk(words), words).toEqual({ kind: 'ambiguous' });
    }
  });
});
