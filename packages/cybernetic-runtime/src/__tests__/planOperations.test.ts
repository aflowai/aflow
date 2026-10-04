import { describe, expect, it, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_NODE_LIST_MAX_LIMIT,
  PLAN_NODE_POSITION_MAX,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  PlanNodeRefusalDetailsSchema,
  type PlanNode,
  type PlanNodeCreateInput,
} from '@aflow/schemas';
import {
  createPlanNode,
  getPlanNode,
  listPlanNodes,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import { getAttentionCache, setAttentionCache } from '../attentionCache.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const OTHER_SPACE = '5e1d0000-0000-4000-8000-000000000999';

const NODE: PlanNodeCreateInput = {
  kind: 'execute',
  title: '315 · Local first-run ergonomics',
  goal: 'A new operator reaches a working space without help.',
  criteria: 'A clean machine’s yarn start ends serving a space.',
};

let store: InMemoryPlanNodeStore;
let redis: RedisType;

function session(name: string): PlanWriteContext {
  return { store, redis, tenantId: TENANT, spaceId: SPACE, createdBy: `operator-of-${name}` };
}

async function created(input: Partial<PlanNodeCreateInput> = {}): Promise<PlanNode> {
  const result = await createPlanNode(session('session-a'), { ...NODE, ...input });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

/** A root and one node under the last at each depth to `deepest`, indexed by depth. */
async function chainOf(deepest: number, title = 'level'): Promise<PlanNode[]> {
  const chain = [await created({ title: `${title} 0` })];
  for (let depth = 1; depth <= deepest; depth++) {
    chain.push(
      await created({ parentId: chain[depth - 1]!.nodeId, title: `${title} ${String(depth)}` }),
    );
  }
  return chain;
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  // ioredis-mock instances share one keyspace.
  await redis.flushall();
});

describe('createPlanNode', () => {
  it('records the node active at revision 1, created by the user behind the session', async () => {
    const node = await created();
    expect(node).toMatchObject({
      status: 'active',
      revision: 1,
      parentId: null,
      position: 0,
      createdBy: 'operator-of-session-a',
    });
  });

  it('places a node after its last sibling unless told where', async () => {
    const root = await created();
    const first = await created({ parentId: root.nodeId, title: 'first' });
    const second = await created({ parentId: root.nodeId, title: 'second' });
    const pinned = await created({ parentId: root.nodeId, title: 'pinned', position: 7 });
    expect([first.position, second.position, pinned.position]).toEqual([0, 1, 7]);
  });

  it('places a node after a sibling at the position ceiling at the ceiling, not past it', async () => {
    await created({ title: 'last', position: PLAN_NODE_POSITION_MAX });
    const after = await created({ title: 'after' });
    expect(after.position).toBe(PLAN_NODE_POSITION_MAX);
  });

  it('refuses a parent that is not in the space', async () => {
    const elsewhere = await createPlanNode({ ...session('session-a'), spaceId: OTHER_SPACE }, NODE);
    if (!elsewhere.ok) throw new Error(elsewhere.message);
    const result = await createPlanNode(session('session-a'), {
      ...NODE,
      parentId: elsewhere.node.nodeId,
    });
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
  });

  it(`refuses a child past depth ${String(PLAN_TREE_DEPTH_LIMIT)}, by name and depth, and writes nothing`, async () => {
    const chain = await chainOf(PLAN_TREE_DEPTH_LIMIT);
    const before = store.nodes.size;

    const tooDeep = await createPlanNode(session('session-a'), {
      ...NODE,
      parentId: chain[PLAN_TREE_DEPTH_LIMIT]!.nodeId,
    });
    expect(tooDeep).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_TOO_DEEP',
      details: {
        parentId: chain[PLAN_TREE_DEPTH_LIMIT]!.nodeId,
        parentDepth: PLAN_TREE_DEPTH_LIMIT,
        height: 0,
        depthLimit: PLAN_TREE_DEPTH_LIMIT,
      },
    });
    expect(!tooDeep.ok && tooDeep.message).toContain(
      `sits at depth ${String(PLAN_TREE_DEPTH_LIMIT)} (a root is depth 0) and a new node under it would sit at depth ${String(PLAN_TREE_DEPTH_LIMIT + 1)}`,
    );
    expect(store.nodes.size).toBe(before);
  });
});

