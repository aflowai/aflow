/**
 * The operator's open and place writes (Plan 332 D6). Open moves a blocked,
 * done or dropped node to active through `updatePlanNode`, leaving the note by
 * the engine's rule for each; place puts a node before or after a sibling,
 * renumbering the siblings only where no integer lies between its neighbours
 * — moving no sibling's place, and so no sibling's revision.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { PLAN_NODE_POSITION_MAX, PLAN_NODE_PROSE_MAX_CHARS, type PlanNode } from '@aflow/schemas';
import {
  openPlanNode,
  placePlanNode,
  revisePlanNode,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import { PLAN_PLACE_STRIDE, placeAmongSiblings } from '../plan/placement.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000332';
const SPACE = '5e1d0000-0000-4000-8000-000000000332';
const MISSING = '5e1d0000-0000-4000-8000-00000000dead';

let store: InMemoryPlanNodeStore;
let redis: RedisType;

function ctx(): PlanWriteContext {
  return { store, redis, tenantId: TENANT, spaceId: SPACE, createdBy: 'operator' };
}

function seed(title: string, values: Partial<PlanNode> = {}): PlanNode {
  return store.seed(SPACE, { title, ...values });
}

/** The children of `parentId` as the board orders them: by position, then id. */
function order(parentId: string | null): string[] {
  return [...store.nodes.values()]
    .filter((n) => n.spaceId === SPACE && n.parentId === parentId)
    .sort((a, b) => a.position - b.position || (a.nodeId < b.nodeId ? -1 : 1))
    .map((n) => n.title);
}

function revisions(): Record<string, number> {
  return Object.fromEntries([...store.nodes.values()].map((n) => [n.title, n.revision]));
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('openPlanNode — Approve on a blocked node', () => {
  it('puts the reason above the note as it stands, so it is the note’s first line', async () => {
    const node = seed('P1 — the loop takes the next node', {
      status: 'blocked',
      revision: 3,
      note: 'Proposed from the merged plan document; awaits the operator’s approval\nnext: the resident',
    });

    const result = await openPlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: 3,
      why: 'go ahead after Plan 330',
    });

    expect(result).toMatchObject({
      ok: true,
      from: 'blocked',
      node: { status: 'active', revision: 4 },
    });
    expect(store.nodes.get(node.nodeId)?.note).toBe(
      'Approved: go ahead after Plan 330\n' +
        'Proposed from the merged plan document; awaits the operator’s approval\nnext: the resident',
    );
  });

  it('leaves the note alone without a reason, and gives a node with no note just the reason', async () => {
    const kept = seed('kept', { status: 'blocked', note: 'needs a GitHub binding' });
    const bare = seed('bare', { status: 'blocked' });

    await openPlanNode(ctx(), { nodeId: kept.nodeId, expectedRevision: 1 });
    await openPlanNode(ctx(), { nodeId: bare.nodeId, expectedRevision: 1, why: 'bound now' });

    expect(store.nodes.get(kept.nodeId)).toMatchObject({
      status: 'active',
      note: 'needs a GitHub binding',
    });
    expect(store.nodes.get(bare.nodeId)).toMatchObject({
      status: 'active',
      note: 'Approved: bound now',
    });
  });
});

describe('openPlanNode — Reopen on a closed node', () => {
  const closed = (status: 'done' | 'dropped', outcome?: string) =>
    seed(`a ${status} step`, {
      status,
      revision: 5,
      ...(outcome !== undefined ? { outcome } : {}),
      note: 'the working note of the closed work',
      closedAt: '2026-10-20T09:00:00.000Z',
    });

  it('heads the note with what it claimed, the reason after it in place of the prior note', async () => {
    const node = closed('done', 'Merged in #212.');

    const result = await openPlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: 5,
      why: 'the column rule misreads waiting steps',
    });

    expect(result).toMatchObject({
      ok: true,
      from: 'done',
      node: { status: 'active', revision: 6 },
    });
    const now = store.nodes.get(node.nodeId)!;
    expect(now.note).toBe(
      'Reopened; it was done: Merged in #212.\nReopened: the column rule misreads waiting steps',
    );
    expect(now.outcome).toBeUndefined();
    expect(now.closedAt).toBeUndefined();
  });

  it('keeps the prior note under the engine’s line when no reason is given', async () => {
    const node = closed('dropped', 'Superseded by P3.');

    await openPlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 5 });

    expect(store.nodes.get(node.nodeId)?.note).toBe(
      'Reopened; it was dropped: Superseded by P3.\nthe working note of the closed work',
    );
  });
});

