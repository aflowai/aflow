/**
 * The walk's `mergeWait` flag without Postgres (Plan 338 D1). The store
 * computes it in SQL and the in-memory store in TypeScript, so every listing
 * test reads the TypeScript rule. This suite records the SQL the walk sends
 * through a driver that answers what the test gives it. It pins the
 * expression and its parameter, reads the column back into the summary, and
 * holds the TypeScript rule and the fake to what that expression computes. `planStoreReads.pg.test.ts` runs the same SQL against
 * a real database where one is configured.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  OPEN_PLAN_NODE_STATUSES,
  PLAN_NODE_MERGE_WAIT_LINE,
  planNoteHoldsMergeWait,
} from '@aflow/schemas';
import { createPlanNode, updatePlanNode } from '../plan/operations.js';
import { createPlanNodeStore } from '../plan/store.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000338';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const WALK = { statuses: OPEN_PLAN_NODE_STATUSES, maxDepth: 5, maxNodes: 100 };

interface SentQuery {
  query: string;
  params: readonly unknown[];
}

/**
 * A postgres.js client that records each query and answers it with the rows
 * `answer` gives, as postgres.js answers a select: each row its values in the
 * order of the select list. By default it answers no rows.
 */
function recordingClient(
  sent: SentQuery[],
  answer: (query: string) => readonly unknown[][] = () => [],
) {
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: readonly unknown[] = []) {
      sent.push({ query, params });
      const rows = answer(query);
      return Object.assign(Promise.resolve(rows), { values: () => Promise.resolve(rows) });
    },
    begin: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return client;
}

/** Postgres's `strpos`: the 1-based place of the first match, 0 for none, NULL for a NULL text. */
function strpos(text: string | null, find: string): number | null {
  return text === null ? null : text.indexOf(find) + 1;
}

/** The walk's SQL, `coalesce(strpos(note, line) > 0, false)`, read by Postgres's rules. */
function sqlMergeWait(note: string | null): boolean {
  const at = strpos(note, PLAN_NODE_MERGE_WAIT_LINE);
  return at === null ? false : at > 0;
}

const NOTES: readonly (string | null)[] = [
  null,
  '',
  'Nothing to judge.',
  PLAN_NODE_MERGE_WAIT_LINE,
  `Operator context\n${PLAN_NODE_MERGE_WAIT_LINE}`,
  `Before ${PLAN_NODE_MERGE_WAIT_LINE} after`,
  PLAN_NODE_MERGE_WAIT_LINE.toLowerCase(),
  PLAN_NODE_MERGE_WAIT_LINE.slice(0, -1),
];

describe('the walk’s merge-wait flag', () => {
  it('is computed in SQL as the merge-wait line found anywhere in the note', async () => {
    const sent: SentQuery[] = [];
    const store = createPlanNodeStore(drizzle(recordingClient(sent) as never), TENANT);
    await store.walk(SPACE, WALK);
    const walkQuery = sent.find((q) => q.query.includes('strpos('));
    expect(walkQuery).toBeDefined();
    const match = /coalesce\(strpos\("note", \$(\d+)\) > 0, false\)/.exec(walkQuery!.query);
    expect(match, walkQuery!.query).not.toBeNull();
    expect(walkQuery!.params[Number(match![1]) - 1]).toBe(PLAN_NODE_MERGE_WAIT_LINE);
  });

  it('reaches the summary as true or not at all', async () => {
    const sent: SentQuery[] = [];
    const row = (id: string, mergeWait: boolean) => [
      id,
      null,
      'execute',
      `Step ${id.slice(-1)}`,
      'active',
      1,
      0,
      'First line',
      mergeWait,
      '2026-10-31 10:00:00',
      '2026-10-31 10:00:00',
      null,
    ];
    const flagged = '00000000-0000-4000-8000-000000000001';
    const plain = '00000000-0000-4000-8000-000000000002';
    const store = createPlanNodeStore(
      drizzle(
        recordingClient(sent, (q) =>
          q.includes('strpos(') && q.includes('"parent_id" is null')
            ? [row(flagged, true), row(plain, false)]
            : [],
        ) as never,
      ),
      TENANT,
    );
    const walk = await store.walk(SPACE, WALK);
    const byId = new Map(walk.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get(flagged)).toMatchObject({ mergeWait: true, noteHead: 'First line' });
    expect(byId.get(plain)).toBeDefined();
    expect(byId.get(plain)).not.toHaveProperty('mergeWait');
  });

  it('reads the same in TypeScript as the SQL computes it', () => {
    for (const note of NOTES) {
      expect(planNoteHoldsMergeWait(note), JSON.stringify(note)).toBe(sqlMergeWait(note));
    }
  });

  it('is set by the in-memory store where the SQL would set it, and only there', async () => {
    const store = new InMemoryPlanNodeStore();
    const ctx = {
      store,
      redis: new Redis() as unknown as RedisType,
      tenantId: TENANT,
      spaceId: SPACE,
    };
    const expected = new Map<string, boolean>();
    for (const [i, note] of NOTES.entries()) {
      const created = await createPlanNode(ctx, {
        kind: 'execute',
        title: `Step ${i}`,
        goal: 'Be walked.',
        criteria: 'The walk flags it as the SQL would.',
      });
      if (!created.ok) throw new Error(created.message);
      if (note !== null && note !== '') {
        const written = await updatePlanNode(ctx, {
          nodeId: created.node.nodeId,
          expectedRevision: created.node.revision,
          note,
        });
        if (!written.ok) throw new Error(written.message);
      }
      expected.set(created.node.nodeId, sqlMergeWait(note));
    }
    const walk = await store.walk(SPACE, WALK);
    expect(walk.nodes).toHaveLength(NOTES.length);
    for (const node of walk.nodes) {
      expect(node.mergeWait === true, node.title).toBe(expected.get(node.nodeId));
    }
  });
});
