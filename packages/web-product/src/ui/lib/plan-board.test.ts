/**
 * What the plan board derives from the tree (Plan 322 P3.3, Plan 332 D4):
 * each card's column, reason and phase in walk order, the header, the Phase
 * filter, and the Done column folded by day.
 */
import { describe, expect, it } from 'vitest';
import type { PlanRootRow, PlanRootState, PlanTreeNode } from '@aflow/schemas';
import {
  NEEDS_YOU_REASON_LABEL,
  PLAN_BOARD_COLUMNS,
  addDays,
  doneCardsSince,
  doneGroupOf,
  phaseLabel,
  planBoardFiltered,
  planCardMatches,
  planCards,
  planDoneFolds,
  planDoneGroups,
  planHeader,
  planLandingRoot,
  planListSections,
  planPhases,
  planRowMoveTargets,
  planRowProgress,
  planViewQuery,
  showsPhaseFilter,
  waitingLine,
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
          node('blocked', { status: 'blocked', activity: 'in_flight' }),
          node('done', { status: 'done', children: [node('left open')] }),
          node('dropped', { status: 'dropped' }),
          node('queued'),
        ],
      }),
      node('loose', { activity: 'in_flight' }),
    ],
  });

  it('lists every node under the root in walk order, never the root, with its column, reason and phase', () => {
    const cards = planCards(root);

    expect(cards.map((c) => [c.node.nodeId, c.column, c.reason, c.phase?.nodeId])).toEqual([
      ['P3 — board', 'up_next', undefined, undefined],
      ['waiting', 'in_flight', undefined, 'P3 — board'],
      ['decide', 'needs_you', 'decide', 'P3 — board'],
      ['blocked', 'needs_you', 'blocked', 'P3 — board'],
      ['done', 'done', undefined, 'P3 — board'],
      ['left open', 'needs_you', 'stranded', 'P3 — board'],
      ['dropped', 'dropped', undefined, 'P3 — board'],
      ['queued', 'up_next', undefined, 'P3 — board'],
      ['loose', 'in_flight', undefined, undefined],
    ]);
  });

  it('orders the columns by what they ask of the reader, Needs you first', () => {
    expect(PLAN_BOARD_COLUMNS.map((c) => [c.id, c.label])).toEqual([
      ['needs_you', 'Needs you'],
      ['in_flight', 'In flight'],
      ['up_next', 'Up next'],
      ['done', 'Done'],
      ['dropped', 'Dropped'],
    ]);
    expect(Object.values(NEEDS_YOU_REASON_LABEL)).toEqual([
      'Decision',
      'Blocked',
      'Under a closed step',
    ]);
  });

  it('filters by phase — the phase and what sits under it', () => {
    const cards = planCards(root);
    const ids = (filters: Parameters<typeof planCardMatches>[1]) =>
      cards.filter((c) => planCardMatches(c, filters)).map((c) => c.node.nodeId);

    expect(ids({ phaseId: 'P3 — board' })).not.toContain('loose');
    expect(ids({ phaseId: 'P3 — board' })).toContain('P3 — board');
    expect(ids({})).toHaveLength(cards.length);
  });

  it('offers the Phase filter only where the plan has two or more phases', () => {
    expect(planPhases(root).map((p) => p.nodeId)).toEqual(['P3 — board']);
    expect(showsPhaseFilter(planPhases(root))).toBe(false);
    const two = node('root', {
      children: [...root.children, node('P4', { children: [node('x')] })],
    });
    expect(showsPhaseFilter(planPhases(two))).toBe(true);
  });

  it('says what holds a waiting step: its run, or the loop yet to advance it', () => {
    const counts = { runs: 1, pullRequests: 0, findings: 0, documents: 0, inFlightRuns: 0 };
    expect(waitingLine(node('w', { status: 'waiting', counts }))).toBe(
      'Its run ended; the loop advances it when it returns',
    );
    expect(
      waitingLine(node('w', { status: 'waiting', counts: { ...counts, inFlightRuns: 1 } })),
    ).toBe('A run is on it');
    expect(waitingLine(node('a'))).toBeUndefined();
  });
});