describe('updatePlanNode — no lost update (Plan 322 D6)', () => {
  it('refuses the second of two updates decided on one revision, with the first’s write', async () => {
    const node = await created();

    // Both sessions open the node at revision 1.
    const first = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      note: 'next: F114 findings out of the plan file',
    });
    const second = await updatePlanNode(session('session-b'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      note: 'next: something else entirely',
    });

    expect(first).toMatchObject({ ok: true, node: { revision: 2 } });
    expect(second).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    if (second.ok) return;
    const now = store.nodes.get(node.nodeId)!;
    expect(PlanNodeRefusalDetailsSchema.parse(second.details)).toEqual({
      nodeId: node.nodeId,
      revision: 2,
      status: 'active',
      updatedAt: now.updatedAt,
      differingFields: ['note'],
    });
    expect(second.message).toContain('nothing was written');
    expect(second.message).toContain('plan.node.get');
    expect(store.nodes.get(node.nodeId)?.note).toBe('next: F114 findings out of the plan file');
  });

  it('refuses a write that loses the race between its read and its compare-and-set', async () => {
    const node = await created();
    const realFind = store.find;
    let interleaved = false;
    store.find = async (spaceId, nodeId) => {
      const read = await realFind(spaceId, nodeId);
      if (!interleaved) {
        interleaved = true;
        await store.updateAtRevision(spaceId, nodeId, 1, { note: 'written by session b' });
      }
      return read;
    };

    const result = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      note: 'written by session a',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_STALE',
      details: { nodeId: node.nodeId, revision: 2, differingFields: ['note'] },
    });
    expect(store.nodes.get(node.nodeId)).toMatchObject({
      revision: 2,
      note: 'written by session b',
    });
  });

  it('refuses a stale write on a large node with its revision and the differing fields, never its prose', async () => {
    const prose = 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS);
    const node = await created({ goal: prose, criteria: prose, note: prose });
    const moved = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'blocked',
    });
    if (!moved.ok) throw new Error(moved.message);

    const refused = await updatePlanNode(session('session-b'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'blocked',
      title: 'Renamed',
    });

    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    if (refused.ok) return;
    expect(refused.details).toEqual({
      nodeId: node.nodeId,
      revision: 2,
      status: 'blocked',
      updatedAt: moved.node.updatedAt,
      differingFields: ['title'],
    });
    expect(JSON.stringify(refused).length).toBeLessThan(PLAN_NODE_PROSE_MAX_CHARS);
  });

  it('answers an unknown node as not found', async () => {
    const result = await updatePlanNode(session('session-a'), {
      nodeId: '5e1d0000-0000-4000-8000-00000000dead',
      expectedRevision: 1,
      note: 'x',
    });
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
  });
});

