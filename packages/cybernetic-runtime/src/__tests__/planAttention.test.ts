import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { configureLogging } from '@aflow/observability';
import { PLAN_TREE_DEPTH_LIMIT, type PlanNodeCreateInput } from '@aflow/schemas';
import type { ActiveSpaceRun } from '../ledger/types.js';
import type { PendingRunAttention, PendingRunAttentionItem } from '../ledger/attention.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const fakeStore = { current: new InMemoryPlanNodeStore() };

/** The space's runs and attention items as the ledger reads them, and who drove each run. */
const fakeLedger = {
  runs: [] as ActiveSpaceRun[],
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
/**
 * What `readPendingRunAttention`'s queries return: each node's newest, each
 * owning conversation's newest serving none, the newest serving none that no
 * conversation owns, and every item counted by node and driver.
 */
function readPendingFromLedger(perNodeLimit: number): PendingRunAttention {
  const newestFirst = [...fakeLedger.items].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const ranks = new Map<string, number>();
  const items = newestFirst.filter((item) => {
    const partition = JSON.stringify([
      item.planNodeId,
      item.planNodeId === null && item.drivenByLiveConversation ? item.sessionId : null,
    ]);
    const seen = ranks.get(partition) ?? 0;
    ranks.set(partition, seen + 1);
    return seen < perNodeLimit;
  });
  const counts = new Map<string, PendingRunAttention['counts'][number]>();
  for (const { planNodeId, sessionId, drivenByLiveConversation } of newestFirst) {
    const key = JSON.stringify([planNodeId, sessionId, drivenByLiveConversation]);
    counts.set(key, {
      planNodeId,
      sessionId,
      drivenByLiveConversation,
      count: (counts.get(key)?.count ?? 0) + 1,
    });
  }
  return { items, counts: [...counts.values()] };
}

vi.mock('../ledger/attention.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/attention.js')>('../ledger/attention.js');
  return {
    ...actual,
    readPendingRunAttention: (_db: unknown, _t: string, _s: string, perNodeLimit: number) =>
      Promise.resolve(readPendingFromLedger(perNodeLimit)),
  };
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
const { ATTENTION_ITEM_SURFACE_LIMIT } = await import('../pendingAttention.js');
const { createPlanNode, updatePlanNode } = await import('../plan/operations.js');
const {
  loadActivePlanTree,
  loadConversationPlanRoots,
  PLAN_ATTENTION_NODE_LIMIT,
  renderOtherWorkLine,
} = await import('../plan/attention.js');

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
    { sessionId, planRootIds },
  );
}

/** A conversation that has started nothing. */
const COLD_SESSION = 'c01d0000-0000-4000-8000-000000000322';