describe('openPlanNode — refusals', () => {
  it('refuses an active or a waiting node as unchanged, and writes nothing', async () => {
    for (const status of ['active', 'waiting'] as const) {
      const node = seed(`a ${status} step`, { status });

      const result = await openPlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 1 });

      expect(result).toMatchObject({
        ok: false,
        code: 'PLAN_NODE_UNCHANGED',
        details: { nodeId: node.nodeId, revision: 1, status },
      });
      expect(store.nodes.get(node.nodeId)?.revision).toBe(1);
    }
  });

  it('refuses a revision the node moved past with the current one, and a node not in the space', async () => {
    const node = seed('moved on', { status: 'blocked', revision: 4 });

    expect(await openPlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 3 })).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_STALE',
      details: { revision: 4, status: 'blocked' },
    });
    expect(await openPlanNode(ctx(), { nodeId: MISSING, expectedRevision: 1 })).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
    });
    expect(store.nodes.get(node.nodeId)?.status).toBe('blocked');
  });
});

describe('openPlanNode — Approve with instructions (Plan 337 P4)', () => {
  it('writes the operator’s instructions as one line, so the whole of them is the note’s first line', async () => {
    const node = seed('P2 — the rail', { status: 'blocked', note: 'Proposed by the resident' });

    await openPlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      why: 'Do it, and make sure\nthe rail still reads on a phone.\r\n  Keep the old copy.',
    });

    const note = store.nodes.get(node.nodeId)?.note;
    expect(note?.split('\n')[0]).toBe(
      'Approved: Do it, and make sure the rail still reads on a phone. Keep the old copy.',
    );
    expect(note?.split('\n').slice(1)).toEqual(['Proposed by the resident']);
  });
});

describe('revisePlanNode — Revise on a blocked node (Plan 337 P4)', () => {
  it('keeps the node blocked, puts the note above its note, and moves the revision', async () => {
    const node = seed('P1 — proposals', {
      status: 'blocked',
      revision: 3,
      goal: 'Propose the next step.',
      note: 'Proposed from the merged plan document',
    });

    const result = await revisePlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: 3,
      why: 'Split it in two:\nthe schema first.',
    });

    expect(result).toMatchObject({ ok: true, node: { status: 'blocked', revision: 4 } });
    expect(store.nodes.get(node.nodeId)).toMatchObject({
      status: 'blocked',
      goal: 'Propose the next step.',
      note: 'Revise: Split it in two: the schema first.\nProposed from the merged plan document',
    });
  });

  it('refuses an open or a closed node as unchanged, a stale revision, and a node not in the space', async () => {
    for (const status of ['active', 'waiting', 'done', 'dropped'] as const) {
      const node = seed(`a ${status} step`, { status });
      expect(
        await revisePlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 1, why: 'Again' }),
      ).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED', details: { status } });
      expect(store.nodes.get(node.nodeId)?.revision).toBe(1);
    }
    const moved = seed('moved on', { status: 'blocked', revision: 4 });
    expect(
      await revisePlanNode(ctx(), { nodeId: moved.nodeId, expectedRevision: 3, why: 'Again' }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE', details: { revision: 4 } });
    expect(
      await revisePlanNode(ctx(), { nodeId: MISSING, expectedRevision: 1, why: 'Again' }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
  });

  it('refuses a note that would pass the ceiling, writing nothing', async () => {
    const node = seed('full', {
      status: 'blocked',
      note: 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS - 5),
    });

    expect(
      await revisePlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 1, why: 'Shorter' }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_NOTE_TOO_LONG' });
    expect(store.nodes.get(node.nodeId)?.revision).toBe(1);
  });
});

