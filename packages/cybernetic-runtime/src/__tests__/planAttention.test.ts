import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { configureLogging } from '@aflow/observability';
import { PLAN_TREE_DEPTH_LIMIT, type PlanNodeCreateInput } from '@aflow/schemas';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const fakeStore = { current: new InMemoryPlanNodeStore() };

vi.mock('../plan/store.js', async () => {
  const actual = await vi.importActual<typeof import('../plan/store.js')>('../plan/store.js');
  return { ...actual, createPlanNodeStore: () => fakeStore.current };
});
vi.mock('../ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../ledger.js')>('../ledger.js');
  return { ...actual, listActiveRunsWithLiveness: () => Promise.resolve([]) };
});
vi.mock('../skill.js', async () => {
  const actual = await vi.importActual<typeof import('../skill.js')>('../skill.js');
  return { ...actual, listSkillsForSpace: () => Promise.resolve([]) };
});
// Every other section reads memory docs or applets; none of them is under test here.
vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    withTenantSchema: () => Promise.resolve([]),
    createAppletPersistence: () => ({
      transact: () => Promise.resolve({ items: [], total: 0 }),
    }),
  };
});

const { buildHelmsmanAttention, renderAttentionContext } = await import('../attentionBuilder.js');
const { createPlanNode, updatePlanNode } = await import('../plan/operations.js');
const { loadActivePlanTree, PLAN_ATTENTION_NODE_LIMIT } = await import('../plan/attention.js');

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const DB = {} as never;

const NODE: PlanNodeCreateInput = {
  kind: 'execute',
  title: '315 · Local first-run ergonomics',
  goal: 'A new operator reaches a working space without help.',
  criteria: 'A clean machine’s yarn start ends serving a space.',
};

let redis: RedisType;

function writer(name: string) {
  return {
    store: fakeStore.current,
    redis,
    tenantId: TENANT,
    spaceId: SPACE,
    createdBy: `operator-of-${name}`,
  };
}

async function create(input: Partial<PlanNodeCreateInput> = {}) {
  const result = await createPlanNode(writer('session-a'), { ...NODE, ...input });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

/** One Helmsman turn's attention block, as `buildCyberneticTurnOverrides` renders it. */
async function turnAttention(): Promise<string> {
  return renderAttentionContext(
    await buildHelmsmanAttention({ tenantId: TENANT, spaceId: SPACE, db: DB, redis }),
  );
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(async () => {
  fakeStore.current = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  // ioredis-mock instances share one keyspace.
  await redis.flushall();
});

describe('stale never (Plan 322 D4)', () => {
  it('a plan write in one session shows in the next turn of another, through the cached block', async () => {
    const before = await turnAttention();
    expect(before).not.toContain('Active plan');

    // Another session writes the plan; the block above is cached for the space.
    const node = await create({ note: 'next: F114 findings out of the plan file' });

    const after = await turnAttention();
    expect(after).toContain(
      `[execute] 315 · Local first-run ergonomics — active — next: F114 findings out of the plan file [nodeId: ${node.nodeId}]`,
    );

    await updatePlanNode(writer('session-b'), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: 'Two clean machines reached a serving space.',
    });
    expect(await turnAttention()).not.toContain(node.nodeId);
  });

  it('is the generation bump that makes it so — a write around the engine stays unseen', async () => {
    await turnAttention();
    await fakeStore.current.insert(SPACE, {
      parentId: null,
      kind: 'investigate',
      title: 'Written around the engine',
      goal: 'g',
      criteria: 'c',
      note: null,
      position: 0,
      createdBy: null,
    });
    expect(await turnAttention()).not.toContain('Written around the engine');
  });
});

describe('the plan section of the attention block', () => {
  it('comes first: open roots, each followed by its open children, indented', async () => {
    const root = await create();
    await create({
      parentId: root.nodeId,
      title: 'F114 findings out of the plan file',
      position: 1,
    });
    await create({
      parentId: root.nodeId,
      kind: 'investigate',
      title: 'Why the first start stalls',
      position: 0,
    });
    await create({ title: 'Second stream' });

    const lines = (await turnAttention()).split('\n');
    expect(lines[0]).toBe('Active plan — open a node with `plan.node.get`:');
    expect(lines.slice(1, 5).map((l) => l.replace(/ \[nodeId: [^\]]+\]$/, ''))).toEqual([
      '[execute] 315 · Local first-run ergonomics — active',
      '  [investigate] Why the first start stalls — active',
      '  [execute] F114 findings out of the plan file — active',
      '[execute] Second stream — active',
    ]);
    expect(lines.indexOf('No active workflow runs.')).toBeGreaterThan(4);
  });

  it('leaves out closed nodes and the open nodes under them', async () => {
    const root = await create({ title: 'Closed stream' });
    await create({ parentId: root.nodeId, title: 'Still open underneath' });
    await updatePlanNode(writer('session-a'), {
      nodeId: root.nodeId,
      expectedRevision: 1,
      status: 'dropped',
      outcome: 'Folded into another stream.',
    });
    await create({ title: 'Open stream', kind: 'decide' });
    await create({ title: 'Blocked stream', kind: 'decide' }).then((n) =>
      updatePlanNode(writer('session-a'), {
        nodeId: n.nodeId,
        expectedRevision: 1,
        status: 'blocked',
      }),
    );

    const text = await turnAttention();
    expect(text).not.toContain('Closed stream');
    expect(text).not.toContain('Still open underneath');
    expect(text).toContain('[decide] Open stream — active');
    expect(text).toContain('[decide] Blocked stream — blocked');
  });

  it('is bounded, and points at plan.node.list for the rest', async () => {
    const extra = 5;
    for (let i = 0; i < PLAN_ATTENTION_NODE_LIMIT + extra; i++) {
      await create({ title: `node ${String(i)}`, position: i });
    }
    const tree = await loadActivePlanTree(fakeStore.current, SPACE);
    expect(tree?.nodes).toHaveLength(PLAN_ATTENTION_NODE_LIMIT);
    expect(tree?.total).toBe(PLAN_ATTENTION_NODE_LIMIT + extra);
    expect(await turnAttention()).toContain(
      `   ... and ${String(extra)} more — use \`plan.node.list\``,
    );
  });

  it('says there are more than it counted when the walk stopped at a bound', async () => {
    // No create or move leaves a node this deep; the walk stops at the depth bound regardless.
    let parent = fakeStore.current.seed(SPACE, { title: 'level 0' });
    for (let depth = 1; depth <= PLAN_TREE_DEPTH_LIMIT + 1; depth++) {
      parent = fakeStore.current.seed(SPACE, {
        parentId: parent.nodeId,
        title: `level ${String(depth)}`,
      });
    }

    const tree = await loadActivePlanTree(fakeStore.current, SPACE);
    expect(tree).toMatchObject({
      total: PLAN_TREE_DEPTH_LIMIT + 1,
      truncated: { bound: 'depth', value: PLAN_TREE_DEPTH_LIMIT },
    });
    const counted = PLAN_TREE_DEPTH_LIMIT + 1 - PLAN_ATTENTION_NODE_LIMIT;
    expect(await turnAttention()).toContain(
      `   ... and more than ${String(counted)} more — use \`plan.node.list\``,
    );
  });
});
