import { describe, it, expect } from 'vitest';

import { pauseExecutionState as executionStateFor } from '../dispatchHumanTask.js';

/**
 * The rule dispatch applies when it builds a pause contract, exercised through
 * the function dispatch calls. An earlier version of this file restated the
 * expression instead, which asserted only that the copy agreed with itself.
 */

describe('what a pause records about the subject', () => {
  it('records silence when a conversational subject supplied no answer', () => {
    expect(executionStateFor({ intent: 'collect' })).toBe('no_terminal_reply');
    expect(executionStateFor({ intent: 'collect', pauseInstruction: '' })).toBe(
      'no_terminal_reply',
    );
    expect(executionStateFor({ intent: 'collect', pauseInstruction: '   ' })).toBe(
      'no_terminal_reply',
    );
  });

  it('records a real answer as completed', () => {
    expect(
      executionStateFor({ intent: 'collect', pauseInstruction: 'Your refund is on its way.' }),
    ).toBe('completed');
  });

  it('never calls an approval gate a missing reply', () => {
    // An approval pause's prompt is the decision put to the operator, not the
    // subject's answer. In the local stack 20 of 22 empty-prompt pauses were
    // approval gates across four skills — stamping them would have reported
    // every approval-gated run as an execution failure.
    expect(executionStateFor({ intent: 'approve' })).toBe('completed');
    expect(executionStateFor({ intent: 'approve', pauseInstruction: '' })).toBe('completed');
  });

  it('defaults an unstated intent to collect', () => {
    expect(executionStateFor({})).toBe('no_terminal_reply');
    expect(executionStateFor({ pauseInstruction: 'here is your answer' })).toBe('completed');
  });
});
