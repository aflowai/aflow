/**
 * Plan 332 D6's place write against a real database.
 *
 * The in-memory store serialises every write, so its tests cannot show what
 * the Postgres store's sibling lock does: two places under one parent run at
 * once, the second waiting on the first's rows and then reading the order the
 * first left, so both land and neither loses the other's move; a renumbering
 * rewrites positions and no sibling's revision; and a write decided against a
 * revision or an order that no longer stands is refused with what does. Gated
 * on DATABASE_URL like every pg test.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  type TenantContext,
} from '@aflow/database';
import type { PlanNode } from '@aflow/schemas';
import { createPlanNode, placePlanNode } from '../plan/operations.js';
import { PLAN_PLACE_STRIDE } from '../plan/placement.js';
import { createPlanNodeStore } from '../plan/store.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = randomUUID();
/** Parents raced at once, so that some of their two places overlap inside their transactions. */
const RACING_PARENTS = 8;

const describeDb = DATABASE_URL ? describe : describe.skip;

interface SiblingRow {
  title: string;
  position: number;
  revision: number;
}

describeDb('placeAtRevision — places under one parent (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as never);
  const store = createPlanNodeStore(handle.db, TENANT_ID);
  const redis = new Redis() as unknown as RedisType;
  const ctx = { store, redis, tenantId: TENANT_ID, spaceId: SPACE_ID, createdBy: 'operator' };
  let tablePresent = false;

  async function node(title: string, parentId?: string, position?: number): Promise<PlanNode> {
    const result = await createPlanNode(ctx, {
      kind: 'execute',
      title,
      goal: 'Hold its place among its siblings.',
      criteria: 'It is where the test put it.',
      ...(parentId !== undefined ? { parentId } : {}),
      ...(position !== undefined ? { position } : {}),
    });
    if (!result.ok) throw new Error(result.message);
    return result.node;
  }

  /** A parent with children at consecutive positions, so that every place renumbers. */
  async function packed(title: string, titles: readonly string[]) {
    const root = await node(title);
    const children: PlanNode[] = [];
    for (const [position, child] of titles.entries()) {
      children.push(await node(child, root.nodeId, position));
    }
    return { root, children };
  }

  /** The children of `parentId` as the database orders them: by position, then id. */
  async function siblings(parentId: string): Promise<SiblingRow[]> {
    const rows = await withTenantSchema(handle.db, tenantCtx, (tx) =>
      tx.execute(drizzleSql`
        SELECT title, position, revision FROM plan_nodes
        WHERE space_id = ${SPACE_ID}::uuid AND parent_id = ${parentId}::uuid
        ORDER BY position, id
      `),
    );
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      title: String(row['title']),
      position: Number(row['position']),
      revision: Number(row['revision']),
    }));
  }

  const titlesOf = (rows: SiblingRow[]) => rows.map((row) => row.title);
  const revisionsOf = (rows: SiblingRow[]) =>
    Object.fromEntries(rows.map((row) => [row.title, row.revision]));

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'plan_nodes'
      ) AS ok`;
    tablePresent = rows[0]?.ok === true;
  });

  beforeEach((test) => {
    if (!tablePresent) test.skip();
  });

  afterAll(async () => {
    if (tablePresent) {
      await withTenantSchema(handle.db, tenantCtx, (tx) =>
        tx.execute(drizzleSql`DELETE FROM plan_nodes WHERE space_id = ${SPACE_ID}::uuid`),
      );
    }
    await handle.close();
  });

  it('renumbers where no integer lies between the neighbours, writing no sibling’s revision', async () => {
    const { root, children } = await packed('renumbered', ['A', 'B', 'C', 'D']);

    const result = await placePlanNode(ctx, {
      nodeId: children[3]!.nodeId,
      expectedRevision: 1,
      after: children[0]!.nodeId,
    });

    expect(result).toMatchObject({ ok: true, node: { revision: 2, position: PLAN_PLACE_STRIDE } });
    const after = await siblings(root.nodeId);
    expect(titlesOf(after)).toEqual(['A', 'D', 'B', 'C']);
    expect(after.map((row) => row.position)).toEqual([
      0,
      PLAN_PLACE_STRIDE,
      2 * PLAN_PLACE_STRIDE,
      3 * PLAN_PLACE_STRIDE,
    ]);
    expect(revisionsOf(after)).toEqual({ A: 1, B: 1, C: 1, D: 2 });
  });

  it('applies two places of different steps under one parent at once, losing neither', async () => {
    const groups = await Promise.all(
      Array.from({ length: RACING_PARENTS }, (_, i) =>
        packed(`raced ${String(i)}`, ['A', 'B', 'C', 'D']),
      ),
    );

    const outcomes = await Promise.all(
      groups.map(({ children: [a, b, c, d] }) =>
        Promise.all([
          placePlanNode(ctx, { nodeId: d!.nodeId, expectedRevision: 1, before: a!.nodeId }),
          placePlanNode(ctx, { nodeId: c!.nodeId, expectedRevision: 1, before: b!.nodeId }),
        ]),
      ),
    );

    for (const [i, pair] of outcomes.entries()) {
      expect(pair.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'ok']);
      const after = await siblings(groups[i]!.root.nodeId);
      // Either order of the two leaves this one, so only a lost move changes it.
      expect(titlesOf(after)).toEqual(['D', 'A', 'C', 'B']);
      expect(new Set(after.map((row) => row.position)).size).toBe(4);
      expect(revisionsOf(after)).toEqual({ A: 1, B: 1, C: 2, D: 2 });
    }
  });

  it('refuses the second of two places of one step decided on one revision', async () => {
    const groups = await Promise.all(
      Array.from({ length: RACING_PARENTS }, (_, i) =>
        packed(`contended ${String(i)}`, ['A', 'B', 'C']),
      ),
    );

    const outcomes = await Promise.all(
      groups.map(({ children: [a, b, c] }) =>
        Promise.all([
          placePlanNode(ctx, { nodeId: c!.nodeId, expectedRevision: 1, before: a!.nodeId }),
          placePlanNode(ctx, { nodeId: c!.nodeId, expectedRevision: 1, before: b!.nodeId }),
        ]),
      ),
    );

    for (const [i, pair] of outcomes.entries()) {
      expect(pair.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['PLAN_NODE_STALE', 'ok']);
      const after = await siblings(groups[i]!.root.nodeId);
      const won = pair[0]!.ok ? ['C', 'A', 'B'] : ['A', 'C', 'B'];
      expect(titlesOf(after)).toEqual(won);
      expect(revisionsOf(after)).toEqual({ A: 1, B: 1, C: 2 });
    }
  });

  it('refuses a stale revision with the step as it stands, and moves no sibling', async () => {
    const { root, children } = await packed('stale', ['A', 'B', 'C']);
    const before = await siblings(root.nodeId);

    const result = await placePlanNode(ctx, {
      nodeId: children[2]!.nodeId,
      expectedRevision: 3,
      before: children[0]!.nodeId,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_STALE',
      details: { nodeId: children[2]!.nodeId, revision: 1 },
    });
    expect(await siblings(root.nodeId)).toEqual(before);
  });

  it('refuses a sibling that moved away with the siblings’ order as it stands', async () => {
    const { root, children } = await packed('moved away', ['A', 'B']);
    const elsewhere = await node('elsewhere');
    const moved = await node('moved', elsewhere.nodeId);

    const result = await placePlanNode(ctx, {
      nodeId: children[1]!.nodeId,
      expectedRevision: 1,
      before: moved.nodeId,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_PLACE_STALE',
      details: {
        nodeId: children[1]!.nodeId,
        siblings: [
          { nodeId: children[0]!.nodeId, title: 'A', status: 'active', position: 0 },
          { nodeId: children[1]!.nodeId, title: 'B', status: 'active', position: 1 },
        ],
      },
    });
    expect(revisionsOf(await siblings(root.nodeId))).toEqual({ A: 1, B: 1 });
  });
});