/** A run `sessionId` drove, a live Helmsman conversation unless `driver` says otherwise. */
function activeRun(
  runId: string,
  slug: string,
  sessionId: string | null,
  planNodeId?: string,
  driver: 'live conversation' | 'operator' = 'live conversation',
): ActiveSpaceRun {
  return {
    runId,
    spaceId: SPACE,
    workflowSlug: slug,
    sessionId,
    drivenByLiveConversation: driver === 'live conversation',
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
  const OTHER_LINE = /^other work in this space, another conversation's to act on: /m;

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
      activeRun('run-free', 'ticker-market-digest', STREAM_315),
    ];
    fakeLedger.items = [
      {
        itemId: 'item-theirs-review',
        kind: 'workflow_run_completed',
        runId: 'run-theirs-review',
        workflowSlug: 'review-local-changes',
        planNodeId: theirSlice.nodeId,
        sessionId: STREAM_320,
        drivenByLiveConversation: true,
        createdAt: new Date('2026-10-05T09:00:00.000Z'),
      },
      {
        itemId: 'item-free',
        kind: 'workflow_run_failed',
        runId: 'run-free-earlier',
        workflowSlug: 'ticker-market-digest',
        planNodeId: null,
        sessionId: STREAM_315,
        drivenByLiveConversation: true,
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
    expect(lines).toContain(renderOtherWorkLine(1, 1));
  });

  it('says the counted work is another conversation’s, and names no call to read or act on it', async () => {
    await twoStreams();

    const line = (await turnAttention(COLD_SESSION)).split('\n').find((l) => OTHER_LINE.test(l));
    expect(line).toBe(
      "other work in this space, another conversation's to act on: 3 runs, 2 items",
    );
    expect(line).not.toMatch(/`/);
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

  it('gives a conversation that has started nothing every run, in the plan or not, and every item, as another’s', async () => {
    await twoStreams();

    const text = await turnAttention(COLD_SESSION);
    expect(text).not.toContain('run-ours-commission');
    expect(text).not.toContain('run-theirs-publication');
    expect(text).not.toContain('run-free');
    expect(text).not.toContain('item-free');
    expect(text).not.toContain('Active workflow runs');
    expect(text.split('\n')).toContain(renderOtherWorkLine(3, 2));
  });

  describe('a run serving no node is the live conversation’s that drove it, or the operator’s and every conversation’s', () => {
    /** Another stream's publication, paused on its approval and placed in no plan, with the item its pause raised. */
    function unplacedPausedPublication() {
      fakeLedger.runs = [activeRun('run-publication', 'publish-local-changes', STREAM_320)];
      fakeLedger.items = [
        {
          itemId: 'item-publication-paused',
          kind: 'workflow_run_paused',
          runId: 'run-publication',
          workflowSlug: 'publish-local-changes',
          planNodeId: null,
          sessionId: STREAM_320,
          drivenByLiveConversation: true,
          createdAt: new Date('2026-10-05T09:00:00.000Z'),
        },
      ];
    }

    it('another live conversation’s reads to a cold conversation as the count alone — no slug, no run id, no status', async () => {
      unplacedPausedPublication();

      const text = await turnAttention(COLD_SESSION);
      expect(text).not.toContain('publish-local-changes');
      expect(text).not.toContain('run-publication');
      expect(text).not.toContain('item-publication-paused');
      expect(text).not.toContain('paused');
      expect(text).not.toContain('No active workflow runs.');
      expect(text.split('\n')).toContain(renderOtherWorkLine(1, 1));
    });

    const FULL_LINE =
      '- ticker-market-digest (paused, liveness: waiting_for_input): 6/10 tasks complete [runId: run-digest]';

    it('one the operator started — from the web UI or through run_operation — reads in full to every conversation', async () => {
      await twoStreams();
      fakeLedger.runs.push(
        activeRun('run-digest', 'ticker-market-digest', null, undefined, 'operator'),
      );

      for (const conversation of [COLD_SESSION, STREAM_315, STREAM_320]) {
        const lines = (await turnAttention(conversation)).split('\n');
        expect(lines).toContain('Active workflow runs outside the plan:');
        expect(lines).toContain(FULL_LINE);
      }
      expect((await turnAttention(COLD_SESSION)).split('\n')).toContain(renderOtherWorkLine(3, 2));
    });

    it('one whose driving conversation has ended reads in full to every conversation, and is no longer counted', async () => {
      const ENDED_STREAM = 'e0de0000-0000-4000-8000-000000000322';
      fakeLedger.runs = [
        activeRun('run-digest', 'ticker-market-digest', ENDED_STREAM, undefined, 'operator'),
      ];

      for (const conversation of [COLD_SESSION, STREAM_320]) {
        const text = await turnAttention(conversation);
        expect(text.split('\n')).toContain('Active workflow runs:');
        expect(text.split('\n')).toContain(FULL_LINE);
        expect(text).not.toMatch(OTHER_LINE);
      }
    });

    it('carries its items with it: everyone’s run’s items read in full to every conversation, and none is counted', async () => {
      const ENDED_STREAM = 'e0de0000-0000-4000-8000-000000000322';
      const ownerless = (itemId: string, runId: string, sessionId: string | null) => ({
        itemId,
        kind: 'workflow_run_paused' as const,
        runId,
        workflowSlug: 'ticker-market-digest',
        planNodeId: null,
        sessionId,
        drivenByLiveConversation: false,
        createdAt: new Date('2026-10-05T09:00:00.000Z'),
      });
      fakeLedger.runs = [
        activeRun('run-digest', 'ticker-market-digest', null, undefined, 'operator'),
        activeRun('run-ended', 'ticker-market-digest', ENDED_STREAM, undefined, 'operator'),
      ];
      fakeLedger.items = [
        ownerless('item-operator', 'run-digest', null),
        ownerless('item-ended', 'run-ended', ENDED_STREAM),
      ];

      for (const conversation of [COLD_SESSION, STREAM_320]) {
        const lines = (await turnAttention(conversation)).split('\n');
        expect(lines).toContain(FULL_LINE);
        expect(lines).toContain(
          '- attention: workflow_run_paused — ticker-market-digest [itemId: item-operator, runId: run-digest]',
        );
        expect(lines).toContain(
          '- attention: workflow_run_paused — ticker-market-digest [itemId: item-ended, runId: run-ended]',
        );
        expect(lines.join('\n')).not.toMatch(OTHER_LINE);
      }
    });

    it('reads in full, with its paused item, to the conversation that drove it', async () => {
      unplacedPausedPublication();

      const lines = (await turnAttention(STREAM_320)).split('\n');
      expect(lines).toContain('Active workflow runs:');
      expect(lines).toContain(
        '- publish-local-changes (paused, liveness: waiting_for_input): 6/10 tasks complete [runId: run-publication]',
      );
      expect(lines).toContain(
        '- attention: workflow_run_paused — publish-local-changes [itemId: item-publication-paused, runId: run-publication]',
      );
      expect(lines.join('\n')).not.toMatch(OTHER_LINE);
    });
  });

  it('is the other stream’s view of the same space, the other way round', async () => {
    const { theirSlice } = await twoStreams();

    const lines = (await turnAttention(STREAM_320)).split('\n');
    const sliceLine = lines.findIndex((l) => l.includes(`[nodeId: ${theirSlice.nodeId}]`));
    expect(lines.slice(sliceLine + 1, sliceLine + 3)).toEqual([
      '    - publish-local-changes (paused, liveness: waiting_for_input): 6/10 tasks complete [runId: run-theirs-publication]',
      '    - attention: workflow_run_completed — review-local-changes [itemId: item-theirs-review, runId: run-theirs-review]',
    ]);
    const text = lines.join('\n');
    expect(text).not.toContain('item-free');
    expect(text).not.toContain('run-free');
    expect(lines).toContain(renderOtherWorkLine(2, 1));
  });

  /** `count` pending items about runs `sessionId` drove serving `planNodeId`, the first the newest, all from `from` back. */
  function pendingItems(
    prefix: string,
    count: number,
    planNodeId: string,
    sessionId: string,
    from: Date,
  ): PendingRunAttentionItem[] {
    return Array.from({ length: count }, (_, i) => ({
      itemId: `${prefix}-${String(i)}`,
      kind: 'workflow_run_paused' as const,
      runId: `run-${prefix}-${String(i)}`,
      workflowSlug: 'review-local-changes',
      planNodeId,
      sessionId,
      drivenByLiveConversation: true,
      createdAt: new Date(from.getTime() - i * 60_000),
    }));
  }

  it('shows every one of its own items however many newer ones other streams hold, and counts those exactly', async () => {
    const { finding, theirSlice } = await twoStreams();
    const ownCount = 3;
    const foreignCount = ATTENTION_ITEM_SURFACE_LIMIT + 7;
    fakeLedger.items.push(
      ...pendingItems(
        'ours',
        ownCount,
        finding.nodeId,
        STREAM_315,
        new Date('2026-10-05T07:00:00.000Z'),
      ),
      ...pendingItems(
        'theirs',
        foreignCount,
        theirSlice.nodeId,
        STREAM_320,
        new Date('2026-10-05T12:00:00.000Z'),
      ),
    );

    const text = await turnAttention(STREAM_315);
    for (let i = 0; i < ownCount; i++) {
      expect(text).toContain(`[itemId: ours-${String(i)}, runId: run-ours-${String(i)}]`);
    }
    expect(text).not.toContain('theirs-');
    expect(text).not.toContain("more of this conversation's attention items");
    // The fixture's own review of their slice is one more of theirs.
    expect(text.split('\n')).toContain(renderOtherWorkLine(1, foreignCount + 1));
  });

  it('shows its newest items up to the limit, and says how many more and where they are', async () => {
    const { finding } = await twoStreams();
    const extra = 4;
    fakeLedger.items.push(
      ...pendingItems(
        'ours',
        ATTENTION_ITEM_SURFACE_LIMIT + extra,
        finding.nodeId,
        STREAM_315,
        new Date('2026-10-05T12:00:00.000Z'),
      ),
    );

    const lines = (await turnAttention(STREAM_315)).split('\n');
    const shown = lines.filter((l) => l.includes('[itemId: ours-'));
    expect(shown).toHaveLength(ATTENTION_ITEM_SURFACE_LIMIT);
    expect(shown.at(-1)).toContain(`[itemId: ours-${String(ATTENTION_ITEM_SURFACE_LIMIT - 1)},`);
    expect(lines).toContain(
      `   ... and ${String(extra)} more of this conversation's attention items — use \`workflow.run.list_attention\``,
    );
    expect(lines).toContain(renderOtherWorkLine(1, 1));
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
