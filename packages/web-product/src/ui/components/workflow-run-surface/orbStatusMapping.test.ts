import { describe, expect, it } from 'vitest';
import {
  PlanNodeActivitySchema,
  PlanNodeKindSchema,
  PlanNodeStatusSchema,
  PlanRootStateSchema,
  planBoardColumn,
  type PlanNodeStatus,
  type PlanRootState,
} from '@aflow/schemas';
import {
  orbForPlanState,
  orbForPlanStep,
  orbForRunStatus,
  orbForTaskStatus,
  type OrbKind,
} from './workflowRunSurfaceHelpers.js';

describe('orbForPlanState', () => {
  it('maps every plan state', () => {
    const expected: Record<PlanRootState, OrbKind> = {
      in_flight: 'running',
      needs_you: 'paused',
      queued: 'inert',
      finished: 'completed',
      closed: 'inert',
      empty: 'inert',
    };
    for (const state of PlanRootStateSchema.options) {
      expect(orbForPlanState(state), state).toBe(expected[state]);
    }
  });
});

describe('orbForPlanStep', () => {
  /** Every step the board can place: each status, kind, activity, under a closed step or not. */
  const placements = PlanNodeStatusSchema.options.flatMap((status) =>
    PlanNodeKindSchema.options.flatMap((kind) =>
      PlanNodeActivitySchema.options.flatMap((activity) =>
        [false, true].map((closedAncestor) => ({
          status,
          kind,
          activity,
          closedAncestor,
          placement: planBoardColumn({ kind, status, activity }, { closedAncestor }),
        })),
      ),
    ),
  );
  const orbOf = (p: (typeof placements)[number]) =>
    orbForPlanStep(p.placement.column, { runInFlight: p.activity === 'in_flight' });

  it('maps every status in each column it stands in', () => {
    const seen = new Map<PlanNodeStatus, Set<string>>();
    for (const p of placements) {
      const columns = seen.get(p.status) ?? new Set<string>();
      columns.add(`${p.placement.column}:${orbOf(p)}`);
      seen.set(p.status, columns);
    }
    expect(Object.fromEntries([...seen].map(([status, set]) => [status, [...set].sort()]))).toEqual(
      {
        active: ['in_flight:running', 'needs_you:paused', 'up_next:inert'],
        waiting: ['in_flight:idle', 'in_flight:running', 'needs_you:paused'],
        blocked: ['needs_you:paused'],
        done: ['done:completed'],
        dropped: ['dropped:inert'],
      },
    );
  });

  it('reads a waiting step running only while a run is on it', () => {
    const waiting = (activity: 'in_flight' | 'idle') =>
      placements.find(
        (p) =>
          p.status === 'waiting' &&
          p.kind === 'execute' &&
          p.activity === activity &&
          !p.closedAncestor,
      )!;
    expect(orbOf(waiting('in_flight'))).toBe('running');
    expect(orbOf(waiting('idle'))).toBe('idle');
  });

  it('reads every Needs you reason paused, a stranded step included', () => {
    const needsYou = placements.filter((p) => p.placement.column === 'needs_you');
    expect(new Set(needsYou.map((p) => p.placement.reason))).toEqual(
      new Set(['decide', 'blocked', 'stranded']),
    );
    expect(new Set(needsYou.map(orbOf))).toEqual(new Set(['paused']));
  });

  it('reads no step failed: the board cannot tell a failed run apart', () => {
    expect(placements.map(orbOf)).not.toContain('failed');
    for (const kind of ['searching', 'handed_off'] as const) {
      expect(placements.map(orbOf)).not.toContain(kind);
    }
  });
});

describe('orbForRunStatus', () => {
  it('maps live work to running', () => {
    expect(orbForRunStatus('running')).toBe('running');
    expect(orbForRunStatus('in_flight')).toBe('running');
  });

  it('maps paused (user action expected) to paused', () => {
    expect(orbForRunStatus('paused')).toBe('paused');
  });

  it('maps terminal success to completed', () => {
    expect(orbForRunStatus('completed')).toBe('completed');
  });

  it('maps failure/cancel to failed', () => {
    expect(orbForRunStatus('failed')).toBe('failed');
    expect(orbForRunStatus('cancelled')).toBe('failed');
  });

  it('maps skipped to inert', () => {
    expect(orbForRunStatus('skipped')).toBe('inert');
  });
});

describe('orbForTaskStatus', () => {
  it('maps lifecycle statuses', () => {
    expect(orbForTaskStatus('running')).toBe('running');
    expect(orbForTaskStatus('paused')).toBe('paused');
    expect(orbForTaskStatus('succeeded')).toBe('completed');
    expect(orbForTaskStatus('failed')).toBe('failed');
    expect(orbForTaskStatus('cancelled')).toBe('failed');
  });

  it('maps dependency-held / not-taken to inert', () => {
    expect(orbForTaskStatus('blocked')).toBe('inert');
    expect(orbForTaskStatus('scheduled')).toBe('inert');
    expect(orbForTaskStatus('skipped')).toBe('inert');
  });

  it('surfaces stalled running as failed', () => {
    expect(orbForTaskStatus('running', { stalled: true })).toBe('failed');
    expect(orbForTaskStatus('paused', { stalled: true })).toBe('paused');
  });
});
