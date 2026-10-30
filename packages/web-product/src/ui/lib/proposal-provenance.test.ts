/**
 * A proposal card shows where a proposal came from as labelled lines, one
 * per field, derived from the record. A patch on any skill, a Coach review, a
 * composed skill and a platform issue all render through the same path.
 */
import { describe, expect, it } from 'vitest';
import {
  describeProposalProvenance,
  groupBySource,
  type ProposalProvenance,
} from './proposal-provenance';

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const WHEN = '2026-10-30T09:00:00.000Z';
const formatWhen = (iso: string) => `at ${iso}`;

function provenance(overrides: Partial<ProposalProvenance>): ProposalProvenance {
  return {
    source: 'agent_patch',
    sourceLabel: 'Helmsman patch',
    conversation: { sessionId: SESSION, title: 'Coastal storm warnings' },
    authorRole: 'Helmsman',
    authorId: SESSION,
    target: { slug: 'coastal-weather-alerts', name: 'Coastal weather alerts' },
    withdrawnBy: null,
    ...overrides,
  };
}

function lines(
  p: ProposalProvenance | undefined,
  extra: { status?: string; withdrawReason?: string } = {},
) {
  return describeProposalProvenance({
    provenance: p,
    rationale: 'The alert went out after the storm had passed.',
    proposedAt: WHEN,
    status: extra.status ?? 'proposed',
    withdrawReason: extra.withdrawReason,
    formatWhen,
  });
}

describe('describeProposalProvenance', () => {
  it('shows a Helmsman patch on a weather skill as five labelled lines', () => {
    expect(lines(provenance({}))).toEqual([
      {
        label: 'Created by',
        text: 'Coastal storm warnings',
        path: `/chat?session=${SESSION}`,
      },
      { label: 'Source', text: 'Helmsman patch' },
      { label: 'Reason', text: 'The alert went out after the storm had passed.' },
      { label: 'When', text: `at ${WHEN}` },
      { label: 'Target', text: 'Coastal weather alerts' },
    ]);
  });

  it('shows a Coach review through the same path, with the same labels', () => {
    const review = provenance({
      source: 'coach',
      sourceLabel: 'Coach review',
      conversation: { sessionId: SESSION, title: 'Review of run 7f3e' },
      authorRole: 'Coach',
    });
    expect(lines(review).map((entry) => `${entry.label}: ${entry.text}`)).toEqual([
      'Created by: Review of run 7f3e',
      'Source: Coach review',
      'Reason: The alert went out after the storm had passed.',
      `When: at ${WHEN}`,
      'Target: Coastal weather alerts',
    ]);
  });

  it('labels a composed skill and a platform issue by their source', () => {
    const composed = provenance({ source: 'compose_skill', sourceLabel: 'Composed skill' });
    const issue = provenance({ source: 'coach', sourceLabel: 'Platform issue' });
    expect(lines(composed)[1]).toEqual({ label: 'Source', text: 'Composed skill' });
    expect(lines(issue)[1]).toEqual({ label: 'Source', text: 'Platform issue' });
  });

  it('falls back from the title to the role name, then to the id', () => {
    const untitled = provenance({ conversation: { sessionId: SESSION, title: null } });
    expect(lines(untitled)[0]).toEqual({
      label: 'Created by',
      text: 'Helmsman',
      path: `/chat?session=${SESSION}`,
    });
    const noRole = provenance({ conversation: null, authorRole: null, authorId: 'run-7f3e' });
    expect(lines(noRole)[0]).toEqual({ label: 'Created by', text: 'run-7f3e' });
  });

  it('shows the slug as the target when the space no longer lists the skill', () => {
    const p = provenance({ target: { slug: 'coastal-weather-alerts', name: null } });
    expect(lines(p).at(-1)).toEqual({ label: 'Target', text: 'coastal-weather-alerts' });
  });

  it('names who withdrew it, which need not be the author', () => {
    const p = provenance({ withdrawnBy: 'Coach' });
    const withdrawn = lines(p, { status: 'withdrawn', withdrawReason: 'Superseded by a fix.' });
    expect(withdrawn.slice(-2)).toEqual([
      { label: 'Withdrawn by', text: 'Coach' },
      { label: 'Withdrawal reason', text: 'Superseded by a fix.' },
    ]);
    expect(lines(p).some((entry) => entry.label === 'Withdrawn by')).toBe(false);
  });

  it('writes no sentence about the proposal, only labelled fields', () => {
    for (const entry of lines(provenance({}))) {
      expect(['Created by', 'Source', 'Reason', 'When', 'Target']).toContain(entry.label);
    }
  });
});

describe('groupBySource', () => {
  it('puts a Coach review and a Helmsman patch under different headings', () => {
    const items = [
      { id: 'a', heading: 'Coach review' },
      { id: 'b', heading: 'Helmsman patch' },
      { id: 'c', heading: 'Coach review' },
    ];
    expect(groupBySource(items, (item) => item.heading)).toEqual([
      { heading: 'Coach review', items: [items[0], items[2]] },
      { heading: 'Helmsman patch', items: [items[1]] },
    ]);
  });
});
