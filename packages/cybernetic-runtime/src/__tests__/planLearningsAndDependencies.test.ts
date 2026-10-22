/**
 * Plan 322 P2 against the engine: a learning written on a node is read by the
 * next session that opens it, and a dependency between nodes is a
 * compare-and-set write of the waiting node that refuses a loop.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_NODE_DEPEND_ONE_OF_MESSAGE,
  PlanNodeDependInputSchema,
  PlanNodeGetOutputSchema,
  PlanNodeRefusalDetailsSchema,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanNodeLearnInput,
} from '@aflow/schemas';
import {
  createPlanNode,
  dependPlanNode,
  getPlanNode,
  learnOnPlanNode,
  updatePlanNode,
  type PlanReadContext,
  type PlanWriteContext,
} from '../plan/operations.js';
import { checkDependency } from '../plan/dependencies.js';
import { getAttentionCache } from '../attentionCache.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const OTHER_SPACE = '5e1d0000-0000-4000-8000-000000000999';
const SESSION_A = '5e5a0000-0000-4000-8000-00000000000a';
const RUN = '0a000000-0000-4000-8000-000000000001';

const NODE: PlanNodeCreateInput = {
  kind: 'execute',
  title: 'P2 · Learnings and dependencies',
  goal: 'A learning written on a node reaches the next session.',
  criteria: 'The next session that opens the node reads it.',
};

let store: InMemoryPlanNodeStore;
let redis: RedisType;

function writer(spaceId = SPACE): PlanWriteContext {
  return { store, redis, tenantId: TENANT, spaceId };
}

/** A later session's read: nothing of the writer's but the store both share. */
function reader(spaceId = SPACE): PlanReadContext {
  return { store, spaceId };
}