describe('updatePlanNode — status, note and parent', () => {
  it('closes a node on done or dropped and reopens it on any other status', async () => {
    const node = await created();
    const done = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: 'Two clean machines reached a serving space.',
    });
    expect(done).toMatchObject({ ok: true, node: { status: 'done', revision: 2 } });
    expect(done.ok && done.node.closedAt).toBeTruthy();

    const reopened = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 2,
      status: 'active',
    });
    expect(reopened.ok && reopened.node.closedAt).toBeUndefined();
  });

  it('clears the note with an empty string', async () => {
    const node = await created({ note: 'first line' });
    const result = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      note: '',
    });
    expect(result.ok && result.node.note).toBeUndefined();
  });

  it('moves a node under another, after its last child, or back to the root', async () => {
    const a = await created({ title: 'a' });
    const b = await created({ title: 'b' });
    await created({ parentId: b.nodeId, title: 'b1' });

    const moved = await updatePlanNode(session('session-a'), {
      nodeId: a.nodeId,
      expectedRevision: 1,
      parentId: b.nodeId,
    });
    expect(moved).toMatchObject({ ok: true, node: { parentId: b.nodeId, position: 1 } });

    const back = await updatePlanNode(session('session-a'), {
      nodeId: a.nodeId,
      expectedRevision: 2,
      parentId: null,
    });
    expect(back).toMatchObject({ ok: true, node: { parentId: null } });
  });

  it('refuses to put a node under itself or under one of its descendants', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    const grandchild = await created({ parentId: child.nodeId });

    for (const parentId of [root.nodeId, grandchild.nodeId]) {
      const result = await updatePlanNode(session('session-a'), {
        nodeId: root.nodeId,
        expectedRevision: 1,
        parentId,
      });
      expect(result, parentId).toMatchObject({ ok: false, code: 'PLAN_NODE_CYCLE' });
    }
    expect(store.nodes.get(root.nodeId)?.revision).toBe(1);
  });

  it('refuses one of two moves that would close a loop between them, and the tree keeps its root', async () => {
    const a = await created({ title: 'a' });
    const b = await created({ title: 'b' });

    // Both sessions read their node, then move it under the other at once.
    const [aUnderB, bUnderA] = await Promise.all([
      updatePlanNode(session('session-a'), {
        nodeId: a.nodeId,
        expectedRevision: 1,
        parentId: b.nodeId,
      }),
      updatePlanNode(session('session-b'), {
        nodeId: b.nodeId,
        expectedRevision: 1,
        parentId: a.nodeId,
      }),
    ]);

    expect([aUnderB.ok, bUnderA.ok].sort()).toEqual([false, true]);
    const refused = aUnderB.ok ? bUnderA : aUnderB;
    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_CYCLE' });
    const roots = [...store.nodes.values()].filter((n) => n.parentId === null);
    expect(roots).toHaveLength(1);
    const tree = await listPlanNodes({ store, spaceId: SPACE }, {});
    expect(tree.ok && tree.nodes.map((n) => n.title).sort()).toEqual(['a', 'b']);
  });

  it(`refuses a move under a node at depth ${String(PLAN_TREE_DEPTH_LIMIT)}, by name and depth`, async () => {
    const chain = await chainOf(PLAN_TREE_DEPTH_LIMIT);
    const loose = await created({ title: 'loose' });

    const tooDeep = await updatePlanNode(session('session-a'), {
      nodeId: loose.nodeId,
      expectedRevision: 1,
      parentId: chain[PLAN_TREE_DEPTH_LIMIT]!.nodeId,
    });
    expect(tooDeep).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_TOO_DEEP',
      details: {
        nodeId: loose.nodeId,
        parentDepth: PLAN_TREE_DEPTH_LIMIT,
        height: 0,
        depthLimit: PLAN_TREE_DEPTH_LIMIT,
      },
    });
    expect(!tooDeep.ok && tooDeep.message).toContain(
      `sits at depth ${String(PLAN_TREE_DEPTH_LIMIT)}`,
    );

    const deepest = await updatePlanNode(session('session-a'), {
      nodeId: loose.nodeId,
      expectedRevision: 1,
      parentId: chain[PLAN_TREE_DEPTH_LIMIT - 1]!.nodeId,
    });
    expect(deepest).toMatchObject({ ok: true, node: { revision: 2 } });
  });

  it('counts the height of the subtree a move carries, not only the new parent’s depth', async () => {
    const SUBTREE_HEIGHT = 4;
    const chain = await chainOf(PLAN_TREE_DEPTH_LIMIT - SUBTREE_HEIGHT);
    const subtree = await chainOf(SUBTREE_HEIGHT, 'moved');
    const moved = subtree[0]!;
    // A shallower sibling branch must not hide the deeper one.
    await created({ parentId: moved.nodeId, title: 'moved shallow' });

    const deepParent = chain[PLAN_TREE_DEPTH_LIMIT - SUBTREE_HEIGHT]!;
    const tooDeep = await updatePlanNode(session('session-a'), {
      nodeId: moved.nodeId,
      expectedRevision: 1,
      parentId: deepParent.nodeId,
    });
    const deepest = PLAN_TREE_DEPTH_LIMIT + 1;
    expect(tooDeep).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_TOO_DEEP',
      details: {
        parentDepth: PLAN_TREE_DEPTH_LIMIT - SUBTREE_HEIGHT,
        height: SUBTREE_HEIGHT,
        depthLimit: PLAN_TREE_DEPTH_LIMIT,
      },
    });
    expect(!tooDeep.ok && tooDeep.message).toContain(
      `has ${String(SUBTREE_HEIGHT)} levels below it, so moving it there would put its deepest node at depth ${String(deepest)}`,
    );
    expect(store.nodes.get(moved.nodeId)).toMatchObject({ parentId: null, revision: 1 });

    const fits = await updatePlanNode(session('session-a'), {
      nodeId: moved.nodeId,
      expectedRevision: 1,
      parentId: chain[PLAN_TREE_DEPTH_LIMIT - SUBTREE_HEIGHT - 1]!.nodeId,
    });
    expect(fits).toMatchObject({ ok: true, node: { revision: 2 } });
  });
});

