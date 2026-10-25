/**
 * What the plan board derives from the tree (Plan 322 P3.3): each card's
 * column and phase, the filters, and the Done column folded by day.
 */
import { describe, expect, it } from 'vitest';
import type { PlanTreeNode } from '@aflow/schemas';
import {
  addDays,
  doneCardsSince,
  doneGroupOf,
  phaseLabel,
  planBoardFiltered,
  planCardMatches,
  planCards,
  planDoneFolds,
  planDoneGroups,
  pullRequestLabel,
  runKindLabel,
  runLinkStatus,
  startOfDay,
} from './plan-board.js';

function node(nodeId: string, extra: Partial<PlanTreeNode> = {}): PlanTreeNode {
  return {
    nodeId,
    parentId: null,
    kind: 'execute',
    title: nodeId,
    status: 'active',
    revision: 1,
    position: 0,
    updatedAt: '2026-10-05T08:00:00.000Z',
    createdAt: '2026-10-05T08:00:00.000Z',
    goalHead: '',
    counts: { runs: 1, pullRequests: 0, findings: 0, documents: 0, inFlightRuns: 0 },
    rounds: 0,
    activity: 'idle',
    children: [],
    ...extra,
  };
}

describe('planCards', () => {
  const root = node('root', {
    children: [
      node('P3 — board', {
        children: [
          node('waiting', { status: 'waiting' }),
          node('decide', { kind: 'decide' }),
          node('blocked', { status: 'blocked' }),
          node('done', { status: 'done' }),
          node('dropped', { status: 'dropped' }),
        ],
      }),
      node('loose', { activity: 'in_flight' }),
    ],
  });

  it('lists every node under the root, never the root, with its column and the phase it sits under', () => {
    const cards = planCards(root);

    expect(cards.map((c) => [c.node.nodeId, c.column, c.phase?.nodeId])).toEqual([
      ['P3 — board', 'progress', undefined],
      ['waiting', 'next', 'P3 — board'],
      ['decide', 'decide', 'P3 — board'],
      ['blocked', 'decide', 'P3 — board'],
      ['done', 'done', 'P3 — board'],
      ['dropped', 'dropped', 'P3 — board'],
      ['loose', 'progress', undefined],
    ]);
  });

  it('filters by phase — the phase and what sits under it — and by activity', () => {
    const cards = planCards(root);
    const ids = (filters: Parameters<typeof planCardMatches>[1]) =>
      cards.filter((c) => planCardMatches(c, filters)).map((c) => c.node.nodeId);

    expect(ids({ phaseId: 'P3 — board', activity: 'all' })).not.toContain('loose');
    expect(ids({ phaseId: 'P3 — board', activity: 'all' })).toContain('P3 — board');
    expect(ids({ activity: 'in_flight' })).toEqual(['loose']);
    expect(ids({ activity: 'idle' })).not.toContain('loose');
  });
});

describe('phaseLabel', () => {
  it('reads a phase by the code its title leads with, else its title cut short', () => {
    expect(phaseLabel('P3 — Seen by the operator')).toBe('P3');
    expect(phaseLabel('P2b the stream wakes itself')).toBe('P2b');
    expect(phaseLabel('P3.3: the board')).toBe('P3.3');
    expect(phaseLabel('Setup')).toBe('Setup');
    expect(phaseLabel('A phase with a long name')).toBe('A phase with…');
  });
});