async function created(input: Partial<PlanNodeCreateInput> = {}): Promise<PlanNode> {
  const result = await createPlanNode(writer(), { ...NODE, ...input });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

function lesson(nodeId: string, statement: string, extra: Partial<PlanNodeLearnInput> = {}) {
  return {
    nodeId,
    kind: 'constraint' as const,
    statement,
    evidence: { citations: [{ runId: RUN }] },
    confidence: 'medium' as const,
    ...extra,
  };
}

async function opened(nodeId: string) {
  const read = await getPlanNode(reader(), nodeId);
  if (!read.ok) throw new Error(read.message);
  return read;
}

async function current(nodeId: string): Promise<PlanNode> {
  return (await opened(nodeId)).node;
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

// ============================================================================
// scope: plan
// ============================================================================

describe('learnOnPlanNode — a learning scoped to a node', () => {
  it('is read by the next session that opens the node, not only by the session that wrote it', async () => {
    const node = await created();
    const learned = await learnOnPlanNode(
      writer(),
      lesson(node.nodeId, 'The integration suite needs a migrated database.'),
      { sessionId: SESSION_A },
    );
    expect(learned.ok).toBe(true);

    const read = await opened(node.nodeId);
    expect(PlanNodeGetOutputSchema.parse(read)).toBeTruthy();
    expect(read.learningsTotal).toBe(1);
    expect(read.learnings).toEqual([
      expect.objectContaining({
        nodeId: node.nodeId,
        kind: 'constraint',
        statement: 'The integration suite needs a migrated database.',
        confidence: 'medium',
        runIds: [RUN],
      }),
    ]);
  });

  it('is stored in coach_learnings as plan scope, recorded as read at once, under the writing session', async () => {
    const node = await created();
    await learnOnPlanNode(writer(), lesson(node.nodeId, 'Rerun before fixing.'), {
      sessionId: SESSION_A,
    });
    expect(store.learnings).toHaveLength(1);
    expect(store.learnings[0]).toMatchObject({
      spaceId: SPACE,
      learning: {
        scope: { kind: 'plan', planNodeId: node.nodeId },
        coachSessionId: SESSION_A,
        status: 'auto_recorded',
        authorityLevel: 'auto_record',
      },
    });
  });

  it('on a stream’s root is read by every node under it; on a node, not by its parent or a sibling', async () => {
    const root = await created({ title: '315' });
    const slice = await created({ parentId: root.nodeId, title: 'F114' });
    const step = await created({ parentId: slice.nodeId, title: 'F114.a' });
    const sibling = await created({ parentId: root.nodeId, title: 'F115' });
    await learnOnPlanNode(writer(), lesson(root.nodeId, 'Every round runs yarn verify.'), {
      sessionId: SESSION_A,
    });
    await learnOnPlanNode(writer(), lesson(slice.nodeId, 'F114 touches the plan file.'), {
      sessionId: SESSION_A,
    });

    const statements = async (nodeId: string) =>
      (await opened(nodeId)).learnings.map((l) => l.statement);
    expect(await statements(step.nodeId)).toEqual([
      'F114 touches the plan file.',
      'Every round runs yarn verify.',
    ]);
    expect((await opened(step.nodeId)).learnings.map((l) => l.nodeId)).toEqual([
      slice.nodeId,
      root.nodeId,
    ]);
    expect(await statements(root.nodeId)).toEqual(['Every round runs yarn verify.']);
    expect(await statements(sibling.nodeId)).toEqual(['Every round runs yarn verify.']);
  });

  it('replaces the learnings it supersedes on the same node, which are no longer read', async () => {
    const node = await created();
    const first = await learnOnPlanNode(writer(), lesson(node.nodeId, 'Flaky: rerun.'), {
      sessionId: SESSION_A,
    });
    if (!first.ok) throw new Error(first.message);
    const second = await learnOnPlanNode(
      writer(),
      lesson(node.nodeId, 'Not flaky: a race in the fixture.', {
        supersedes: [first.learning.learningId],
      }),
      { sessionId: SESSION_A },
    );
    expect(second).toMatchObject({ ok: true, superseded: [first.learning.learningId] });
    const read = await opened(node.nodeId);
    expect(read.learnings.map((l) => l.statement)).toEqual(['Not flaky: a race in the fixture.']);
    expect(read.learningsTotal).toBe(1);
  });

  it('refuses to supersede a learning of another node, and writes nothing', async () => {
    const node = await created({ title: 'one' });
    const other = await created({ title: 'other' });
    const theirs = await learnOnPlanNode(writer(), lesson(other.nodeId, 'Theirs.'), {
      sessionId: SESSION_A,
    });
    if (!theirs.ok) throw new Error(theirs.message);
    const refused = await learnOnPlanNode(
      writer(),
      lesson(node.nodeId, 'Mine.', { supersedes: [theirs.learning.learningId] }),
      { sessionId: SESSION_A },
    );
    expect(refused).toMatchObject({ ok: false, code: 'PLAN_LEARNING_NOT_FOUND' });
    expect(store.learnings).toHaveLength(1);
    expect((await opened(other.nodeId)).learnings.map((l) => l.statement)).toEqual(['Theirs.']);
  });

  it('refuses a node that is not in the space', async () => {
    const elsewhere = await createPlanNode(writer(OTHER_SPACE), NODE);
    if (!elsewhere.ok) throw new Error(elsewhere.message);
    const refused = await learnOnPlanNode(writer(), lesson(elsewhere.node.nodeId, 'Nope.'), {
      sessionId: SESSION_A,
    });
    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
    expect(store.learnings).toHaveLength(0);
  });

  it('bumps the space’s attention generation, and moves no node’s revision', async () => {
    const node = await created();
    const before = (await getAttentionCache(redis, TENANT, SPACE)).generation;
    await learnOnPlanNode(writer(), lesson(node.nodeId, 'Noted.'), { sessionId: SESSION_A });
    expect((await getAttentionCache(redis, TENANT, SPACE)).generation).not.toBe(before);
    expect((await current(node.nodeId)).revision).toBe(node.revision);
  });
});

// ============================================================================
// Dependency edges
// ============================================================================

describe('dependPlanNode — a node waits on another’s outcome', () => {
  it('writes an edge with its condition, moving the waiting node’s revision on', async () => {
    const waits = await created({ title: 'Publish the board' });
    const first = await created({ title: 'Land the read' });
    const written = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: waits.revision,
      dependsOnId: first.nodeId,
      condition: 'done',
    });
    expect(written).toMatchObject({
      ok: true,
      node: { nodeId: waits.nodeId, revision: waits.revision + 1 },
      dependency: { nodeId: waits.nodeId, dependsOnId: first.nodeId, condition: 'done' },
    });
    // The node it waits on is not written.
    expect((await current(first.nodeId)).revision).toBe(first.revision);

    const read = await opened(waits.nodeId);
    expect(read.dependencies).toEqual([
      {
        nodeId: first.nodeId,
        title: 'Land the read',
        status: 'active',
        condition: 'done',
        met: false,
      },
    ]);
    expect((await opened(first.nodeId)).dependents).toEqual([
      expect.objectContaining({ nodeId: waits.nodeId, condition: 'done', met: false }),
    ]);
  });

  it('reads the edge met once the dependency reaches the outcome it names', async () => {
    const waits = await created({ title: 'waits' });
    const onDone = await created({ title: 'on done' });
    const onDropped = await created({ title: 'on dropped' });
    const onClosed = await created({ title: 'on closed' });
    let revision = waits.revision;
    for (const [dependency, condition] of [
      [onDone, 'done'],
      [onDropped, 'dropped'],
      [onClosed, 'closed'],
    ] as const) {
      const written = await dependPlanNode(writer(), {
        nodeId: waits.nodeId,
        expectedRevision: revision,
        dependsOnId: dependency.nodeId,
        condition,
      });
      if (!written.ok) throw new Error(written.message);
      revision = written.node.revision;
    }
    for (const node of [onDone, onDropped, onClosed]) {
      await updatePlanNode(writer(), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: 'Landed.',
      });
    }
    const met = Object.fromEntries(
      (await opened(waits.nodeId)).dependencies.map((d) => [d.title, d.met]),
    );
    expect(met).toEqual({ 'on done': true, 'on dropped': false, 'on closed': true });
  });

  it('changes what an edge waits for, and takes it away, each against the revision', async () => {
    const waits = await created({ title: 'waits' });
    const other = await created({ title: 'other' });
    const set = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: 1,
      dependsOnId: other.nodeId,
      condition: 'done',
    });
    if (!set.ok) throw new Error(set.message);
    const changed = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: set.node.revision,
      dependsOnId: other.nodeId,
      condition: 'closed',
    });
    if (!changed.ok) throw new Error(changed.message);
    expect(changed.dependency?.condition).toBe('closed');
    expect(store.dependencies).toHaveLength(1);

    const removed = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: changed.node.revision,
      dependsOnId: other.nodeId,
      remove: true,
    });
    expect(removed).toMatchObject({ ok: true, node: { revision: changed.node.revision + 1 } });
    expect(removed.ok && removed.dependency).toBeFalsy();
    expect((await opened(waits.nodeId)).dependencies).toEqual([]);
  });

  it('refuses a stale revision with the node as it stands, and writes nothing', async () => {
    const waits = await created({ title: 'waits' });
    const other = await created({ title: 'other' });
    await updatePlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: 1,
      note: 'another session moved it on',
    });
    const refused = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: 1,
      dependsOnId: other.nodeId,
      condition: 'done',
    });
    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    if (refused.ok) return;
    expect(PlanNodeRefusalDetailsSchema.parse(refused.details)).toMatchObject({
      nodeId: waits.nodeId,
      revision: 2,
    });
    expect(store.dependencies).toHaveLength(0);
  });

  it('refuses an edge that changes nothing, as an update that changes nothing is refused', async () => {
    const waits = await created({ title: 'waits' });
    const other = await created({ title: 'other' });
    const absent = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: 1,
      dependsOnId: other.nodeId,
      remove: true,
    });
    expect(absent).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED' });
    const set = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: 1,
      dependsOnId: other.nodeId,
      condition: 'done',
    });
    if (!set.ok) throw new Error(set.message);
    const again = await dependPlanNode(writer(), {
      nodeId: waits.nodeId,
      expectedRevision: set.node.revision,
      dependsOnId: other.nodeId,
      condition: 'done',
    });
    expect(again).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED' });
    expect((await current(waits.nodeId)).revision).toBe(set.node.revision);
  });

  it('refuses a node that waits on itself as a cycle', async () => {
    const node = await created();
    const refused = await dependPlanNode(writer(), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      dependsOnId: node.nodeId,
      condition: 'done',
    });
    expect(refused).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_DEPENDENCY_CYCLE',
      details: { path: [node.nodeId, node.nodeId] },
    });
    expect((await current(node.nodeId)).revision).toBe(node.revision);
  });

  it('refuses an edge that closes a loop, naming the loop, and writes nothing', async () => {
    const a = await created({ title: 'A' });
    const b = await created({ title: 'B' });
    const c = await created({ title: 'C' });
    for (const [from, to] of [
      [a, b],
      [b, c],
    ] as const) {
      const written = await dependPlanNode(writer(), {
        nodeId: from.nodeId,
        expectedRevision: from.revision,
        dependsOnId: to.nodeId,
        condition: 'done',
      });
      if (!written.ok) throw new Error(written.message);
    }
    const refused = await dependPlanNode(writer(), {
      nodeId: c.nodeId,
      expectedRevision: c.revision,
      dependsOnId: a.nodeId,
      condition: 'closed',
    });
    expect(refused).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_DEPENDENCY_CYCLE',
      details: {
        nodeId: c.nodeId,
        dependsOnId: a.nodeId,
        path: [c.nodeId, a.nodeId, b.nodeId, c.nodeId],
      },
    });
    expect(store.dependencies).toHaveLength(2);
    expect((await current(c.nodeId)).revision).toBe(c.revision);
    expect((await opened(c.nodeId)).dependencies).toEqual([]);
  });

  it('of two sessions closing a loop at once, writes one and refuses the other as a cycle', async () => {
    const a = await created({ title: 'A' });
    const b = await created({ title: 'B' });
    const [first, second] = await Promise.all([
      dependPlanNode(writer(), {
        nodeId: a.nodeId,
        expectedRevision: a.revision,
        dependsOnId: b.nodeId,
        condition: 'done',
      }),
      dependPlanNode(writer(), {
        nodeId: b.nodeId,
        expectedRevision: b.revision,
        dependsOnId: a.nodeId,
        condition: 'done',
      }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect([first, second].find((r) => !r.ok)).toMatchObject({
      code: 'PLAN_NODE_DEPENDENCY_CYCLE',
    });
    expect(store.dependencies).toHaveLength(1);
  });

  it('allows a diamond: two paths to one dependency are not a loop', async () => {
    const [top, left, right, bottom] = [
      await created({ title: 'top' }),
      await created({ title: 'left' }),
      await created({ title: 'right' }),
      await created({ title: 'bottom' }),
    ];
    const edges = [
      [top, left],
      [top, right],
      [left, bottom],
      [right, bottom],
    ] as const;
    for (const [from, to] of edges) {
      const written = await dependPlanNode(writer(), {
        nodeId: from.nodeId,
        expectedRevision: (await current(from.nodeId)).revision,
        dependsOnId: to.nodeId,
        condition: 'done',
      });
      expect(written.ok).toBe(true);
    }
    expect(store.dependencies).toHaveLength(4);
  });

  it('refuses a dependency that is not in the space', async () => {
    const node = await created();
    const elsewhere = await createPlanNode(writer(OTHER_SPACE), NODE);
    if (!elsewhere.ok) throw new Error(elsewhere.message);
    const refused = await dependPlanNode(writer(), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      dependsOnId: elsewhere.node.nodeId,
      condition: 'done',
    });
    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
    expect(store.dependencies).toHaveLength(0);
  });

  it('takes a condition or a removal, never both and never neither', () => {
    const base = {
      nodeId: SPACE,
      expectedRevision: 1,
      dependsOnId: OTHER_SPACE,
    };
    expect(PlanNodeDependInputSchema.safeParse({ ...base, condition: 'done' }).success).toBe(true);
    expect(PlanNodeDependInputSchema.safeParse({ ...base, remove: true }).success).toBe(true);
    for (const input of [base, { ...base, condition: 'done', remove: true }]) {
      const parsed = PlanNodeDependInputSchema.safeParse(input);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(PLAN_NODE_DEPEND_ONE_OF_MESSAGE);
    }
  });
});

describe('checkDependency', () => {
  const graph = (edges: Record<string, string[]>) => ({
    dependenciesOf: (id: string) => Promise.resolve(edges[id] ?? []),
  });

  it('refuses rather than guesses where more nodes are reachable than it reads', async () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) edges[`n${String(i)}`] = [`n${String(i + 1)}`];
    expect(await checkDependency('start', 'n0', graph(edges), 5)).toEqual({
      outcome: 'walk_limit',
      maxNodes: 5,
    });
  });

  it('answers not_found where the node waited on is not in the space', async () => {
    const check = await checkDependency(
      'a',
      'gone',
      { dependenciesOf: () => Promise.resolve(undefined) },
      10,
    );
    expect(check).toEqual({ outcome: 'not_found' });
  });
});
