import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { configureLogging } from '@aflow/observability';
import { PLAN_TREE_DEPTH_LIMIT, type PlanNodeCreateInput } from '@aflow/schemas';
import type { ActiveRunWithTaskCounts } from '../ledger/types.js';
import type { PendingRunAttentionItem } from '../ledger/attention.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const fakeStore = { current: new InMemoryPlanNodeStore() };

/** The space's runs and attention items as the ledger reads them, and who drove each run. */
const fakeLedger = {
  runs: [] as ActiveRunWithTaskCounts[],
  items: [] as PendingRunAttentionItem[],
};

vi.mock('../plan/store.js', async () => {
  const actual = await vi.importActual<typeof import('../plan/store.js')>('../plan/store.js');
  return { ...actual, createPlanNodeStore: () => fakeStore.current };
});
vi.mock('../ledger/queries.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/queries.js')>('../ledger/queries.js');
  return {
    ...actual,
    listActiveRunsWithLiveness: () => Promise.resolve(fakeLedger.runs),
    listPlanNodeIdsDrivenBySession: (_db: unknown, _t: string, _s: string, sessionId: string) =>
      Promise.resolve([
        ...new Set(
          fakeLedger.runs.flatMap((r) =>
            r.sessionId === sessionId && r.planNodeId !== undefined ? [r.planNodeId] : [],
          ),
        ),
      ]),
  };
});
vi.mock('../ledger/attention.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/attention.js')>('../ledger/attention.js');
  return { ...actual, listPendingRunAttention: () => Promise.resolve(fakeLedger.items) };
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
const { loadActivePlanTree, loadConversationPlanRoots, PLAN_ATTENTION_NODE_LIMIT } =
  await import('../plan/attention.js');

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
async function turnAttention(sessionId = COLD_SESSION): Promise<string> {
  const planRootIds = await loadConversationPlanRoots({
    db: DB,
    tenantId: TENANT,
    spaceId: SPACE,
    sessionId,
  });
  return renderAttentionContext(
    await buildHelmsmanAttention({ tenantId: TENANT, spaceId: SPACE, db: DB, redis }),
    { planRootIds },
  );
}

/** A conversation that has started nothing. */
const COLD_SESSION = 'c01d0000-0000-4000-8000-000000000322';

