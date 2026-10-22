/**
 * The plan store's reads behind the operator's board (Plan 322 P3.3), against
 * a real database: `pageLinks` pages a node's links by a keyset whose time is
 * the column's own text, the board reads count links in one aggregate and
 * read each node's newest pull request with its merge by DISTINCT ON. The
 * in-memory store answers them by other means, so only Postgres shows the
 * SQL does what the engine relies on. Gated on DATABASE_URL like every pg test.
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

  describe('pageLinks', () => {
    it('pages a node’s links newest first, ties by kind then ref, each page after the last key', async () => {
      const busy = await node('busy');
      const at = '2026-10-05T12:00:00.123456Z';
      await linkAt(busy.nodeId, 'run', randomUUID(), '2026-10-05T11:00:00Z');
      await linkAt(busy.nodeId, 'pull_request', PR_URL, at);
      await linkAt(busy.nodeId, 'finding', 'F-b', at);
      await linkAt(busy.nodeId, 'finding', 'F-a', at);

      const first = await store.pageLinks(SPACE_ID, busy.nodeId, { limit: 2 });
      const second = await store.pageLinks(SPACE_ID, busy.nodeId, {
        limit: 2,
        ...(first.next !== undefined ? { after: first.next } : {}),
      });

      expect(first.links.map((l) => [l.kind, l.ref])).toEqual([
        ['finding', 'F-a'],
        ['finding', 'F-b'],
      ]);
      expect(first.total).toBe(4);
      // The key keeps the microseconds the column holds, so the tie is not split by them.
      expect(first.next?.at).toContain('.123456');
      expect(second.links.map((l) => l.kind)).toEqual(['pull_request', 'run']);
      expect(second.next).toBeUndefined();
    });

    it('reads one kind with that kind’s total, label included, and only the space asked about', async () => {
      const a = await node('a');
      const elsewhere = await node('elsewhere', OTHER_SPACE_ID);
      await link(a.nodeId, 'A1', SPACE_ID, 'first finding');
      await link(a.nodeId, 'A2');
      await linkAt(a.nodeId, 'document', '/notes.md', '2026-10-05T09:00:00Z');
      await link(elsewhere.nodeId, 'E1', OTHER_SPACE_ID);

      const findings = await store.pageLinks(SPACE_ID, a.nodeId, { kind: 'finding', limit: 10 });

      expect(findings.total).toBe(2);
      expect(findings.links.find((l) => l.ref === 'A1')?.label).toBe('first finding');
      expect((await store.pageLinks(SPACE_ID, elsewhere.nodeId, { limit: 10 })).total).toBe(0);
    });
  });

  describe('boardFactsOf', () => {
    it('reads when each node was made and closed and the head of its goal, for the nodes named', async () => {
      const done = await close(await node('done'), 'done', `Merged ${PR_URL}.`);
      const open = await node('open');
      const elsewhere = await node('elsewhere', OTHER_SPACE_ID);

      const facts = await store.boardFactsOf(SPACE_ID, [
        done.nodeId,
        open.nodeId,
        elsewhere.nodeId,
      ]);

      expect(facts.get(done.nodeId)).toEqual({
        createdAt: done.createdAt,
        closedAt: done.closedAt,
        goalHead: 'Be read back as written.',
      });
      expect(facts.get(open.nodeId)).not.toHaveProperty('closedAt');
      expect(facts.has(elsewhere.nodeId)).toBe(false);
      expect(await store.boardFactsOf(SPACE_ID, [])).toEqual(new Map());
    });
  });

  describe('linkTalliesOf', () => {
    it('counts each node’s links by kind and its review rounds in one aggregate', async () => {
      const busy = await node('busy');
      const bare = await node('bare');
      await linkAt(busy.nodeId, 'finding', 'F1', '2026-10-05T09:00:00Z');
      await linkAt(busy.nodeId, 'document', '/d.md', '2026-10-05T09:00:00Z');
      await linkAt(busy.nodeId, 'pull_request', PR_URL, '2026-10-05T09:00:00Z');
      for (const label of [
        'commission-change completed',
        'review-local-changes completed',
        'review-pull-request failed',
      ]) {
        const result = await linkPlanNode(ctx(), {
          nodeId: busy.nodeId,
          kind: 'run',
          ref: randomUUID(),
          label,
        });
        if (!result.ok) throw new Error(result.message);
      }

      const tallies = await store.linkTalliesOf(SPACE_ID, [busy.nodeId, bare.nodeId]);

      expect(tallies.get(busy.nodeId)).toEqual({
        runs: 3,
        pullRequests: 1,
        findings: 1,
        documents: 1,
        rounds: 2,
      });
      expect(tallies.has(bare.nodeId)).toBe(false);
    });
  });

  describe('newestPullRequestsOf', () => {
    it('reads each node’s newest pull request with the merge of that pull request, if linked', async () => {
      const merged = await node('merged');
      const open = await node('open');
      const older = 'https://github.com/aflowai/aflow/pull/170';
      await linkAt(merged.nodeId, 'pull_request', older, '2026-10-05T08:00:00Z');
      await linkAt(merged.nodeId, 'pull_request', PR_URL, '2026-10-05T09:00:00Z');
      await linkAt(merged.nodeId, 'merge', PR_URL, '2026-10-05T10:00:00Z');
      await linkAt(open.nodeId, 'pull_request', PR_URL, '2026-10-05T09:00:00Z');
      await linkAt(open.nodeId, 'merge', older, '2026-10-05T10:00:00Z');

      const newest = await store.newestPullRequestsOf(SPACE_ID, [merged.nodeId, open.nodeId]);

      expect(newest.get(merged.nodeId)).toMatchObject({
        ref: PR_URL,
        merge: { kind: 'merge', ref: PR_URL },
      });
      expect(newest.get(open.nodeId)).toEqual({ ref: PR_URL, merge: null });
    });
  });
});
