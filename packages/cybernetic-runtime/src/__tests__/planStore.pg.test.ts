/**
 * Plan moves against a real database.
 *
 * The engine's tests prove a move's cycle check and its write are one step of
 * the store; only Postgres can show that the step holds when two moves that
 * cross each other run at once — each walk locking the rows the other needs,
 * one of them ended as a deadlock and refused as a cycle on its next attempt.
 * Gated on DATABASE_URL like every pg test.
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
import { createPlanNode, listPlanNodes, updatePlanNode } from '../plan/operations.js';
import { createPlanNodeStore } from '../plan/store.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = randomUUID();
/** Pairs raced at once, so that some of them overlap inside their transactions. */
const RACING_PAIRS = 8;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('moveAtRevision — two crossing moves never close a loop (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as never);
  const store = createPlanNodeStore(handle.db, TENANT_ID);
  const redis = new Redis() as unknown as RedisType;
  const ctx = { store, redis, tenantId: TENANT_ID, spaceId: SPACE_ID };
  let tablePresent = false;

  async function node(title: string, parentId?: string): Promise<PlanNode> {
    const result = await createPlanNode(ctx, {
      kind: 'execute',
      title,
      goal: 'Hold its place in the tree.',
      criteria: 'It is where the test put it.',
      ...(parentId !== undefined ? { parentId } : {}),
    });
    if (!result.ok) throw new Error(result.message);
    return result.node;
  }

  function move(nodeId: string, parentId: string) {
    return updatePlanNode(ctx, { nodeId, expectedRevision: 1, parentId });
  }

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

  it('refuses one of A-under-B and B-under-A, and both stay in the tree', async () => {
    const pairs = await Promise.all(
      Array.from({ length: RACING_PAIRS }, async (_, i) => ({
        a: await node(`a${String(i)}`),
        b: await node(`b${String(i)}`),
      })),
    );

    const outcomes = await Promise.all(
      pairs.map(({ a, b }) => Promise.all([move(a.nodeId, b.nodeId), move(b.nodeId, a.nodeId)])),
    );

    for (const [aUnderB, bUnderA] of outcomes) {
      expect([aUnderB.ok, bUnderA.ok].sort()).toEqual([false, true]);
      expect(aUnderB.ok ? bUnderA : aUnderB).toMatchObject({ code: 'PLAN_NODE_CYCLE' });
    }
    const tree = await listPlanNodes({ store, spaceId: SPACE_ID }, { limit: 200 });
    expect(tree.ok && tree.nodes).toHaveLength(RACING_PAIRS * 2);
  });

  it('refuses one of two moves that close a loop through nodes neither moves', async () => {
    const a = await node('a');
    const b = await node('b');
    const underA = await node('under a', a.nodeId);
    const underB = await node('under b', b.nodeId);

    const [aMove, bMove] = await Promise.all([
      move(a.nodeId, underB.nodeId),
      move(b.nodeId, underA.nodeId),
    ]);

    expect([aMove.ok, bMove.ok].sort()).toEqual([false, true]);
    expect(aMove.ok ? bMove : aMove).toMatchObject({ code: 'PLAN_NODE_CYCLE' });
    const tree = await listPlanNodes({ store, spaceId: SPACE_ID }, { limit: 200 });
    expect(tree.ok && tree.nodes.map((n) => n.title)).toEqual(
      expect.arrayContaining(['a', 'b', 'under a', 'under b']),
    );
  });
});
