/**
 * Plan 331 D4 — what a node spent since a person last opened it, as the real
 * read computes it. A wake that commissioned several nodes is charged once,
 * divided across them; the window opens at `plan_nodes.opened_at`, which the
 * open write stamps itself, never at the buffered audit log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';

const tx = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (t: unknown) => unknown) => fn(tx.current),
}));

const { planNodes, sessions, workflowRuns } = await import('@aflow/database');
const { createPlanStreamReads, wakeShareCents, RUN_WAKE_SESSION_METADATA_KEY } =
  await import('../plan/streamReads.js');

const TENANT = 'a0000000-0000-4000-8000-000000000331';
const SPACE = '5e1d0000-0000-4000-8000-000000000331';
const NODE = '00000000-0000-4000-8000-0000000000a1';
const WAKE = '00000000-0000-4000-8000-0000000000e1';
const OPENED_AT = new Date('2026-10-27T09:00:00.000Z');

interface Query {
  table: unknown;
  fields: Record<string, unknown>;
  where?: SQL;
}

let queries: Query[];
let answers: (query: Query) => unknown[];

function recordingTx(): unknown {
  return {
    select(fields: Record<string, unknown>) {
      const query: Query = { table: undefined, fields };
      queries.push(query);
      const chain = {
        from(table: unknown) {
          query.table = table;
          return chain;
        },
        where(condition: SQL) {
          query.where = condition;
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        groupBy: () => chain,
        then(resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) {
          return Promise.resolve(answers(query)).then(resolve, reject);
        },
      };
      return chain;
    },
    execute() {
      throw new Error('the spend read runs no raw SQL: the audit log is not its source');
    },
  };
}

function reads() {
  return createPlanStreamReads(
    { db: {} as PostgresJsDatabase, payloadStore: {} as PayloadStore },
    TENANT,
  );
}

/** A node whose two runs were started by one wake that commissioned `nodes` nodes. */
function answering(nodes: number, opened: Date | null = OPENED_AT) {
  return (query: Query): unknown[] => {
    if (query.table === planNodes) return [{ at: opened }];
    if (query.table === sessions) return [{ sessionId: WAKE, cents: 3000 }];
    if (query.table === workflowRuns && 'nodes' in query.fields) {
      return [{ sessionId: WAKE, nodes }];
    }
    if (query.table === workflowRuns) {
      return [
        { runId: 'run-2', cents: 400, metadata: { [RUN_WAKE_SESSION_METADATA_KEY]: WAKE } },
        { runId: 'run-1', cents: 600, metadata: { [RUN_WAKE_SESSION_METADATA_KEY]: WAKE } },
      ];
    }
    throw new Error('an unexpected read');
  };
}

beforeEach(() => {
  queries = [];
  tx.current = recordingTx();
});

describe('a wake’s cost is charged once (Plan 331 D4)', () => {
  it('divides each wake across the nodes it started runs for', () => {
    expect(wakeShareCents([{ cents: 3000, nodes: 3 }])).toBe(1000);
    expect(
      wakeShareCents([
        { cents: 3000, nodes: 3 },
        { cents: 500, nodes: 1 },
      ]),
    ).toBe(1500);
    expect(wakeShareCents([{ cents: 700, nodes: 0 }])).toBe(700);
  });

  it('a wake that commissioned three nodes fires no premature spend stop: each node bears a third', async () => {
    answers = answering(3);
    const spend = await reads().spendOf(SPACE, NODE);
    // The node's own runs (1000) and a third of the wake (1000) — not the wake whole (3000).
    expect(spend).toEqual({ cents: 2000, runIds: ['run-2', 'run-1'], wakeSessionIds: [WAKE] });
    const ceiling = 2500;
    expect(spend.cents).toBeLessThan(ceiling);
    expect(1000 + 3000).toBeGreaterThan(ceiling);
  });

  it('a wake that served this node alone is charged to it whole', async () => {
    answers = answering(1);
    expect((await reads().spendOf(SPACE, NODE)).cents).toBe(4000);
  });
});

describe('the spend window (Plan 331 D5)', () => {
  it('opens at the node’s own opened_at, read from the node and never from the audit log', async () => {
    answers = answering(1);
    await reads().spendOf(SPACE, NODE);
    expect(queries[0]!.table).toBe(planNodes);
    const runs = queries.find((q) => q.table === workflowRuns && !('nodes' in q.fields));
    const rendered = new PgDialect().sqlToQuery(runs!.where!);
    expect(rendered.sql).toMatch(/"started_at" > \$\d+/);
    expect(rendered.params).toContainEqual(OPENED_AT.toISOString());
  });

  it('counts every run of a node no person has opened', async () => {
    answers = answering(1, null);
    await reads().spendOf(SPACE, NODE);
    const runs = queries.find((q) => q.table === workflowRuns && !('nodes' in q.fields));
    expect(new PgDialect().sqlToQuery(runs!.where!).sql).not.toContain('started_at');
  });
});
