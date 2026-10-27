/**
 * Plan 331 D7 — the three numbers, computed from the records a window holds:
 * operator actions per merged pull request, each node's idle time from when it
 * became actionable to its first commission, and each node's cost with the
 * resident's wakes beside it.
 */
import { describe, expect, it } from 'vitest';
import { PlanLoopMeasureOutputSchema } from '@aflow/schemas';
import { measurePlanLoop, planLoopWindow, type PlanLoopFacts } from '../plan/loopMeasure.js';

const ROOT = '00000000-0000-4000-8000-000000000001';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const at = (iso: string) => new Date(iso);
const window = { from: at('2026-10-23T16:00:00Z'), to: at('2026-10-26T07:00:00Z') };

function facts(extra: Partial<PlanLoopFacts> = {}): PlanLoopFacts {
  return {
    helmsmanMessages: 0,
    actionCenterByKind: {},
    planCloses: 0,
    planOpens: 0,
    scheduleWrites: 0,
    mergedPullRequests: 0,
    nodes: [
      {
        nodeId: ROOT,
        parentId: null,
        title: 'Plan 331',
        position: 0,
        createdAt: at('2026-10-20T00:00:00Z'),
        closedAt: null,
      },
      {
        nodeId: A,
        parentId: ROOT,
        title: 'P1.a',
        position: 0,
        createdAt: at('2026-10-20T00:00:00Z'),
        closedAt: at('2026-10-24T02:00:00Z'),
      },
      {
        nodeId: B,
        parentId: ROOT,
        title: 'P1.b',
        position: 1,
        createdAt: at('2026-10-20T00:00:00Z'),
        closedAt: null,
      },
      {
        nodeId: C,
        parentId: ROOT,
        title: 'P1.c',
        position: 2,
        createdAt: at('2026-10-20T00:00:00Z'),
        closedAt: null,
      },
    ],
    opens: [],
    firstCommissions: [],
    nodeRuns: [],
    wakes: { sessions: 0, cents: 0 },
    ...extra,
  };
}

describe('the loop’s numbers (Plan 331 D7)', () => {
  it('reads zero operator actions over a weekend in which approved nodes landed', () => {
    const measure = measurePlanLoop(
      facts({ mergedPullRequests: 3, wakes: { sessions: 120, cents: 900 } }),
      window,
    );
    expect(PlanLoopMeasureOutputSchema.safeParse(measure).success).toBe(true);
    expect(measure.operatorActions.total).toBe(0);
    expect(measure.actionsPerMergedPullRequest).toBe(0);
    expect(measure.cost.wakes).toEqual({
      sessions: 120,
      cents: 900,
      centsPerMergedPullRequest: 300,
    });
  });

  it('counts every kind of operator act, divided by the pull requests merged', () => {
    const measure = measurePlanLoop(
      facts({
        helmsmanMessages: 2,
        actionCenterByKind: { write_approval: 1, workflow_run_paused: 2 },
        planCloses: 1,
        planOpens: 3,
        scheduleWrites: 1,
        mergedPullRequests: 2,
      }),
      window,
    );
    expect(measure.operatorActions).toMatchObject({
      total: 10,
      actionCenter: { total: 3 },
      planWrites: { close: 1, open: 3 },
    });
    expect(measure.actionsPerMergedPullRequest).toBe(5);
    expect(measurePlanLoop(facts(), window).actionsPerMergedPullRequest).toBeNull();
  });

  it('measures idle time from the latest of approval and the predecessor’s close to the first commission', () => {
    const measure = measurePlanLoop(
      facts({
        opens: [{ nodeId: C, at: at('2026-10-25T09:00:00Z') }],
        firstCommissions: [
          { nodeId: B, at: at('2026-10-24T02:15:00Z') },
          { nodeId: C, at: at('2026-10-25T09:30:00Z') },
        ],
      }),
      window,
    );
    expect(measure.idle).toEqual([
      expect.objectContaining({
        nodeId: C,
        actionableAt: '2026-10-25T09:00:00.000Z',
        idleMs: 30 * 60_000,
      }),
      expect.objectContaining({
        nodeId: B,
        actionableAt: '2026-10-24T02:00:00.000Z',
        idleMs: 15 * 60_000,
      }),
    ]);
  });

  it('costs each node’s runs, dearest first', () => {
    const measure = measurePlanLoop(
      facts({
        nodeRuns: [
          { nodeId: A, runs: 2, cents: 120 },
          { nodeId: B, runs: 4, cents: 480 },
        ],
      }),
      window,
    );
    expect(measure.cost.nodes).toEqual([
      { nodeId: B, title: 'P1.b', runs: 4, cents: 480 },
      { nodeId: A, title: 'P1.a', runs: 2, cents: 120 },
    ]);
  });

  it('reads a week to now by default, and never a window longer than its ceiling', () => {
    const now = at('2026-10-27T00:00:00Z');
    expect(planLoopWindow({}, now).from.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(planLoopWindow({ from: '2025-01-01T00:00:00Z' }, now).from.toISOString()).toBe(
      '2026-09-26T00:00:00.000Z',
    );
  });
});
