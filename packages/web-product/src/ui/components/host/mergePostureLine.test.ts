import { describe, expect, it } from 'vitest';

import { mergePostureLine } from './mergePostureLine.js';

const GATE_MEDIUM = { requireApprovalByTier: { medium: true } };
const ALLOW_MEDIUM = { requireApprovalByTier: { medium: false } };

describe('the merge posture line on the machine page', () => {
  it('leaves every merge to the operator under never, whatever the autonomy', () => {
    expect(mergePostureLine('never', 'full', null)).toBe(mergePostureLine('never', 'ratify', null));
    expect(mergePostureLine('never', 'ratify', GATE_MEDIUM)).toContain('yours to merge');
  });

  it('merges a comment verdict unasked under full, by the default for the medium tier', () => {
    const line = mergePostureLine('when-green', 'full', null);
    expect(line).toContain('merges without asking you, the default for the medium tier under full');
    expect(line).toContain('approve or comment');
  });

  it('leaves a comment verdict to the operator and asks before each merge under ratify', () => {
    const line = mergePostureLine('when-green', 'ratify', null);
    expect(line).toContain(
      'asks you before each merge, the default for the medium tier under ratify',
    );
    expect(line).toContain('A comment verdict leaves the merge to you');
    expect(line).not.toContain('approve or comment');
  });

  it('asks before each merge under full where the write policy gates the medium tier', () => {
    const line = mergePostureLine('when-green', 'full', GATE_MEDIUM);
    expect(line).toContain(
      'asks you before each merge, as this space’s write policy sets the medium tier',
    );
    expect(line).not.toContain('without asking you');
    expect(line).toContain('approve or comment');
  });

  it('merges unasked under ratify where the write policy allows the medium tier', () => {
    const line = mergePostureLine('when-green', 'ratify', ALLOW_MEDIUM);
    expect(line).toContain(
      'merges without asking you, as this space’s write policy sets the medium tier',
    );
    expect(line).not.toContain('asks you before each merge');
    expect(line).toContain('A comment verdict leaves the merge to you');
  });

  it('follows the autonomy default where the write policy sets another tier only', () => {
    const line = mergePostureLine('when-green', 'full', { requireApprovalByTier: { high: true } });
    expect(line).toContain('the default for the medium tier under full');
  });
});