describe('updatePlanNode — reopening a closed node', () => {
  const OUTCOME = 'Two clean machines reached a serving space.';

  async function closed(status: 'done' | 'dropped', note?: string): Promise<PlanNode> {
    const node = await created(note !== undefined ? { note } : {});
    const result = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status,
      outcome: OUTCOME,
    });
    if (!result.ok) throw new Error(result.message);
    return result.node;
  }

  it('clears the outcome and keeps it as the first line of the note', async () => {
    const node = await closed('done', 'next: F114\nmore');
    const reopened = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'active',
    });
    expect(reopened.ok && reopened.node).not.toHaveProperty('outcome');
    expect(reopened.ok && reopened.node.note).toBe(
      `Reopened; it was done: ${OUTCOME}\nnext: F114\nmore`,
    );
    expect(store.nodes.get(node.nodeId)).not.toHaveProperty('outcome');
  });

  it('puts the outcome above a note written in the same update', async () => {
    const node = await closed('dropped', 'old note');
    const reopened = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'blocked',
      note: 'waiting on the operator',
    });
    expect(reopened.ok && reopened.node.note).toBe(
      `Reopened; it was dropped: ${OUTCOME}\nwaiting on the operator`,
    );
  });

  it('keeps the outcome alone when the same update clears the note', async () => {
    const node = await closed('done', 'old note');
    const reopened = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'active',
      note: '',
    });
    expect(reopened.ok && reopened.node.note).toBe(`Reopened; it was done: ${OUTCOME}`);
  });

  it('refuses a reopen whose note would pass the ceiling, by name, with the ceiling and the length', async () => {
    const head = `Reopened; it was done: ${OUTCOME}`;
    const room = PLAN_NODE_PROSE_MAX_CHARS - head.length - 1;
    const node = await closed('done', 'n'.repeat(room + 1));

    const refused = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'active',
    });

    expect(refused).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_NOTE_TOO_LONG',
      details: {
        nodeId: node.nodeId,
        noteLength: PLAN_NODE_PROSE_MAX_CHARS + 1,
        noteMaxChars: PLAN_NODE_PROSE_MAX_CHARS,
      },
    });
    expect(!refused.ok && refused.message).toContain(
      `which would then hold ${String(PLAN_NODE_PROSE_MAX_CHARS + 1)} characters; a note holds at most ${String(PLAN_NODE_PROSE_MAX_CHARS)}, so nothing was written`,
    );
    expect(!refused.ok && refused.message).toContain(
      `at most ${String(room)} characters fit under the reopened line`,
    );
    expect(store.nodes.get(node.nodeId)).toMatchObject({
      status: 'done',
      outcome: OUTCOME,
      revision: node.revision,
    });

    const trimmed = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'active',
      note: 'n'.repeat(room),
    });
    expect(trimmed.ok && trimmed.node.note?.length).toBe(PLAN_NODE_PROSE_MAX_CHARS);
  });

  it('refuses a reopen whose outcome alone would pass the note ceiling, and says to shorten it', async () => {
    const node = await created();
    const done = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: 'o'.repeat(PLAN_NODE_PROSE_MAX_CHARS),
    });
    if (!done.ok) throw new Error(done.message);

    const refused = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: done.node.revision,
      status: 'active',
      note: '',
    });

    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_NOTE_TOO_LONG' });
    expect(!refused.ok && refused.message).toContain(
      'Its outcome alone passes that: shorten the outcome with an update while the node is still done, then reopen it.',
    );
  });

  it('leaves the outcome of a node that moves between closed statuses', async () => {
    const node = await closed('done');
    const dropped = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'dropped',
    });
    expect(dropped).toMatchObject({ ok: true, node: { outcome: OUTCOME } });
    expect(dropped.ok && dropped.node).not.toHaveProperty('note');
  });
});

