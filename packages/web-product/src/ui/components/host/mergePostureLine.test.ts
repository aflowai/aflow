import { describe, expect, it } from 'vitest';

import { mergePostureLine } from './mergePostureLine.js';

describe('the merge posture line on the machine page', () => {
  it('leaves every merge to the operator under never, whatever the autonomy', () => {
    expect(mergePostureLine('never', 'full')).toBe(mergePostureLine('never', 'ratify'));
    expect(mergePostureLine('never', 'ratify')).toContain('yours to merge');
  });

  it('merges a comment verdict unasked under full', () => {
    const line = mergePostureLine('when-green', 'full');
    expect(line).toContain('without asking you');
    expect(line).toContain('approve or comment');
  });

  it('leaves a comment verdict to the operator and asks before each merge under ratify', () => {
    const line = mergePostureLine('when-green', 'ratify');
    expect(line).toContain('asks you before each merge');
    expect(line).toContain('A comment verdict leaves the merge to you');
    expect(line).not.toContain('approve or comment');
  });
});
