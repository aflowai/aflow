/**
 * Plan 331 D7 — the three numbers, computed from the records a window holds:
 * operator actions per merged pull request, each node's idle time from when it
 * became actionable to its first commission, and each node's cost with the
 * resident's wakes beside it.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PlanLoopMeasureOutputSchema, planResidentScheduleInput } from '@aflow/schemas';
import {
  measurePlanLoop,
  planLoopWindow,
  readPlanLoopFacts,
  type PlanLoopFacts,
} from '../plan/loopMeasure.js';

const tx = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (t: unknown) => unknown) => fn(tx),
}));

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
  it('excludes scheduled starts without excluding a person resuming a scheduled session', async () => {
    tx.execute.mockImplementation((query: SQL) => {
      const { sql } = new PgDialect().sqlToQuery(query);
      if (sql.includes('FROM event_log')) {
        expect(sql).toContain(
          "e.event_type = 'SessionResumed' OR (e.event_type = 'SessionStarted'",
        );
        expect(sql).toContain(
          "s.execution_authority ->> 'establishedReason' IS DISTINCT FROM 'schedule'",
        );
        return [{ n: 1 }];
      }
      if (sql.includes('FROM public.platform_audit_log') && sql.includes('GROUP BY action')) {
        expect(sql).toContain("actor_type = 'human'");
      }
      if (sql.includes('FROM agent_schedules'))
        return [
          {
            id: ROOT,
            targetKind: 'platform-role',
            targetSystemRole: 'cybernetic-helmsman',
            inputTemplate: planResidentScheduleInput(),
          },
        ];
      if (sql.includes('FROM sessions'))
        return Array.from({ length: 120 }, () => ({
          cents: '7.5',
          inputRef: `inline:${Buffer.from(JSON.stringify({ config: { scheduleId: ROOT } })).toString('base64')}`,
        }));
      if (sql.includes('FROM plan_node_links')) return [{ n: 1 }];
      return [];
    });
    const read = await readPlanLoopFacts({} as PostgresJsDatabase, ROOT, ROOT, window);
    const measure = measurePlanLoop(read, window);
    expect(measure.operatorActions.total).toBe(1);
    expect(measure.actionsPerMergedPullRequest).toBe(1);
    expect(measure.cost.wakes.sessions).toBe(120);
  });
  it('excludes per-stream schedule sessions from resident wake cost', async () => {
    tx.execute.mockImplementation((query: SQL) => {
      const { sql } = new PgDialect().sqlToQuery(query);
      if (sql.includes('FROM agent_schedules'))
        return [
          {
            id: ROOT,
            targetKind: 'platform-role',
            targetSystemRole: 'cybernetic-helmsman',
            inputTemplate: planResidentScheduleInput(),
          },
          {
            id: A,
            targetKind: 'platform-role',
            targetSystemRole: 'cybernetic-helmsman',
            inputTemplate: { input: 'Work the stream' },
          },
        ];
      if (sql.includes('FROM sessions'))
        return [ROOT, A].map((scheduleId) => ({
          cents: '20',
          inputRef: `inline:${Buffer.from(JSON.stringify({ config: { scheduleId } })).toString('base64')}`,
        }));
      return [];
    });
    expect((await readPlanLoopFacts({} as PostgresJsDatabase, ROOT, ROOT, window)).wakes).toEqual({
      sessions: 1,
      cents: 20,
    });
  });
  it('counts a human schedule write through a user API key', async () => {
    tx.execute.mockImplementation((query: SQL) => {
      const { sql } = new PgDialect().sqlToQuery(query);
      if (sql.includes('FROM public.platform_audit_log') && sql.includes('GROUP BY action')) {
        expect(sql).toContain("actor_type = 'human'");
        expect(sql).not.toContain('auth_method');
        return [{ action: 'schedule.update', n: 1 }];
      }
      return [];
    });
    const read = await readPlanLoopFacts({} as PostgresJsDatabase, ROOT, ROOT, window);
    expect(measurePlanLoop(read, window).operatorActions).toMatchObject({
      total: 1,
      scheduleWrites: 1,
    });
  });

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