describe('updatePlanNode — only a closed node has an outcome', () => {
  const OUTCOME = 'Two clean machines reached a serving space.';

  it('refuses an outcome alone on an open node, by name, and writes nothing', async () => {
    const node = await created();
    const refused = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      outcome: OUTCOME,
    });

    expect(refused).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_OPEN_HAS_NO_OUTCOME',
      details: { nodeId: node.nodeId, status: 'active' },
    });
    expect(!refused.ok && refused.message).toContain(
      `Plan node "${node.title}" is active, and an open node has no outcome, so nothing was written.`,
    );
    expect(store.nodes.get(node.nodeId)).toMatchObject({ revision: 1 });
    expect(store.nodes.get(node.nodeId)).not.toHaveProperty('outcome');
  });

  it('refuses an outcome beside a reopening status the request schema never saw', async () => {
    const node = await created();
    const done = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: OUTCOME,
    });
    if (!done.ok) throw new Error(done.message);

    const refused = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: done.node.revision,
      status: 'waiting',
      outcome: 'A second outcome.',
    });
    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_OPEN_HAS_NO_OUTCOME' });
    expect(!refused.ok && refused.message).toContain('would be waiting after this update');
    expect(store.nodes.get(node.nodeId)).toMatchObject({ status: 'done', outcome: OUTCOME });
  });

  it('refuses as stale an outcome decided on a closed node that reopens before the write', async () => {
    const node = await created();
    const done = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: OUTCOME,
    });
    if (!done.ok) throw new Error(done.message);

    const realFind = store.find;
    let interleaved = false;
    store.find = async (spaceId, nodeId) => {
      const read = await realFind(spaceId, nodeId);
      if (!interleaved) {
        interleaved = true;
        await store.updateAtRevision(spaceId, nodeId, done.node.revision, {
          status: 'active',
          outcome: null,
          closedAt: null,
        });
      }
      return read;
    };

    const result = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: done.node.revision,
      outcome: 'Met on a third machine as well.',
    });

    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    expect(store.nodes.get(node.nodeId)).toMatchObject({ status: 'active' });
    expect(store.nodes.get(node.nodeId)).not.toHaveProperty('outcome');
  });

  it('rewrites the outcome of a node that stays closed', async () => {
    const node = await created();
    const done = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: OUTCOME,
    });
    if (!done.ok) throw new Error(done.message);

    const rewritten = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: done.node.revision,
      outcome: 'Met on a third machine as well.',
    });
    expect(rewritten).toMatchObject({
      ok: true,
      node: { status: 'done', outcome: 'Met on a third machine as well.', revision: 3 },
    });
  });
});

describe('updatePlanNode — an update that changes nothing is refused', () => {
  it('refuses every update whose fields equal the node’s, with the node, and bumps nothing', async () => {
    const parent = await created({ title: 'parent' });
    const node = await created({ parentId: parent.nodeId, title: 'child', note: 'next: F114' });
    const noOps = [
      { note: 'next: F114' },
      { title: 'child', criteria: node.criteria },
      { status: 'active' as const },
      { parentId: parent.nodeId, position: node.position },
    ];

    for (const fields of noOps) {
      const read = await getAttentionCache(redis, TENANT, SPACE);
      await setAttentionCache(redis, TENANT, SPACE, '{"cached":true}', read.generation);

      const refused = await updatePlanNode(session('session-a'), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        ...fields,
      });

      expect(refused, JSON.stringify(fields)).toMatchObject({
        ok: false,
        code: 'PLAN_NODE_UNCHANGED',
      });
      if (refused.ok) return;
      expect(PlanNodeRefusalDetailsSchema.parse(refused.details)).toEqual({
        nodeId: node.nodeId,
        revision: node.revision,
        status: node.status,
        updatedAt: node.updatedAt,
        differingFields: [],
      });
      expect(refused.message).toContain(
        `already stands as this update would leave it, so nothing was written and it stays at revision ${String(node.revision)}`,
      );
      expect((await getAttentionCache(redis, TENANT, SPACE)).value).toBe('{"cached":true}');
    }
    expect(store.nodes.get(node.nodeId)).toMatchObject({ revision: node.revision });
  });

  it('refuses clearing a note the node does not have, and the same outcome on a closed node', async () => {
    const node = await created();
    const clear = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      note: '',
    });
    expect(clear).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED' });

    const done = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: 'Met.',
    });
    if (!done.ok) throw new Error(done.message);
    const again = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: done.node.revision,
      status: 'done',
      outcome: 'Met.',
    });
    expect(again).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED' });
    expect(store.nodes.get(node.nodeId)).toMatchObject({
      revision: done.node.revision,
      closedAt: done.node.closedAt,
    });
  });

  it('writes an update that changes any one field, beside others that do not', async () => {
    const node = await created({ note: 'next: F114' });
    const result = await updatePlanNode(session('session-a'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      note: 'next: F114',
      title: 'Renamed',
    });
    expect(result).toMatchObject({ ok: true, node: { title: 'Renamed', revision: 2 } });
  });
});