describe('planHeader', () => {
  it('reads the steps closed of all, and only the columns that hold any', () => {
    expect(
      planHeader({
        rootId: 'r',
        state: 'needs_you',
        steps: 10,
        needsYou: 1,
        inFlight: 0,
        upNext: 4,
        done: 3,
        dropped: 2,
        doneByDay: [],
      }),
    ).toEqual({
      state: 'Needs you',
      progress: '5 of 10 closed',
      counts: [
        { column: 'needs_you', label: '1 needs you' },
        { column: 'up_next', label: '4 up next' },
        { column: 'done', label: '3 done' },
        { column: 'dropped', label: '2 dropped' },
      ],
    });
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
    expect(planDoneGroups(doneByDay, today)).toEqual([
      { id: 'today', label: 'Today', count: 2, from: '2026-10-22', to: '2026-10-22' },
      { id: 'yesterday', label: 'Yesterday', count: 1, from: '2026-10-21', to: '2026-10-21' },
      { id: '2026-10', label: 'Oct 5 – 20', count: 50, from: '2026-10-05', to: '2026-10-20' },
      { id: '2026-09', label: 'Sep 3 – 28', count: 4, from: '2026-09-03', to: '2026-09-28' },
    ]);
  });

  it('folds nothing where nothing is done', () => {
    expect(planDoneGroups([], today)).toEqual([]);
  });

  it('reads done cards from the first day of the oldest fold open, today’s with none', () => {
    const groups = planDoneGroups(doneByDay, today);

    expect(doneCardsSince(groups, new Set(['today']), today)).toBe(today);
    expect(doneCardsSince(groups, new Set(['today', '2026-10']), today)).toBe('2026-10-05');
    expect(doneCardsSince(groups, new Set(), today)).toBe(today);
  });

  it('reads every fold’s done cards under a filter, open or not', () => {
    const groups = planDoneGroups(doneByDay, today);

    expect(doneCardsSince(groups, new Set(['today']), today, true)).toBe('2026-09-03');
    expect(doneCardsSince(groups, new Set(), today, true)).toBe('2026-09-03');
    expect(doneCardsSince(planDoneGroups([], today), new Set(), today, true)).toBe(today);
  });

  describe('a fold’s count', () => {
    const groups = planDoneGroups(doneByDay, today);
    const phases = { P1: node('P1'), P2: node('P2') };
    const closed = (id: string, at: Date, phase: keyof typeof phases) => ({
      node: node(id, { status: 'done', closedAt: at.toISOString() }),
      column: 'done' as const,
      phase: phases[phase],
    });
    const cards = [
      closed('a', new Date(2026, 9, 22, 9), 'P1'),
      closed('b', new Date(2026, 9, 22, 10), 'P2'),
      closed('c', new Date(2026, 9, 12, 10), 'P1'),
      closed('d', new Date(2026, 9, 6, 10), 'P1'),
      closed('e', new Date(2026, 8, 28, 10), 'P2'),
    ];
    const inP1 = cards.filter((c) => planCardMatches(c, { phaseId: 'P1' }));
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
      expect(planBoardFiltered({})).toBe(false);
      expect(planBoardFiltered({ phaseId: 'p' })).toBe(true);

      expect(shown(planDoneFolds(groups, inP1, true, '2026-09-03'))).toEqual([
        ['today', 1, ['a']],
        ['yesterday', 0, []],
        ['2026-10', 2, ['c', 'd']],
        ['2026-09', 0, []],
      ]);
    });

    it('shows no count for a fold the tree on screen was not read far enough to hold', () => {
      const folds = planDoneFolds(groups, inP1, true, today);

      expect(folds.map((f) => f.shown)).toEqual([1, undefined, undefined, undefined]);
      expect(planDoneFolds(groups, inP1, true, undefined).every((f) => f.shown === undefined)).toBe(
        true,
      );
    });
  });

  it('places a done card in the fold of the reader’s day it closed', () => {
    const groups = planDoneGroups(doneByDay, today);
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

function row(nodeId: string, state: PlanRootState, extra: Partial<PlanRootRow> = {}): PlanRootRow {
  return {
    nodeId,
    title: nodeId,
    status: state === 'closed' ? 'done' : 'active',
    position: 0,
    revision: 1,
    state,
    counts: { steps: 4, needsYou: 0, inFlight: 0, upNext: 0, done: 1, dropped: 1 },
    lastWrittenAt: '2026-10-05T08:00:00.000Z',
    ...extra,
  };
}

describe('the plan list (Plan 332 D2)', () => {
  const rows = [
    row('finished-first', 'finished'),
    row('closed', 'closed'),
    row('needs', 'needs_you'),
    row('empty', 'empty'),
    row('finished-second', 'finished'),
    row('queued', 'queued'),
  ];

  it('keeps open plans in position order and puts finished and closed ones below', () => {
    const sections = planListSections(rows);
    expect(sections.open.map((r) => r.nodeId)).toEqual(['needs', 'empty', 'queued']);
    expect(sections.finished.map((r) => r.nodeId)).toEqual(['finished-first', 'finished-second']);
    expect(sections.closed.map((r) => r.nodeId)).toEqual(['closed']);
  });

  it('lands on the first open plan, else the first finished, else the first closed', () => {
    expect(planLandingRoot(rows)?.nodeId).toBe('needs');
    expect(planLandingRoot([row('c', 'closed'), row('f', 'finished')])?.nodeId).toBe('f');
    expect(planLandingRoot([row('c', 'closed')])?.nodeId).toBe('c');
    expect(planLandingRoot([])).toBeUndefined();
  });

  it('reads progress as steps closed of all', () => {
    expect(planRowProgress(row('a', 'queued'))).toBe('2/4');
  });

  it('moves an open plan past the open row beside it, and offers no way out of the ends', () => {
    const open = planListSections(rows).open;
    expect(planRowMoveTargets(open, 'needs')).toEqual({ below: open[1] });
    expect(planRowMoveTargets(open, 'empty')).toEqual({ above: open[0], below: open[2] });
    expect(planRowMoveTargets(open, 'queued')).toEqual({ above: open[1] });
    expect(planRowMoveTargets(open, 'finished-first')).toEqual({});
  });

  it('writes the plan and the step into the URL, keeping every other parameter', () => {
    expect(planViewQuery('', { plan: 'r1' })).toBe('plan=r1');
    expect(planViewQuery('plan=r1', { plan: 'r1', node: 'n2' })).toBe('plan=r1&node=n2');
    expect(planViewQuery('plan=r1&node=n2&x=1', { plan: 'r3' })).toBe('plan=r3&x=1');
    expect(planViewQuery('node=n2', {})).toBe('');
  });
});
