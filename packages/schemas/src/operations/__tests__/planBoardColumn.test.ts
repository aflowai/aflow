/**
 * The board's column rule (Plan 332 D4): every row of its order, first match
 * deciding, and the walk that tells it whether a closed node lies above.
 */
import { describe, expect, it } from 'vitest';
import {
  planBoardCards,
  planBoardColumn,
  type PlanNodeActivity,
  type PlanNodeKind,
  type PlanNodeStatus,
  type PlanTreeNode,
} from '../../index.js';

function at(
  status: PlanNodeStatus,
  activity: PlanNodeActivity = 'idle',
  kind: PlanNodeKind = 'execute',
) {
  return { kind, status, activity };
}

const open = { closedAncestor: false };
const stranded = { closedAncestor: true };

describe('planBoardColumn', () => {
  it('reads done and dropped as their own columns, whatever lies above or runs', () => {
    expect(planBoardColumn(at('done', 'in_flight'), stranded)).toEqual({ column: 'done' });
    expect(planBoardColumn(at('dropped'), stranded)).toEqual({ column: 'dropped' });
    expect(planBoardColumn(at('done', 'idle', 'decide'), open)).toEqual({ column: 'done' });
  });

  it('reads an open step under a closed ancestor as Needs you, stranded, before anything else', () => {
    for (const status of ['active', 'blocked', 'waiting'] as const) {
      expect(planBoardColumn(at(status), stranded)).toEqual({
        column: 'needs_you',
        reason: 'stranded',
      });
    }
    expect(planBoardColumn(at('active', 'in_flight', 'decide'), stranded)).toEqual({
      column: 'needs_you',
      reason: 'stranded',
    });
  });

  it('reads an open decide node as Needs you, a decision, even with a child running', () => {
    expect(planBoardColumn(at('active', 'idle', 'decide'), open)).toEqual({
      column: 'needs_you',
      reason: 'decide',
    });
    expect(planBoardColumn(at('active', 'in_flight', 'decide'), open)).toEqual({
      column: 'needs_you',
      reason: 'decide',
    });
  });

  it('reads a blocked step as Needs you, blocked, even with a run in flight', () => {
    expect(planBoardColumn(at('blocked'), open)).toEqual({
      column: 'needs_you',
      reason: 'blocked',
    });
    expect(planBoardColumn(at('blocked', 'in_flight'), open)).toEqual({
      column: 'needs_you',
      reason: 'blocked',
    });
  });

  it('reads a waiting step as In flight with or without a run, and an active one with a run', () => {
    expect(planBoardColumn(at('waiting'), open)).toEqual({ column: 'in_flight' });
    expect(planBoardColumn(at('waiting', 'in_flight'), open)).toEqual({ column: 'in_flight' });
    expect(planBoardColumn(at('active', 'in_flight'), open)).toEqual({ column: 'in_flight' });
  });

  it('reads an idle active step as Up next', () => {
    expect(planBoardColumn(at('active'), open)).toEqual({ column: 'up_next' });
  });
});

function node(nodeId: string, extra: Partial<PlanTreeNode> = {}): PlanTreeNode {
  return {
    nodeId,
    parentId: null,
    kind: 'execute',
    title: nodeId,
    status: 'active',
    revision: 1,
    position: 0,
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
    goalHead: '',
    counts: { runs: 0, pullRequests: 0, findings: 0, documents: 0, inFlightRuns: 0 },
    rounds: 0,
    activity: 'idle',
    children: [],
    ...extra,
  };
}

describe('planBoardCards', () => {
  it('places every node under the root in walk order, an open step two levels under a closed one stranded', () => {
    const root = node('root', {
      children: [
        node('P6', {
          status: 'done',
          children: [
            node('P6.a', {
              children: [node('P6.a.1', { status: 'blocked' })],
            }),
          ],
        }),
        node('P7', {
          activity: 'in_flight',
          children: [node('decide', { kind: 'decide', activity: 'in_flight' }), node('queued')],
        }),
      ],
    });

    expect(
      planBoardCards(root).map((c) => [c.node.nodeId, c.column, c.reason, c.phase?.nodeId]),
    ).toEqual([
      ['P6', 'done', undefined, undefined],
      ['P6.a', 'needs_you', 'stranded', 'P6'],
      ['P6.a.1', 'needs_you', 'stranded', 'P6'],
      ['P7', 'in_flight', undefined, undefined],
      ['decide', 'needs_you', 'decide', 'P7'],
      ['queued', 'up_next', undefined, 'P7'],
    ]);
  });

  it('reads every open step under a closed root as stranded', () => {
    const root = node('root', { status: 'done', children: [node('left open')] });

    expect(planBoardCards(root).map((c) => [c.column, c.reason])).toEqual([
      ['needs_you', 'stranded'],
    ]);
  });
});
