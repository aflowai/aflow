import { describe, expect, it, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type { PlanNode, PlanNodeCreateInput, PlanNodeStaleErrorDetails } from '@aflow/schemas';
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

  it('refuses a parent that is not in the space', async () => {
    const elsewhere = await createPlanNode({ ...session('session-a'), spaceId: OTHER_SPACE }, NODE);
    if (!elsewhere.ok) throw new Error(elsewhere.message);
    const result = await createPlanNode(session('session-a'), {
      ...NODE,
      parentId: elsewhere.node.nodeId,
    });
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
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
    const details = second.details as unknown as PlanNodeStaleErrorDetails;
    expect(details.currentRevision).toBe(2);
    expect(details.node.note).toBe('next: F114 findings out of the plan file');
    expect(second.message).toContain('nothing was written');
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

    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    expect(store.nodes.get(node.nodeId)).toMatchObject({
      revision: 2,
      note: 'written by session b',
    });
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
    expect(bounded).toMatchObject({ ok: true, truncated: true });
    expect(bounded.ok && bounded.nodes).toHaveLength(2);
  });

  it('answers an unknown root as not found', async () => {
    const result = await listPlanNodes(
      { store, spaceId: SPACE },
      { rootId: '5e1d0000-0000-4000-8000-00000000dead' },
    );
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
  });
});