describe('updatePlanNode — the operator’s conversation links itself (Plan 337 P4)', () => {
  it('links the conversation once, and leaves the revision the writer was given', async () => {
    const node = seed('discussed', { status: 'blocked' });
    const talking = { ...ctx(), conversationId: 'c0000000-0000-4000-8000-000000000337' };

    const first = await updatePlanNode(talking, {
      nodeId: node.nodeId,
      expectedRevision: 1,
      goal: 'Rewritten in the conversation.',
    });
    if (!first.ok) throw new Error(first.message);
    const second = await updatePlanNode(talking, {
      nodeId: node.nodeId,
      expectedRevision: first.node.revision,
      note: 'Revised: split in two.',
    });

    expect(second).toMatchObject({ ok: true, node: { revision: 3 } });
    expect(store.links).toEqual([
      expect.objectContaining({
        nodeId: node.nodeId,
        kind: 'session',
        ref: 'c0000000-0000-4000-8000-000000000337',
        label: 'conversation',
      }),
    ]);
  });

  it('links nothing for a writer that is not a conversation, or a write that is refused', async () => {
    const node = seed('quiet');
    await updatePlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 1, note: 'next' });
    await updatePlanNode(
      { ...ctx(), conversationId: 'c0000000-0000-4000-8000-000000000338' },
      { nodeId: node.nodeId, expectedRevision: 1, note: 'stale' },
    );

    expect(store.links).toEqual([]);
  });
});

describe('placeAmongSiblings', () => {
  const at = (...positions: number[]) =>
    positions.map((position, i) => ({ nodeId: `n${String(i)}`, position }));

  it('goes halfway between the neighbours where an integer lies between them', () => {
    expect(placeAmongSiblings(at(0, 1024, 2048), 'n2', { before: 'n1' })).toEqual({
      outcome: 'placed',
      position: 512,
      renumbered: new Map(),
    });
    expect(placeAmongSiblings(at(0, 1024, 2048), 'n0', { after: 'n2' })).toEqual({
      outcome: 'placed',
      position: 2048 + PLAN_PLACE_STRIDE,
      renumbered: new Map(),
    });
    expect(placeAmongSiblings(at(5, 6, 3000), 'n2', { before: 'n0' })).toMatchObject({
      outcome: 'placed',
      position: 0,
    });
  });

  it('renumbers at the stride in the order the place leaves where none does', () => {
    const placed = placeAmongSiblings(at(0, 1, 2, 3), 'n3', { after: 'n0' });
    expect(placed).toEqual({
      outcome: 'placed',
      position: 1024,
      renumbered: new Map([
        ['n1', 2048],
        ['n2', 3072],
      ]),
    });
  });

  it('renumbers siblings that share a position, and past the position ceiling', () => {
    expect(placeAmongSiblings(at(7, 7, 7), 'n0', { after: 'n1' })).toEqual({
      outcome: 'placed',
      position: 1024,
      renumbered: new Map([
        ['n1', 0],
        ['n2', 2048],
      ]),
    });
    expect(placeAmongSiblings(at(0, PLAN_NODE_POSITION_MAX), 'n0', { after: 'n1' })).toMatchObject({
      outcome: 'placed',
      position: 1024,
      renumbered: new Map([['n1', 0]]),
    });
  });

  it('answers unchanged where the node already stands there, and not a sibling otherwise', () => {
    expect(placeAmongSiblings(at(0, 1), 'n0', { before: 'n1' })).toEqual({ outcome: 'unchanged' });
    expect(placeAmongSiblings(at(0, 1), 'n1', { after: 'n0' })).toEqual({ outcome: 'unchanged' });
    expect(placeAmongSiblings(at(0, 1), 'n0', { before: 'elsewhere' })).toEqual({
      outcome: 'not_sibling',
    });
    expect(placeAmongSiblings(at(0, 1), 'n0', { before: 'n0' })).toEqual({
      outcome: 'not_sibling',
    });
  });
});

