/**
 * Plan 322 P2 against a real database.
 *
 * The engine's tests prove the rules over the in-memory store; only Postgres
 * can show that two edge writes that would close a loop between them, run at
 * once, cannot both land — each holds its waiting node's row and walks into
 * the other's, so Postgres ends one as a deadlock and its next attempt reads
 * the committed edge and refuses it as a cycle — and that the learnings and
 * dependencies a node's read joins come back as the fake returns them. Gated
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
import { PlanNodeGetOutputSchema, type PlanNode } from '@aflow/schemas';
import {
  createPlanNode,
  dependPlanNode,
  getPlanNode,
  learnOnPlanNode,
  updatePlanNode,
} from '../plan/operations.js';
import { createPlanNodeStore } from '../plan/store.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = randomUUID();
const SESSION_ID = randomUUID();
const RUN_ID = randomUUID();
/** Pairs raced at once, so that some of them overlap inside their transactions. */
const RACING_PAIRS = 8;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('plan dependencies and learnings (real DB)', () => {
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
      goal: 'Wait on what it waits on.',
      criteria: 'The test reads it back.',
      ...(parentId !== undefined ? { parentId } : {}),
    });
    if (!result.ok) throw new Error(result.message);
    return result.node;
  }

  function depend(waits: PlanNode, on: PlanNode) {
    return dependPlanNode(ctx, {
      nodeId: waits.nodeId,
      expectedRevision: waits.revision,
      dependsOnId: on.nodeId,
      condition: 'done',
    });
  }

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'plan_node_dependencies'
      ) AS ok`;
    tablePresent = rows[0]?.ok === true;
  });

  beforeEach((test) => {
    if (!tablePresent) test.skip();
  });

  afterAll(async () => {
    if (tablePresent) {
      await withTenantSchema(handle.db, tenantCtx, async (tx) => {
        await tx.execute(
          drizzleSql`DELETE FROM coach_learnings WHERE space_id = ${SPACE_ID}::uuid`,
        );
        // Takes the edges with it: both ends reference plan_nodes on delete cascade.
        await tx.execute(drizzleSql`DELETE FROM plan_nodes WHERE space_id = ${SPACE_ID}::uuid`);
      });
    }
    await handle.close();
  });

  it('refuses one of A-waits-on-B and B-waits-on-A written at once', async () => {
    const pairs = await Promise.all(
      Array.from({ length: RACING_PAIRS }, async (_, i) => ({
        a: await node(`a${String(i)}`),
        b: await node(`b${String(i)}`),
      })),
    );
    const outcomes = await Promise.all(
      pairs.map(({ a, b }) => Promise.all([depend(a, b), depend(b, a)])),
    );
    for (const [aOnB, bOnA] of outcomes) {
      expect([aOnB.ok, bOnA.ok].sort()).toEqual([false, true]);
      expect(aOnB.ok ? bOnA : aOnB).toMatchObject({ code: 'PLAN_NODE_DEPENDENCY_CYCLE' });
    }
  });

  it('refuses the edge that closes a longer loop, and reads each edge back with whether it is met', async () => {
    const a = await node('loop a');
    const b = await node('loop b');
    const c = await node('loop c');
    const ab = await depend(a, b);
    const bc = await depend(b, c);
    if (!ab.ok || !bc.ok) throw new Error('the chain a → b → c was refused');
    const refused = await depend(c, a);
    expect(refused).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_DEPENDENCY_CYCLE',
      details: { path: [c.nodeId, a.nodeId, b.nodeId, c.nodeId] },
    });

    await updatePlanNode(ctx, {
      nodeId: b.nodeId,
      expectedRevision: bc.node.revision,
      status: 'done',
      outcome: 'Landed.',
    });
    const read = await getPlanNode({ store, spaceId: SPACE_ID }, a.nodeId);
    if (!read.ok) throw new Error(read.message);
    expect(PlanNodeGetOutputSchema.parse(read)).toBeTruthy();
    expect(read.dependencies).toEqual([
      { nodeId: b.nodeId, title: 'loop b', status: 'done', condition: 'done', met: true },
    ]);
    const onB = await getPlanNode({ store, spaceId: SPACE_ID }, b.nodeId);
    expect(onB.ok && onB.dependents).toEqual([
      { nodeId: a.nodeId, title: 'loop a', status: 'active', condition: 'done', met: true },
    ]);
  });

  it('stores a learning as plan scope and reads it on the node and the nodes under it', async () => {
    const root = await node('root');
    const child = await node('child', root.nodeId);
    const learned = await learnOnPlanNode(
      ctx,
      {
        nodeId: root.nodeId,
        kind: 'heuristic',
        statement: 'Rerun a timeout once before fixing it.',
        evidence: { citations: [{ runId: RUN_ID }] },
        confidence: 'low',
      },
      { sessionId: SESSION_ID },
    );
    if (!learned.ok) throw new Error(learned.message);

    const rows = await withTenantSchema(handle.db, tenantCtx, (tx) =>
      tx.execute(drizzleSql`
        SELECT scope_kind, plan_node_id, status, authority_level, coach_session_id
        FROM coach_learnings WHERE id = ${learned.learning.learningId}::uuid`),
    );
    expect((rows as Array<Record<string, unknown>>)[0]).toEqual({
      scope_kind: 'plan',
      plan_node_id: root.nodeId,
      status: 'auto_recorded',
      authority_level: 'auto_record',
      coach_session_id: SESSION_ID,
    });

    const replaced = await learnOnPlanNode(
      ctx,
      {
        nodeId: root.nodeId,
        kind: 'heuristic',
        statement: 'A timeout here is the fixture, not the network.',
        evidence: { citations: [{ runId: RUN_ID }] },
        confidence: 'medium',
        supersedes: [learned.learning.learningId],
      },
      { sessionId: SESSION_ID },
    );
    expect(replaced.ok).toBe(true);
    const read = await getPlanNode({ store, spaceId: SPACE_ID }, child.nodeId);
    expect(read.ok && read.learnings.map((l) => l.statement)).toEqual([
      'A timeout here is the fixture, not the network.',
    ]);
  });
});
