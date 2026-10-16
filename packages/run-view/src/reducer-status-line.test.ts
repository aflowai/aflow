import { describe, expect, it } from 'vitest';
import { latestStatusLine, runViewReducer, initialRunViewState } from './index.js';

describe('a status frame', () => {
  it('leaves the step in its last whole line', () => {
    expect(latestStatusLine('Loading Gemma 4 26B into memory…\nReading the conversation…\n')).toBe(
      'Reading the conversation…',
    );
  });

  it('says nothing new when it carries no whole line', () => {
    expect(latestStatusLine('Reading the conv')).toBeUndefined();
    expect(latestStatusLine('Loading…\nReading the conv')).toBe('Loading…');
  });

  it('adds nothing to the conversation', () => {
    const state = runViewReducer(initialRunViewState, {
      type: 'LIVE_DELTA',
      stepExecutionId: 'step-1',
      channel: 'status',
      offset: 0,
      delta: 'Loading Gemma 4 26B into memory…\n',
      timestamp: new Date(0).toISOString(),
    });
    expect(state.messages).toEqual([]);
    expect(state.harnessActivity).toEqual({});
  });
});