describe('placePlanNode', () => {
  it('puts a step before a sibling, moving only its own revision', async () => {
    const root = seed('Plan 315');
    seed('A', { parentId: root.nodeId, position: 0 });
    const b = seed('B', { parentId: root.nodeId, position: 1024 });
    const c = seed('C', { parentId: root.nodeId, position: 2048, revision: 2 });

    const result = await placePlanNode(ctx(), {
      nodeId: c.nodeId,
      expectedRevision: 2,
      before: b.nodeId,
    });

    expect(result).toMatchObject({ ok: true, node: { revision: 3, position: 512 } });
    expect(order(root.nodeId)).toEqual(['A', 'C', 'B']);
    expect(revisions()).toMatchObject({ A: 1, B: 1, C: 3 });
    expect(store.renumbered).toEqual([]);
  });

  it('renumbers where no integer lies between the neighbours, keeping the order and every other revision', async () => {
    const root = seed('Plan 320');
    const titles = ['P6.a', 'P6.b', 'P6.c', 'P6.d'];
    const steps = titles.map((title, position) => seed(title, { parentId: root.nodeId, position }));

    const result = await placePlanNode(ctx(), {
      nodeId: steps[3]!.nodeId,
      expectedRevision: 1,
      after: steps[0]!.nodeId,
    });

    expect(result.ok).toBe(true);
    expect(order(root.nodeId)).toEqual(['P6.a', 'P6.d', 'P6.b', 'P6.c']);
    expect(revisions()).toMatchObject({ 'P6.a': 1, 'P6.b': 1, 'P6.c': 1, 'P6.d': 2 });
    expect(store.renumbered.length).toBeGreaterThan(0);
    const positions = [...store.nodes.values()]
      .filter((n) => n.parentId === root.nodeId)
      .map((n) => n.position)
      .sort((a, b) => a - b);
    expect(positions).toEqual([0, 1024, 2048, 3072]);
  });

  it('orders roots among roots', async () => {
    const first = seed('Plan 331', { position: 0 });
    seed('Plan 332', { position: 1 });
    const third = seed('Plan 320', { position: 2 });

    const result = await placePlanNode(ctx(), {
      nodeId: third.nodeId,
      expectedRevision: 1,
      before: first.nodeId,
    });

    expect(result.ok).toBe(true);
    expect(order(null)).toEqual(['Plan 320', 'Plan 331', 'Plan 332']);
  });

  it('refuses a sibling that moved away, with the siblings’ order as it stands', async () => {
    const root = seed('Plan 322');
    const elsewhere = seed('Plan 324');
    const a = seed('A', { parentId: root.nodeId, position: 0 });
    const b = seed('B', { parentId: root.nodeId, position: 1 });
    const moved = seed('moved', { parentId: elsewhere.nodeId });

    const result = await placePlanNode(ctx(), {
      nodeId: b.nodeId,
      expectedRevision: 1,
      before: moved.nodeId,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_PLACE_STALE',
      details: {
        nodeId: b.nodeId,
        siblings: [
          { nodeId: a.nodeId, title: 'A', status: 'active', position: 0 },
          { nodeId: b.nodeId, title: 'B', status: 'active', position: 1 },
        ],
      },
    });
    expect(revisions()).toMatchObject({ A: 1, B: 1 });
  });

  it('refuses a stale revision, a place that changes nothing, and a node not in the space', async () => {
    const root = seed('Plan 322');
    const a = seed('A', { parentId: root.nodeId, position: 0 });
    const b = seed('B', { parentId: root.nodeId, position: 1, revision: 4 });

    const refusals = [
      await placePlanNode(ctx(), { nodeId: b.nodeId, expectedRevision: 3, before: a.nodeId }),
      await placePlanNode(ctx(), { nodeId: b.nodeId, expectedRevision: 4, after: a.nodeId }),
      await placePlanNode(ctx(), { nodeId: MISSING, expectedRevision: 1, after: a.nodeId }),
    ];

    expect(refusals.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'PLAN_NODE_STALE',
      'PLAN_NODE_UNCHANGED',
      'PLAN_NODE_NOT_FOUND',
    ]);
    expect(refusals[0]).toMatchObject({ details: { revision: 4 } });
    expect(order(root.nodeId)).toEqual(['A', 'B']);
  });

  it('applies two places under one parent at once in an order neither loses', async () => {
    const root = seed('Plan 315');
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((title, position) =>
      seed(title, { parentId: root.nodeId, position }),
    );

    const [first, second] = await Promise.all([
      placePlanNode(ctx(), { nodeId: d!.nodeId, expectedRevision: 1, before: a!.nodeId }),
      placePlanNode(ctx(), { nodeId: c!.nodeId, expectedRevision: 1, before: b!.nodeId }),
    ]);

    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(order(root.nodeId)).toEqual(['D', 'A', 'C', 'B']);
  });

  it('refuses the second of two places of one node decided on one revision', async () => {
    const root = seed('Plan 315');
    const [a, b, c] = ['A', 'B', 'C'].map((title, position) =>
      seed(title, { parentId: root.nodeId, position }),
    );

    const outcomes = await Promise.all([
      placePlanNode(ctx(), { nodeId: c!.nodeId, expectedRevision: 1, before: a!.nodeId }),
      placePlanNode(ctx(), { nodeId: c!.nodeId, expectedRevision: 1, before: b!.nodeId }),
    ]);

    expect(outcomes.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'PLAN_NODE_STALE']);
    expect(order(root.nodeId)).toEqual(['C', 'A', 'B']);
  });
});
