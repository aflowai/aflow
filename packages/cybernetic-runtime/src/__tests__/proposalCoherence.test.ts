/**
 * Supersession coherence: a platform_issue and a
 * still-open workflow_refinement citing the same failing task cannot both
 * stand — the refinement is a superseded approximation.
 */
import { describe, expect, it } from 'vitest';
import { findSupersededRefinements } from '../proposalCoherence.js';

const refinement = (
  over: Partial<Parameters<typeof findSupersededRefinements>[0][number]> = {},
) => ({
  id: 'ref-1',
  kind: 'workflow_refinement',
  status: 'proposed',
  targetSlug: 'market-briefing',
  citedTaskIds: ['render-card'],
  ...over,
});
const platformIssue = (
  over: Partial<Parameters<typeof findSupersededRefinements>[0][number]> = {},
) => ({
  id: 'pi-1',
  kind: 'platform_issue',
  status: 'proposed',
  targetSlug: 'market-briefing',
  citedTaskIds: ['render-card'],
  ...over,
});

describe('findSupersededRefinements', () => {
  it('matches same slug + shared cited task', () => {
    const out = findSupersededRefinements([refinement(), platformIssue()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      refinementId: 'ref-1',
      platformIssueId: 'pi-1',
      sharedTaskIds: ['render-card'],
    });
  });

  it('no match across different slugs or disjoint tasks', () => {
    expect(
      findSupersededRefinements([refinement(), platformIssue({ targetSlug: 'other-skill' })]),
    ).toHaveLength(0);
    expect(
      findSupersededRefinements([refinement(), platformIssue({ citedTaskIds: ['submit-call'] })]),
    ).toHaveLength(0);
  });

  it('withdrawn/resolved refinements and citation-less proposals are ignored', () => {
    expect(
      findSupersededRefinements([refinement({ status: 'withdrawn' }), platformIssue()]),
    ).toHaveLength(0);
    expect(
      findSupersededRefinements([refinement({ citedTaskIds: [] }), platformIssue()]),
    ).toHaveLength(0);
  });
});
