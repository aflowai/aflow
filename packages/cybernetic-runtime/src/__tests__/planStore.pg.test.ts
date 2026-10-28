/**
 * Plan placement against a real database.
 *
 * The engine's tests prove a write's placement checks and the write are one
 * step of the store; only Postgres can show that the step holds when two moves
 * that cross each other run at once — each walk locking the rows the other
 * needs, one of them ended as a deadlock and refused as a cycle on its next
 * attempt — and that the store's own SQL measures a subtree and sums a
 * position as the fake does, and that the overview's one recursive query
 * returns open steps alone, counts the closed ones per plan and carries each
 * step's root, phase and closed ancestor as the fake does. Gated on
 * DATABASE_URL like every pg test.
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
import {
  PLAN_NODE_POSITION_MAX,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  PlanBoardOutputSchema,
  PlanOverviewOutputSchema,
  type PlanNode,
} from '@aflow/schemas';
import {
  createPlanNode,
  linkPlanNode,
  listPlanNodes,
  readPlanBoard,
  readPlanOverview,
  updatePlanNode,
} from '../plan/operations.js';
import { createPlanNodeStore } from '../plan/store.js';
import { mergeLinkLabel } from '../plan/stream.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = randomUUID();
/** Pairs raced at once, so that some of them overlap inside their transactions. */
const RACING_PAIRS = 8;
const PR_URL = 'https://github.com/aflowai/aflow/pull/181';

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

  it('measures the height a move carries in SQL and refuses it past the depth limit', async () => {
    const chain = [await node('deep 0')];
    for (let depth = 1; depth <= PLAN_TREE_DEPTH_LIMIT - 1; depth++) {
      chain.push(await node(`deep ${String(depth)}`, chain[depth - 1]!.nodeId));
    }
    const moved = await node('moved');
    await node('moved.a', (await node('moved.b', moved.nodeId)).nodeId);

    const refused = await move(moved.nodeId, chain[PLAN_TREE_DEPTH_LIMIT - 2]!.nodeId);
    expect(refused).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_TOO_DEEP',
      details: { parentDepth: PLAN_TREE_DEPTH_LIMIT - 2, height: 2 },
    });

    const tooDeepChild = await createPlanNode(ctx, {
      kind: 'execute',
      title: 'past the limit',
      goal: 'Be refused.',
      criteria: 'It is not written.',
      parentId: (await node('deepest', chain[PLAN_TREE_DEPTH_LIMIT - 1]!.nodeId)).nodeId,
    });
    expect(tooDeepChild).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_TOO_DEEP',
      details: { parentDepth: PLAN_TREE_DEPTH_LIMIT },
    });
  });

  it('places a node after a sibling at the INTEGER ceiling without overflowing', async () => {
    const root = await node('ceiling root');
    await createPlanNode(ctx, {
      kind: 'execute',
      title: 'at the ceiling',
      goal: 'Sit last.',
      criteria: 'Its position is the ceiling.',
      parentId: root.nodeId,
      position: PLAN_NODE_POSITION_MAX,
    });
    expect(await node('after it', root.nodeId)).toMatchObject({
      position: PLAN_NODE_POSITION_MAX,
    });
  });

  it('reads the whole plan as a board: counts, rounds, newest pull request and progress, no links', async () => {
    const root = await node('tree root');
    const busy = await node('busy', root.nodeId);
    const done = await node('done', root.nodeId);
    for (let i = 0; i < 3; i++) {
      await linkPlanNode(ctx, { nodeId: busy.nodeId, kind: 'finding', ref: `F${String(i)}` });
    }
    await linkPlanNode(ctx, {
      nodeId: busy.nodeId,
      kind: 'run',
      ref: randomUUID(),
      label: 'review-local-changes completed',
    });
    await linkPlanNode(ctx, { nodeId: done.nodeId, kind: 'pull_request', ref: PR_URL });
    await linkPlanNode(ctx, {
      nodeId: done.nodeId,
      kind: 'merge',
      ref: PR_URL,
      label: mergeLinkLabel('2026-10-05T10:00:00.000Z', 'abc1234'),
    });
    await updatePlanNode(ctx, {
      nodeId: done.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: `Merged ${PR_URL}.`,
    });

    const read = await readPlanBoard({ store, spaceId: SPACE_ID }, root.nodeId);
    const board = read.ok ? PlanBoardOutputSchema.parse(read) : undefined;
    const tree = board?.root;

    expect(tree?.progress).toEqual({ done: 1, total: 2 });
    expect(
      tree?.children.map((c) => [c.title, c.counts.findings, c.counts.runs, c.rounds]),
    ).toEqual([
      ['busy', 3, 1, 1],
      ['done', 0, 0, 0],
    ]);
    expect(tree?.children[1]).toMatchObject({
      status: 'done',
      goalHead: 'Hold its place in the tree.',
      pullRequest: { url: PR_URL, merged: true, mergeSha: 'abc1234' },
    });
    expect(tree?.children[1]).not.toHaveProperty('outcome');
    expect(tree?.children[1]?.closedAt).toEqual(expect.any(String));
    expect(board?.tally).toMatchObject({
      rootId: root.nodeId,
      steps: 2,
      done: 1,
    });
  });

  it('writes a goal on the row at its revision, refuses it stale or unchanged, and the board reads it', async () => {
    const amended = 'Hold its place in the tree, under its amended goal.';
    const target = await node('goal target');

    const written = await updatePlanNode(ctx, {
      nodeId: target.nodeId,
      expectedRevision: 1,
      goal: amended,
    });
    expect(written).toMatchObject({ ok: true, node: { goal: amended, revision: 2 } });
    expect(await store.find(SPACE_ID, target.nodeId)).toMatchObject({ goal: amended, revision: 2 });

    const stale = await updatePlanNode(ctx, {
      nodeId: target.nodeId,
      expectedRevision: 1,
      goal: 'Decided against the first revision.',
    });
    expect(stale).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_STALE',
      details: { revision: 2, differingFields: ['goal'] },
    });

    const same = await updatePlanNode(ctx, {
      nodeId: target.nodeId,
      expectedRevision: 2,
      goal: amended,
    });
    expect(same).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED' });
    expect(await store.find(SPACE_ID, target.nodeId)).toMatchObject({ goal: amended, revision: 2 });

    const read = await readPlanBoard({ store, spaceId: SPACE_ID }, target.nodeId);
    expect(read.ok && PlanBoardOutputSchema.parse(read).root.goalHead).toBe(amended);
  });

  describe('the overview read (Plan 332 D7)', () => {
    const spaces: string[] = [];
    const bounds = { maxDepth: PLAN_TREE_DEPTH_LIMIT, maxNodes: PLAN_TREE_WALK_NODE_LIMIT };

    /** The overview's read alone: nothing placed, nothing looked up. */
    async function readOnly(spaceId: string) {
      const snapshot = await store.readOverview(spaceId, bounds, () => ({
        placed: null,
        pullRequestsOf: [],
        runsOf: [],
        runsPerNode: 1,
      }));
      return snapshot.read;
    }

    afterAll(async () => {
      if (!tablePresent || spaces.length === 0) return;
      await withTenantSchema(handle.db, tenantCtx, (tx) =>
        tx.execute(
          drizzleSql`DELETE FROM plan_nodes WHERE space_id IN (${drizzleSql.join(
            spaces.map((s) => drizzleSql`${s}::uuid`),
            drizzleSql`, `,
          )})`,
        ),
      );
    });

    function space(): { spaceId: string; ctx: typeof ctx } {
      const spaceId = randomUUID();
      spaces.push(spaceId);
      return { spaceId, ctx: { ...ctx, spaceId } };
    }

    /** Writes `count` rows under `parentId` in one statement, past every rule, positions from `from`. */
    async function bulk(
      spaceId: string,
      parentId: string,
      count: number,
      status: 'done' | 'active',
      from = 0,
    ): Promise<void> {
      await withTenantSchema(handle.db, tenantCtx, (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO plan_nodes (space_id, parent_id, kind, title, goal, criteria, status, position, closed_at)
          SELECT ${spaceId}::uuid, ${parentId}::uuid, 'execute', 'bulk ' || g, 'Seeded.', 'Seeded.',
            ${status}::text, ${from}::int + g, CASE WHEN ${status}::text = 'done' THEN now() END
          FROM generate_series(0, ${count - 1}::int) AS g
        `),
      );
    }

    it('returns no done step as a row and reaches no bound over 1,500 done steps and 10 open', async () => {
      const { spaceId, ctx: here } = space();
      const roots: PlanNode[] = [];
      for (let n = 0; n < 10; n++) {
        const result = await createPlanNode(here, {
          kind: 'execute',
          title: `plan ${String(n)}`,
          goal: 'Hold steps.',
          criteria: 'It holds them.',
          position: n,
        });
        if (!result.ok) throw new Error(result.message);
        roots.push(result.node);
        await bulk(spaceId, result.node.nodeId, 150, 'done');
        await bulk(spaceId, result.node.nodeId, 1, 'active', 9000);
      }

      const read = await readOnly(spaceId);
      const overview = PlanOverviewOutputSchema.parse(await readPlanOverview({ store, spaceId }));

      expect(read.truncated).toBeUndefined();
      expect(read.rootsTotal).toBe(10);
      expect(read.nodes).toHaveLength(20);
      expect(read.nodes.every((n) => n.status === 'active')).toBe(true);
      expect([...read.counted.values()].every((c) => c.done === 150 && !c.cut)).toBe(true);
      expect(overview.truncated).toBeUndefined();
      expect(overview.lanes.truncated).toBeUndefined();
      expect(overview.roots.map((r) => [r.nodeId, r.counts?.steps, r.counts?.done])).toEqual(
        roots.map((r) => [r.nodeId, 151, 150]),
      );
      expect(overview.lanes.upNext.items.map((i) => i.rootId)).toEqual(roots.map((r) => r.nodeId));
    });

    it('stops the recursion at the node bound over 5,000 done steps, and says so on every plan and the lanes', async () => {
      const { spaceId, ctx: here } = space();
      for (let n = 0; n < 10; n++) {
        const result = await createPlanNode(here, {
          kind: 'execute',
          title: `plan ${String(n)}`,
          goal: 'Hold steps.',
          criteria: 'It holds them.',
          position: n,
        });
        if (!result.ok) throw new Error(result.message);
        await bulk(spaceId, result.node.nodeId, 500, 'done');
        await bulk(spaceId, result.node.nodeId, 1, 'active', 9000);
      }

      const read = await readOnly(spaceId);
      const overview = PlanOverviewOutputSchema.parse(await readPlanOverview({ store, spaceId }));

      expect(read.truncated).toEqual({ bound: 'nodes', value: bounds.maxNodes });
      expect(read.rootsTotal).toBe(10);
      const counted = [...read.counted.values()];
      // The walk held at most the bound, closed steps included.
      expect(counted.reduce((sum, c) => sum + c.done, 0) + read.nodes.length).toBeLessThanOrEqual(
        bounds.maxNodes,
      );
      expect(counted.every((c) => c.cut)).toBe(true);
      expect(overview.truncated).toBeUndefined();
      expect(overview.roots).toHaveLength(10);
      expect(overview.roots.every((r) => r.truncated?.bound === 'nodes')).toBe(true);
      expect(overview.lanes.truncated).toEqual({ bound: 'nodes', value: bounds.maxNodes });
    });

    it('keeps the lowest-positioned roots past the node bound, the open plan written last among them', async () => {
      const { spaceId, ctx: here } = space();
      await withTenantSchema(handle.db, tenantCtx, (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO plan_nodes (space_id, parent_id, kind, title, goal, criteria, status, position, closed_at)
          SELECT ${spaceId}::uuid, NULL, 'execute', 'shut ' || g, 'Seeded.', 'Seeded.', 'done', g, now()
          FROM generate_series(1, ${bounds.maxNodes + 1}::int) AS g
        `),
      );
      const open = await createPlanNode(here, {
        kind: 'execute',
        title: 'open plan',
        goal: 'Hold steps.',
        criteria: 'It holds them.',
        position: 0,
      });
      if (!open.ok) throw new Error(open.message);

      const read = await readOnly(spaceId);
      const overview = PlanOverviewOutputSchema.parse(await readPlanOverview({ store, spaceId }));

      expect(read.truncated).toEqual({ bound: 'nodes', value: bounds.maxNodes });
      expect(read.rootsTotal).toBe(bounds.maxNodes + 2);
      const positions = read.nodes.map((n) => n.position).sort((a, b) => a - b);
      expect(positions).toEqual(Array.from({ length: bounds.maxNodes }, (_, i) => i));
      expect(overview.roots[0]).toMatchObject({ nodeId: open.node.nodeId, status: 'active' });
    });

    it('keeps the first siblings in reading order where the node bound cuts a level', async () => {
      const { spaceId, ctx: here } = space();
      const root = await createPlanNode(here, {
        kind: 'execute',
        title: 'plan',
        goal: 'Hold steps.',
        criteria: 'It holds them.',
      });
      if (!root.ok) throw new Error(root.message);
      // The later siblings are written first, so the table's own order is not reading order.
      await bulk(spaceId, root.node.nodeId, 1100, 'active', 1000);
      await bulk(spaceId, root.node.nodeId, 1000, 'active', 0);

      const read = await readOnly(spaceId);
      const overview = PlanOverviewOutputSchema.parse(await readPlanOverview({ store, spaceId }));

      expect(read.truncated).toEqual({ bound: 'nodes', value: bounds.maxNodes });
      const steps = read.nodes.filter((n) => n.depth === 1);
      expect(steps.map((n) => n.position)).toEqual(
        Array.from({ length: bounds.maxNodes - 1 }, (_, i) => i),
      );
      expect(read.counted.get(root.node.nodeId)).toMatchObject({ cut: true });
      expect(overview.lanes.upNext.items).toMatchObject([
        { nodeId: steps[0]!.nodeId, rootId: root.node.nodeId },
      ]);
    });

    it('shows a blocked step in the last of 50 plans in Needs you', async () => {
      const { spaceId, ctx: here } = space();
      let last: PlanNode | undefined;
      for (let n = 0; n < 50; n++) {
        const result = await createPlanNode(here, {
          kind: 'execute',
          title: `plan ${String(n)}`,
          goal: 'Hold steps.',
          criteria: 'It holds them.',
          position: n,
        });
        if (!result.ok) throw new Error(result.message);
        last = result.node;
        await bulk(spaceId, last.nodeId, 3, 'done');
      }
      const stop = await createPlanNode(here, {
        kind: 'execute',
        title: 'waits on the operator',
        goal: 'Wait.',
        criteria: 'Approved.',
        parentId: last!.nodeId,
        note: 'Proposed from the merged plan document; awaits the operator’s approval',
      });
      if (!stop.ok) throw new Error(stop.message);
      await updatePlanNode(here, {
        nodeId: stop.node.nodeId,
        expectedRevision: 1,
        status: 'blocked',
      });

      const overview = PlanOverviewOutputSchema.parse(await readPlanOverview({ store, spaceId }));

      expect(overview.roots).toHaveLength(50);
      expect(overview.lanes.needsYou).toMatchObject({
        total: 1,
        items: [
          {
            nodeId: stop.node.nodeId,
            reason: 'blocked',
            rootId: last!.nodeId,
            noteHead: 'Proposed from the merged plan document; awaits the operator’s approval',
          },
        ],
      });
    });

    it('carries each open step’s root, phase and closed ancestor as the fake store does', async () => {
      const { spaceId, ctx: here } = space();
      const make = async (title: string, parentId?: string, position?: number) => {
        const result = await createPlanNode(here, {
          kind: 'execute',
          title,
          goal: 'Hold its place.',
          criteria: 'It is there.',
          ...(parentId !== undefined ? { parentId } : {}),
          ...(position !== undefined ? { position } : {}),
        });
        if (!result.ok) throw new Error(result.message);
        return result.node;
      };
      const closeIt = async (target: PlanNode) => {
        const fresh = await store.find(spaceId, target.nodeId);
        const result = await updatePlanNode(here, {
          nodeId: target.nodeId,
          expectedRevision: fresh!.revision,
          status: 'done',
          outcome: 'It landed.',
        });
        if (!result.ok) throw new Error(result.message);
      };
      const root = await make('root', undefined, 0);
      const phase = await make('P6 — a phase', root.nodeId, 0);
      const stranded = await make('P6.a', phase.nodeId, 0);
      const deeper = await make('P6.a.1', stranded.nodeId, 0);
      const next = await make('P7', root.nodeId, 1);
      await closeIt(phase);
      const shut = await make('shut', undefined, 1);
      await make('under shut', shut.nodeId);
      await closeIt(shut);

      const read = await readOnly(spaceId);
      const byId = new Map(read.nodes.map((n) => [n.nodeId, n]));

      expect(read.nodes.map((n) => n.title)).toEqual(['root', 'shut', 'P7', 'P6.a', 'P6.a.1']);
      expect(read.rootsTotal).toBe(2);
      expect(byId.get(stranded.nodeId)).toMatchObject({
        rootId: root.nodeId,
        depth: 2,
        openParentId: root.nodeId,
        closedAncestor: { nodeId: phase.nodeId, title: 'P6 — a phase' },
        phaseTitle: 'P6 — a phase',
        inFlightRuns: 0,
      });
      expect(byId.get(deeper.nodeId)).toMatchObject({
        depth: 3,
        openParentId: stranded.nodeId,
        closedAncestor: { nodeId: phase.nodeId },
      });
      expect(byId.get(next.nodeId)).toMatchObject({ depth: 1, openParentId: root.nodeId });
      expect(byId.get(next.nodeId)).not.toHaveProperty('phaseTitle');
      // Reading order across the read: the root, its phase's steps, then P7.
      const order = read.nodes
        .filter((n) => n.rootId === root.nodeId)
        .sort((a, b) => a.walkOrder - b.walkOrder)
        .map((n) => n.title);
      expect(order).toEqual(['root', 'P6.a', 'P6.a.1', 'P7']);
      expect(read.counted.get(root.nodeId)).toMatchObject({ done: 1, dropped: 0, cut: false });
      expect(read.counted.get(shut.nodeId)).toMatchObject({ done: 0, cut: false });
      // The rail's own read of a step names the same closed node above it.
      expect(await store.closedAncestorOf(spaceId, deeper.nodeId)).toEqual({
        nodeId: phase.nodeId,
        title: 'P6 — a phase',
      });
      expect(await store.closedAncestorOf(spaceId, next.nodeId)).toBeNull();
      expect(await store.closedAncestorOf(spaceId, root.nodeId)).toBeNull();
    });
  });
});
