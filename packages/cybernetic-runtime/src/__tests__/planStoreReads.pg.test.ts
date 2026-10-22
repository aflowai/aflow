/**
 * The plan store's reads behind the operator's plan page, against a real
 * database: `listLinksOfEach` ranks each node's links by a window over
 * `plan_node_links`, selected from a subquery, and `closingsOf` reads how
 * closed nodes ended. The in-memory store answers both by other means, so
 * only Postgres shows the SQL does what the engine relies on: each node cut
 * to its own newest links with its own total, and a node's closing read only
 * where it has one. Gated on DATABASE_URL like every pg test.
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
import { createPlanNode, linkPlanNode, updatePlanNode } from '../plan/operations.js';
import { createPlanNodeStore } from '../plan/store.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = randomUUID();
const OTHER_SPACE_ID = randomUUID();
const PR_URL = 'https://github.com/aflowai/aflow/pull/181';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('plan store reads for the operator’s plan (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as never);
  const store = createPlanNodeStore(handle.db, TENANT_ID);
  const redis = new Redis() as unknown as RedisType;
  let tablePresent = false;

  function ctx(spaceId = SPACE_ID) {
    return { store, redis, tenantId: TENANT_ID, spaceId };
  }

  async function node(title: string, spaceId = SPACE_ID): Promise<PlanNode> {
    const result = await createPlanNode(ctx(spaceId), {
      kind: 'execute',
      title,
      goal: 'Be read back as written.',
      criteria: 'The read returns it.',
    });
    if (!result.ok) throw new Error(result.message);
    return result.node;
  }

  async function link(nodeId: string, ref: string, spaceId = SPACE_ID, label?: string) {
    const result = await linkPlanNode(ctx(spaceId), {
      nodeId,
      kind: 'finding',
      ref,
      ...(label !== undefined ? { label } : {}),
    });
    if (!result.ok) throw new Error(result.message);
  }

  /** A link written with the time given, so ties and order are the test's to set. */
  async function linkAt(nodeId: string, kind: string, ref: string, createdAt: string) {
    await withTenantSchema(handle.db, tenantCtx, (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO plan_node_links (node_id, space_id, kind, ref, label, created_at)
        VALUES (${nodeId}::uuid, ${SPACE_ID}::uuid, ${kind}, ${ref}, NULL, ${createdAt}::timestamptz)
      `),
    );
  }

  async function close(
    target: PlanNode,
    status: 'done' | 'dropped',
    outcome: string,
  ): Promise<PlanNode> {
    const result = await updatePlanNode(ctx(), {
      nodeId: target.nodeId,
      expectedRevision: target.revision,
      status,
      outcome,
    });
    if (!result.ok) throw new Error(result.message);
    return result.node;
  }

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'plan_node_links'
      ) AS ok`;
    tablePresent = rows[0]?.ok === true;
  });

  beforeEach((test) => {
    if (!tablePresent) test.skip();
  });

  afterAll(async () => {
    if (tablePresent) {
      // A node's links go with it (`plan_node_links.node_id` cascades).
      await withTenantSchema(handle.db, tenantCtx, (tx) =>
        tx.execute(
          drizzleSql`DELETE FROM plan_nodes WHERE space_id IN (${SPACE_ID}::uuid, ${OTHER_SPACE_ID}::uuid)`,
        ),
      );
    }
    await handle.close();
  });

  describe('listLinksOfEach', () => {
    it('cuts each node to its own newest links, newest first, with its own total', async () => {
      const busy = await node('busy');
      const quiet = await node('quiet');
      const bare = await node('bare');
      for (let i = 0; i < 5; i++) {
        await linkAt(busy.nodeId, 'finding', `F${String(i)}`, `2026-10-05T0${String(i)}:00:00Z`);
      }
      await linkAt(quiet.nodeId, 'finding', 'Q0', '2026-10-05T09:00:00Z');

      const byNode = await store.listLinksOfEach(
        SPACE_ID,
        [busy.nodeId, quiet.nodeId, bare.nodeId],
        3,
      );

      expect(byNode.get(busy.nodeId)?.total).toBe(5);
      expect(byNode.get(busy.nodeId)?.links.map((l) => l.ref)).toEqual(['F4', 'F3', 'F2']);
      // The limit is per node: the busy node's links do not use up the quiet one's.
      expect(byNode.get(quiet.nodeId)).toEqual({
        links: [
          {
            nodeId: quiet.nodeId,
            kind: 'finding',
            ref: 'Q0',
            createdAt: '2026-10-05T09:00:00.000Z',
          },
        ],
        total: 1,
      });
      expect(byNode.has(bare.nodeId)).toBe(false);
    });

    it('orders links written at one instant by kind and then ref, as one read does every time', async () => {
      const tied = await node('tied');
      const at = '2026-10-05T12:00:00Z';
      await linkAt(tied.nodeId, 'run', randomUUID(), '2026-10-05T11:00:00Z');
      await linkAt(tied.nodeId, 'pull_request', PR_URL, at);
      await linkAt(tied.nodeId, 'finding', 'F-b', at);
      await linkAt(tied.nodeId, 'finding', 'F-a', at);

      const byNode = await store.listLinksOfEach(SPACE_ID, [tied.nodeId], 3);

      expect(byNode.get(tied.nodeId)?.links.map((l) => [l.kind, l.ref])).toEqual([
        ['finding', 'F-a'],
        ['finding', 'F-b'],
        ['pull_request', PR_URL],
      ]);
      expect(byNode.get(tied.nodeId)?.total).toBe(4);
    });

    it('reads what the per-node read does, label included, for every node at once', async () => {
      const a = await node('a');
      const b = await node('b');
      await link(a.nodeId, 'A1', SPACE_ID, 'first finding');
      await link(a.nodeId, 'A2');
      await link(b.nodeId, 'B1');

      const byNode = await store.listLinksOfEach(SPACE_ID, [a.nodeId, b.nodeId], 10);

      for (const held of [a, b]) {
        expect(byNode.get(held.nodeId)).toEqual(await store.listLinks(SPACE_ID, held.nodeId, 10));
      }
      expect(byNode.get(a.nodeId)?.links.find((l) => l.ref === 'A1')?.label).toBe('first finding');
    });

    it('reads only the space asked about, and only the nodes named', async () => {
      const here = await node('here');
      const unnamed = await node('unnamed');
      const elsewhere = await node('elsewhere', OTHER_SPACE_ID);
      await link(here.nodeId, 'H1');
      await link(unnamed.nodeId, 'U1');
      await link(elsewhere.nodeId, 'E1', OTHER_SPACE_ID);

      const byNode = await store.listLinksOfEach(SPACE_ID, [here.nodeId, elsewhere.nodeId], 10);

      expect([...byNode.keys()]).toEqual([here.nodeId]);
      expect(await store.listLinksOfEach(SPACE_ID, [], 10)).toEqual(new Map());
    });
  });

  describe('closingsOf', () => {
    it('reads how a done and a dropped node ended, and when', async () => {
      const done = await close(await node('done'), 'done', `Merged ${PR_URL}.`);
      const dropped = await close(await node('dropped'), 'dropped', 'Superseded by P3.2.');

      const closings = await store.closingsOf(SPACE_ID, [done.nodeId, dropped.nodeId]);

      expect(closings.get(done.nodeId)).toEqual({
        outcome: `Merged ${PR_URL}.`,
        closedAt: done.closedAt,
      });
      expect(closings.get(dropped.nodeId)).toEqual({
        outcome: 'Superseded by P3.2.',
        closedAt: dropped.closedAt,
      });
      expect(Number.isNaN(Date.parse(closings.get(done.nodeId)?.closedAt ?? ''))).toBe(false);
    });

    it('leaves out a node that is open, or was reopened, since it holds neither', async () => {
      const open = await node('open');
      const closed = await close(await node('reopened'), 'done', 'Met, then not.');
      const reopened = await updatePlanNode(ctx(), {
        nodeId: closed.nodeId,
        expectedRevision: closed.revision,
        status: 'active',
      });
      if (!reopened.ok) throw new Error(reopened.message);

      const closings = await store.closingsOf(SPACE_ID, [open.nodeId, closed.nodeId]);

      expect(closings.size).toBe(0);
    });

    it('reads only the space asked about, and only the nodes named', async () => {
      const named = await close(await node('named'), 'done', 'Named.');
      const unnamed = await close(await node('unnamed'), 'done', 'Not named.');
      const elsewhere = await node('elsewhere', OTHER_SPACE_ID);
      const elsewhereClosed = await updatePlanNode(ctx(OTHER_SPACE_ID), {
        nodeId: elsewhere.nodeId,
        expectedRevision: elsewhere.revision,
        status: 'done',
        outcome: 'In another space.',
      });
      if (!elsewhereClosed.ok) throw new Error(elsewhereClosed.message);

      const closings = await store.closingsOf(SPACE_ID, [named.nodeId, elsewhere.nodeId]);

      expect([...closings.keys()]).toEqual([named.nodeId]);
      expect(closings.has(unnamed.nodeId)).toBe(false);
      expect(await store.closingsOf(SPACE_ID, [])).toEqual(new Map());
    });
  });
});
