/**
 * A proposal says who proposed it, from which conversation, and why. A Coach
 * review and an agent's patch are told apart, and a proposal its author took
 * back says so.
 */
import { describe, expect, it } from 'vitest';
import {
  WITHDRAWN_BY_AUTHOR,
  describeProposalProvenance,
  groupBySource,
  proposalByline,
} from './proposal-provenance';
import { UNTITLED_CONVERSATION } from './conversation-title';

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('describeProposalProvenance', () => {
  it('names an agent patch, the conversation it came from and a link to it', () => {
    const view = describeProposalProvenance({
      provenance: {
        source: 'agent_patch',
        conversation: { sessionId: SESSION, title: 'Commission change review' },
      },
      status: 'proposed',
    });
    expect(view).toEqual({
      byline: 'Patched by the Helmsman',
      conversation: {
        title: 'Commission change review',
        path: `/chat?session=${SESSION}`,
      },
      withdrawn: null,
    });
  });

  it('tells each source apart in words', () => {
    expect(proposalByline('agent_patch')).toBe('Patched by the Helmsman');
    expect(proposalByline('compose_skill')).toBe('Composed from a request');
    expect(proposalByline('coach')).toBe('Proposed by the Coach after a review');
  });

  it('names a conversation that has no title yet as its list does', () => {
    const view = describeProposalProvenance({
      provenance: { source: 'coach', conversation: { sessionId: SESSION, title: null } },
      status: 'proposed',
    });
    expect(view?.conversation?.title).toBe(UNTITLED_CONVERSATION);
  });

  it('leaves the link out when no conversation holds the proposing session', () => {
    const view = describeProposalProvenance({
      provenance: { source: 'compose_skill', conversation: null },
      status: 'proposed',
    });
    expect(view?.byline).toBe('Composed from a request');
    expect(view?.conversation).toBeNull();
  });

  it('says a withdrawn proposal was withdrawn by its author, with the reason given', () => {
    const provenance = { source: 'agent_patch' as const, conversation: null };
    expect(describeProposalProvenance({ provenance, status: 'withdrawn' })?.withdrawn).toBe(
      WITHDRAWN_BY_AUTHOR,
    );
    expect(
      describeProposalProvenance({
        provenance,
        status: 'withdrawn',
        withdrawReason: 'The operator changed the plan.',
      })?.withdrawn,
    ).toBe('Withdrawn by its author: The operator changed the plan.');
    expect(describeProposalProvenance({ provenance, status: 'proposed' })?.withdrawn).toBeNull();
  });
});

describe('groupBySource', () => {
  it('puts a Coach review and an agent patch under different headings', () => {
    const items = [
      { id: 'a', heading: 'Coach' },
      { id: 'b', heading: 'Helmsman' },
      { id: 'c', heading: 'Coach' },
    ];
    expect(groupBySource(items, (item) => item.heading)).toEqual([
      { heading: 'Coach', items: [items[0], items[2]] },
      { heading: 'Helmsman', items: [items[1]] },
    ]);
  });
});