describe('the Done column folded by day', () => {
  const today = '2026-10-22';
  const doneByDay = [
    { day: '2026-10-22', count: 2 },
    { day: '2026-10-21', count: 1 },
    { day: '2026-10-20', count: 30 },
    { day: '2026-10-05', count: 20 },
    { day: '2026-09-28', count: 3 },
    { day: '2026-09-03', count: 1 },
  ];

  it('folds today, yesterday, and each earlier month as one range with its count', () => {
    expect(planDoneGroups(doneByDay, today, 'all')).toEqual([
      { id: 'today', label: 'Today', count: 2, from: '2026-10-22', to: '2026-10-22' },
      { id: 'yesterday', label: 'Yesterday', count: 1, from: '2026-10-21', to: '2026-10-21' },
      { id: '2026-10', label: 'Oct 5 – 20', count: 50, from: '2026-10-05', to: '2026-10-20' },
      { id: '2026-09', label: 'Sep 3 – 28', count: 4, from: '2026-09-03', to: '2026-09-28' },
    ]);
  });

  it('counts only the days the done window shows', () => {
    expect(planDoneGroups(doneByDay, today, 'today').map((g) => g.label)).toEqual(['Today']);
    expect(planDoneGroups(doneByDay, today, 'week')).toEqual([
      expect.objectContaining({ id: 'today', count: 2 }),
      expect.objectContaining({ id: 'yesterday', count: 1 }),
      { id: '2026-10', label: 'Oct 20', count: 30, from: '2026-10-20', to: '2026-10-20' },
    ]);
    expect(planDoneGroups([], today, 'all')).toEqual([]);
  });

  it('reads done cards from the first day of the oldest fold open, today’s with none', () => {
    const groups = planDoneGroups(doneByDay, today, 'all');

    expect(doneCardsSince(groups, new Set(['today']), today)).toBe(today);
    expect(doneCardsSince(groups, new Set(['today', '2026-10']), today)).toBe('2026-10-05');
    expect(doneCardsSince(groups, new Set(), today)).toBe(today);
  });

  it('reads every fold’s done cards under a filter, open or not', () => {
    const groups = planDoneGroups(doneByDay, today, 'all');

    expect(doneCardsSince(groups, new Set(['today']), today, true)).toBe('2026-09-03');
    expect(doneCardsSince(groups, new Set(), today, true)).toBe('2026-09-03');
    expect(doneCardsSince(planDoneGroups([], today, 'all'), new Set(), today, true)).toBe(today);
  });

  describe('a fold’s count', () => {
    const groups = planDoneGroups(doneByDay, today, 'all');
    const closed = (id: string, at: Date, activity: 'in_flight' | 'idle') => ({
      node: node(id, { status: 'done', closedAt: at.toISOString(), activity }),
      column: 'done' as const,
    });
    const cards = [
      closed('a', new Date(2026, 9, 22, 9), 'idle'),
      closed('b', new Date(2026, 9, 22, 10), 'in_flight'),
      closed('c', new Date(2026, 9, 12, 10), 'idle'),
      closed('d', new Date(2026, 9, 6, 10), 'idle'),
      closed('e', new Date(2026, 8, 28, 10), 'in_flight'),
    ];
    const idleOnly = cards.filter((c) => planCardMatches(c, { activity: 'idle' }));
    const shown = (folds: ReturnType<typeof planDoneFolds>) =>
      folds.map((f) => [f.id, f.shown, f.cards.map((c) => c.node.nodeId)]);

    it('is the plan’s own count unfiltered, whatever the tree holds', () => {
      expect(shown(planDoneFolds(groups, [], false, today))).toEqual([
        ['today', 2, []],
        ['yesterday', 1, []],
        ['2026-10', 50, []],
        ['2026-09', 4, []],
      ]);
    });

    it('counts the matching cards under a filter, not the unfiltered count and not zero', () => {
      expect(planBoardFiltered({ activity: 'idle' })).toBe(true);
      expect(planBoardFiltered({ activity: 'all' })).toBe(false);
      expect(planBoardFiltered({ phaseId: 'p', activity: 'all' })).toBe(true);

      expect(shown(planDoneFolds(groups, idleOnly, true, '2026-09-03'))).toEqual([
        ['today', 1, ['a']],
        ['yesterday', 0, []],
        ['2026-10', 2, ['c', 'd']],
        ['2026-09', 0, []],
      ]);
    });

    it('shows no count for a fold the tree on screen was not read far enough to hold', () => {
      const folds = planDoneFolds(groups, idleOnly, true, today);

      expect(folds.map((f) => f.shown)).toEqual([1, undefined, undefined, undefined]);
      expect(
        planDoneFolds(groups, idleOnly, true, undefined).every((f) => f.shown === undefined),
      ).toBe(true);
    });
  });

  it('places a done card in the fold of the reader’s day it closed', () => {
    const groups = planDoneGroups(doneByDay, today, 'all');
    const closed = (at: Date) => ({
      node: node('n', { status: 'done', closedAt: at.toISOString() }),
      column: 'done' as const,
    });

    expect(doneGroupOf(closed(new Date(2026, 9, 22, 0, 30)), groups)?.id).toBe('today');
    expect(doneGroupOf(closed(new Date(2026, 9, 12, 23, 30)), groups)?.id).toBe('2026-10');
    expect(doneGroupOf(closed(new Date(2026, 7, 1)), groups)).toBeUndefined();
  });

  it('moves days across a month and starts a day at the reader’s midnight', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2026-10-22', -6)).toBe('2026-10-16');
    expect(new Date(startOfDay('2026-10-22')).getHours()).toBe(0);
  });
});

describe('labels', () => {
  it('reads a pull request by its number and a run by its kind and status', () => {
    expect(pullRequestLabel('https://github.com/aflowai/aflow/pull/181')).toBe('#181');
    expect(runKindLabel('commission-change completed')).toBe('Commission');
    expect(runKindLabel('review-local-changes')).toBe('Review');
    expect(runKindLabel('my-skill failed')).toBe('my-skill');
    expect(runKindLabel(undefined)).toBe('Run');
    expect(runLinkStatus('publish-local-changes failed')).toBe('failed');
    expect(runLinkStatus(undefined)).toBeUndefined();
  });
});