describe('plan writes invalidate the attention block', () => {
  async function cachedAttention(): Promise<string | null> {
    return (await getAttentionCache(redis, TENANT, SPACE)).value;
  }

  it('bumps the space’s attention generation on create and on update, and not on a read or a refusal', async () => {
    const prime = async () => {
      const read = await getAttentionCache(redis, TENANT, SPACE);
      await setAttentionCache(redis, TENANT, SPACE, '{"cached":true}', read.generation);
      expect(await cachedAttention()).toBe('{"cached":true}');
    };

    await prime();
    const node = await created();
    expect(await cachedAttention()).toBeNull();

    await prime();
    await getPlanNode({ store, spaceId: SPACE }, node.nodeId);
    await listPlanNodes({ store, spaceId: SPACE }, {});
    await updatePlanNode(session('session-b'), {
      nodeId: node.nodeId,
      expectedRevision: 9,
      note: 'stale',
    });
    expect(await cachedAttention()).toBe('{"cached":true}');

    await updatePlanNode(session('session-b'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      note: 'next',
    });
    expect(await cachedAttention()).toBeNull();
  });
});

describe('getPlanNode / listPlanNodes', () => {
  it('opens a node with its children in order', async () => {
    const root = await created();
    await created({ parentId: root.nodeId, title: 'second', position: 2 });
    await created({ parentId: root.nodeId, title: 'first', position: 1 });

    const result = await getPlanNode({ store, spaceId: SPACE }, root.nodeId);
    expect(result).toMatchObject({ ok: true, node: { nodeId: root.nodeId }, childrenTotal: 2 });
    expect(result.ok && result.children.map((c) => c.title)).toEqual(['first', 'second']);
  });

  it('lists parents before children, filtered by status and to one subtree', async () => {
    const one = await created({ title: 'one' });
    const oneA = await created({ parentId: one.nodeId, title: 'one.a', note: 'next: x\nmore' });
    await created({ parentId: oneA.nodeId, title: 'one.a.i' });
    const two = await created({ title: 'two' });
    await updatePlanNode(session('session-a'), {
      nodeId: two.nodeId,
      expectedRevision: 1,
      status: 'dropped',
      outcome: 'Superseded by one.',
    });

    const open = await listPlanNodes({ store, spaceId: SPACE }, {});
    expect(open.ok && open.nodes.map((n) => n.title)).toEqual(['one', 'one.a', 'one.a.i']);
    expect(open.ok && open.nodes[1]?.noteHead).toBe('next: x');

    const dropped = await listPlanNodes({ store, spaceId: SPACE }, { status: ['dropped'] });
    expect(dropped.ok && dropped.nodes.map((n) => n.title)).toEqual(['two']);

    const subtree = await listPlanNodes({ store, spaceId: SPACE }, { rootId: oneA.nodeId });
    expect(subtree.ok && subtree.nodes.map((n) => n.title)).toEqual(['one.a', 'one.a.i']);

    const bounded = await listPlanNodes({ store, spaceId: SPACE }, { limit: 2 });
    expect(bounded).toMatchObject({ ok: true, truncated: { bound: 'limit', value: 2 } });
    expect(bounded.ok && bounded.nodes).toHaveLength(2);
    expect(open).not.toHaveProperty('truncated');
  });

  it('finds a root by its key past the most nodes a walk reads, and names that bound', async () => {
    for (let i = 0; i < PLAN_TREE_WALK_NODE_LIMIT; i++) {
      await store.insert(SPACE, {
        parentId: null,
        kind: 'execute',
        title: `filler ${String(i)}`,
        goal: NODE.goal,
        criteria: NODE.criteria,
        note: null,
        position: i,
        createdBy: null,
      });
    }
    const last = await created({ title: 'last', position: PLAN_TREE_WALK_NODE_LIMIT });
    await created({ parentId: last.nodeId, title: 'last.a' });

    const whole = await listPlanNodes({ store, spaceId: SPACE }, {});
    expect(whole).toMatchObject({
      ok: true,
      truncated: { bound: 'nodes', value: PLAN_TREE_WALK_NODE_LIMIT },
    });

    const subtree = await listPlanNodes({ store, spaceId: SPACE }, { rootId: last.nodeId });
    expect(subtree.ok && subtree.nodes.map((n) => n.title)).toEqual(['last', 'last.a']);
    expect(subtree).not.toHaveProperty('truncated');
  });

  it(`names the depth bound when rows sit more than ${String(PLAN_TREE_DEPTH_LIMIT)} levels down`, async () => {
    // No create or move leaves a node there; the walk is bounded all the same.
    let parent = store.seed(SPACE, { title: 'level 0' });
    const root = parent;
    for (let depth = 1; depth <= PLAN_TREE_DEPTH_LIMIT + 1; depth++) {
      parent = store.seed(SPACE, { parentId: parent.nodeId, title: `level ${String(depth)}` });
    }

    const result = await listPlanNodes(
      { store, spaceId: SPACE },
      { rootId: root.nodeId, limit: PLAN_NODE_LIST_MAX_LIMIT },
    );
    expect(result).toMatchObject({
      ok: true,
      truncated: { bound: 'depth', value: PLAN_TREE_DEPTH_LIMIT },
    });
    expect(result.ok && result.nodes).toHaveLength(PLAN_TREE_DEPTH_LIMIT + 1);
  });

  it('lists every open node past more closed ones than a walk reads, and reaches closed ones by status', async () => {
    const CLOSED = PLAN_TREE_WALK_NODE_LIMIT + 1;
    for (let i = 0; i < CLOSED; i++) {
      store.seed(SPACE, { title: `closed ${String(i)}`, status: 'done', position: i });
    }
    const open = await created({ title: 'open', position: CLOSED });
    await created({ parentId: open.nodeId, title: 'open.a' });
    const doneParent = await created({ title: 'done parent', position: CLOSED + 1 });
    await created({ parentId: doneParent.nodeId, title: 'open under done' });
    await updatePlanNode(session('session-a'), {
      nodeId: doneParent.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: 'Met.',
    });

    const listed = await listPlanNodes({ store, spaceId: SPACE }, {});
    expect(listed.ok && listed.nodes.map((n) => n.title)).toEqual(['open', 'open.a']);
    expect(listed).not.toHaveProperty('truncated');

    const throughClosed = await listPlanNodes(
      { store, spaceId: SPACE },
      { status: ['active', 'done'], rootId: doneParent.nodeId },
    );
    expect(throughClosed.ok && throughClosed.nodes.map((n) => n.title)).toEqual([
      'done parent',
      'open under done',
    ]);

    const done = await listPlanNodes({ store, spaceId: SPACE }, { status: ['done'] });
    expect(done).toMatchObject({
      ok: true,
      truncated: { bound: 'nodes', value: PLAN_TREE_WALK_NODE_LIMIT },
    });
  });

  it('orders siblings sharing a position the same way in get and in list', async () => {
    const root = await created();
    for (const title of ['x', 'y', 'z']) {
      await created({ parentId: root.nodeId, title, position: 0 });
    }

    const got = await getPlanNode({ store, spaceId: SPACE }, root.nodeId);
    const listed = await listPlanNodes({ store, spaceId: SPACE }, { rootId: root.nodeId });
    const byId = (got.ok ? got.children : []).map((c) => c.nodeId);
    expect(byId).toEqual([...byId].sort());
    expect(listed.ok && listed.nodes.slice(1).map((n) => n.nodeId)).toEqual(byId);
  });

  it('answers an unknown root as not found', async () => {
    const result = await listPlanNodes(
      { store, spaceId: SPACE },
      { rootId: '5e1d0000-0000-4000-8000-00000000dead' },
    );
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
  });
});