function activeRun(
  runId: string,
  slug: string,
  sessionId: string,
  planNodeId?: string,
): ActiveRunWithTaskCounts {
  return {
    runId,
    spaceId: SPACE,
    workflowSlug: slug,
    sessionId,
    status: 'paused',
    startedAt: new Date('2026-10-05T08:00:00.000Z'),
    schedulerCursorAt: null,
    totalTasks: 10,
    succeededTasks: 6,
    liveTasks: 0,
    scheduledTasks: 0,
    pausedTasks: 1,
    ...(planNodeId !== undefined ? { planNodeId } : {}),
  };
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(async () => {
  fakeStore.current = new InMemoryPlanNodeStore();
  fakeLedger.runs = [];
  fakeLedger.items = [];
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

describe('work under the plan — one answer to "what now" (Plan 322 P1)', () => {
  const STREAM_315 = 'a3150000-0000-4000-8000-000000000315';
  const STREAM_320 = 'a3200000-0000-4000-8000-000000000320';
  const OTHER_LINE = /^other work in this space, not this conversation's: /m;

  /** Two streams in one space, each with a run under a node, and the review the other stream is waiting on. */
  async function twoStreams() {
    const ours = await create();
    const finding = await create({
      parentId: ours.nodeId,
      title: 'F114 findings out of the plan file',
    });
    const theirs = await create({ title: '320 · Browser profiles' });
    const theirSlice = await create({ parentId: theirs.nodeId, title: 'P4 asks before it acts' });
    fakeLedger.runs = [
      activeRun('run-ours-commission', 'commission-change', STREAM_315, finding.nodeId),
      activeRun('run-theirs-publication', 'publish-local-changes', STREAM_320, theirSlice.nodeId),
      activeRun('run-free', 'ticker-market-digest', STREAM_320),
    ];
    fakeLedger.items = [
      {
        itemId: 'item-theirs-review',
        kind: 'workflow_run_completed',
        runId: 'run-theirs-review',
        workflowSlug: 'review-local-changes',
        planNodeId: theirSlice.nodeId,
        createdAt: new Date('2026-10-05T09:00:00.000Z'),
      },
      {
        itemId: 'item-free',
        kind: 'workflow_run_failed',
        runId: 'run-free-earlier',
        workflowSlug: 'ticker-market-digest',
        planNodeId: null,
        createdAt: new Date('2026-10-05T08:30:00.000Z'),
      },
    ];
    return { ours, finding, theirs, theirSlice };
  }

  it('shows a run started with planNodeId under its node, and another root’s run and item only as a count', async () => {
    const { finding } = await twoStreams();

    const lines = (await turnAttention(STREAM_315)).split('\n');
    const findingLine = lines.findIndex((l) => l.includes(`[nodeId: ${finding.nodeId}]`));
    expect(lines[findingLine + 1]).toBe(
      '    - commission-change (paused, liveness: waiting_for_input): 6/10 tasks complete [runId: run-ours-commission]',
    );

    const text = lines.join('\n');
    expect(text).not.toContain('run-theirs-publication');
    expect(text).not.toContain('item-theirs-review');
    expect(text).not.toContain('review-local-changes');
    expect(lines).toContain("other work in this space, not this conversation's: 1 runs, 1 items");
  });

  it('renders free-floating runs and items in their own short lists after the tree', async () => {
    await twoStreams();

    const lines = (await turnAttention(STREAM_315)).split('\n');
    const other = lines.findIndex((l) => OTHER_LINE.test(l));
    const runsHeading = lines.indexOf('Active workflow runs outside the plan:');
    expect(runsHeading).toBeGreaterThan(other);
    expect(lines[runsHeading + 1]).toContain('[runId: run-free]');
    expect(lines[runsHeading + 2]).toBe('');
    expect(lines[runsHeading + 3]).toMatch(/^Attention items outside the plan, newest first/);
    expect(lines[runsHeading + 4]).toBe(
      '- attention: workflow_run_failed — ticker-market-digest [itemId: item-free, runId: run-free-earlier]',
    );
  });

  it('gives a conversation that has started nothing every run in the plan as another’s', async () => {
    await twoStreams();

    const text = await turnAttention(COLD_SESSION);
    expect(text).not.toContain('run-ours-commission');
    expect(text).not.toContain('run-theirs-publication');
    expect(text).toMatch(/^other work in this space, not this conversation's: 2 runs, 1 items$/m);
    expect(text).toContain('[runId: run-free]');
  });

  it('is the other stream’s view of the same space, the other way round', async () => {
    const { theirSlice } = await twoStreams();

    const lines = (await turnAttention(STREAM_320)).split('\n');
    const sliceLine = lines.findIndex((l) => l.includes(`[nodeId: ${theirSlice.nodeId}]`));
    expect(lines.slice(sliceLine + 1, sliceLine + 3)).toEqual([
      '    - publish-local-changes (paused, liveness: waiting_for_input): 6/10 tasks complete [runId: run-theirs-publication]',
      '    - attention: workflow_run_completed — review-local-changes [itemId: item-theirs-review, runId: run-theirs-review]',
    ]);
    expect(lines).toContain("other work in this space, not this conversation's: 1 runs, 0 items");
  });

  it('lists its own work on a node the tree does not show, with that node’s id', async () => {
    const root = await create();
    const shut = await create({ parentId: root.nodeId, title: 'Closed slice' });
    await updatePlanNode(writer('session-a'), {
      nodeId: shut.nodeId,
      expectedRevision: 1,
      status: 'done',
      outcome: 'Met; its publication still waits on approval.',
    });
    fakeLedger.runs = [activeRun('run-late', 'publish-local-changes', STREAM_315, shut.nodeId)];

    const lines = (await turnAttention(STREAM_315)).split('\n');
    const heading = lines.indexOf("This conversation's work on plan nodes not listed above:");
    expect(heading).toBeGreaterThan(0);
    expect(lines[heading + 1]).toMatch(
      new RegExp(`\\[runId: run-late\\] \\[nodeId: ${shut.nodeId}\\]$`),
    );
    expect(lines.join('\n')).not.toMatch(OTHER_LINE);
  });

  it('keeps the plain heading for a space whose runs serve no node', async () => {
    fakeLedger.runs = [activeRun('run-free', 'ticker-market-digest', COLD_SESSION)];
    const lines = (await turnAttention()).split('\n');
    expect(lines[0]).toBe('Active workflow runs:');
    expect(lines.join('\n')).not.toMatch(OTHER_LINE);
  });
});
