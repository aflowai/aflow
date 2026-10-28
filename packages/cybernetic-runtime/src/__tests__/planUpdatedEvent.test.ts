/**
 * Every committed plan-node write announces itself on the space's entity
 * events as `entity.plan.updated` (Plan 332 D9) — once, after the store has
 * committed it — and a refused write announces nothing. The open and place
 * writes of Plan 332 P2 return through the same choke point; their coverage
 * lands with them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type { EntityEventEnvelope, PlanNode, PlanNodeCreateInput } from '@aflow/schemas';

const log = vi.hoisted(() => ({ entries: [] as Array<string | EntityEventEnvelope> }));

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    appendEntityEvent: async (...args: Parameters<typeof actual.appendEntityEvent>) => {
      log.entries.push(args[1].event);
      return actual.appendEntityEvent(...args);
    },
  };
});

const { createPlanNode, linkEndedRun, linkPlanNode, updatePlanNode, dependPlanNode } =
  await import('../plan/operations.js');
const { emitPlanUpdated } = await import('../entityEvents.js');
const { getAttentionCache } = await import('../attentionCache.js');
const { InMemoryPlanNodeStore } = await import('./planStoreFake.js');

const TENANT = 'a0000000-0000-4000-8000-000000000332';
const SPACE = '5e1d0000-0000-4000-8000-000000000332';
const MISSING = '5e1d0000-0000-4000-8000-00000000dead';
const RUN = '0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6';

const NODE: PlanNodeCreateInput = {
  kind: 'execute',
  title: '332 · The plan page is live',
  goal: 'The page follows the plan without a reload.',
  criteria: 'A commission moves its step without a reload.',
};

/** The store methods that commit a write; each logs `commit:<name>` once it has. */
const COMMITS = [
  'insert',
  'updateAtRevision',
  'moveAtRevision',
  'insertLink',
  'setDependencyAtRevision',
] as const;

let store: InstanceType<typeof InMemoryPlanNodeStore>;
let redis: RedisType;

function ctx() {
  return { store, redis, tenantId: TENANT, spaceId: SPACE, createdBy: 'operator' };
}

async function created(input: Partial<PlanNodeCreateInput> = {}): Promise<PlanNode> {
  const result = await createPlanNode(ctx(), { ...NODE, ...input });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

/** What was logged since the last call: `commit:<method>` or the event's type and payload. */
function since(): Array<string | [string, Record<string, unknown>]> {
  const taken = log.entries.splice(0);
  return taken.map((entry) =>
    typeof entry === 'string' ? entry : [entry.eventType, entry.payload],
  );
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  const methods = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of COMMITS) {
    const committed = methods[name]!;
    methods[name] = async (...args: unknown[]) => {
      const result = await committed(...args);
      log.entries.push(`commit:${name}`);
      return result;
    };
  }
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
  log.entries.length = 0;
});

describe('entity.plan.updated — once per committed write, after the commit', () => {
  it('announces a create with the new node and its revision', async () => {
    const node = await created();
    expect(since()).toEqual([
      'commit:insert',
      ['entity.plan.updated', { nodeId: node.nodeId, revision: 1 }],
    ]);
  });

  it('announces an update with the revision it wrote, a move included', async () => {
    const node = await created();
    const parent = await created({ title: 'Another plan' });
    since();

    const updated = await updatePlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      note: 'Proposed: subscribe the page.',
    });
    expect(updated.ok).toBe(true);
    expect(since()).toEqual([
      'commit:updateAtRevision',
      ['entity.plan.updated', { nodeId: node.nodeId, revision: 2 }],
    ]);

    await updatePlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: 2,
      parentId: parent.nodeId,
    });
    expect(since()).toEqual([
      'commit:moveAtRevision',
      ['entity.plan.updated', { nodeId: node.nodeId, revision: 3 }],
    ]);
  });

  it('announces a link with the node’s revision, which the link leaves where it stands', async () => {
    const node = await created();
    since();

    await linkPlanNode(ctx(), { nodeId: node.nodeId, kind: 'run', ref: RUN });
    expect(since()).toEqual([
      'commit:insertLink',
      ['entity.plan.updated', { nodeId: node.nodeId, revision: 1 }],
    ]);
  });

  it('announces a run’s ending links once, however many it wrote', async () => {
    const node = await created();
    since();

    await linkEndedRun(ctx(), {
      nodeId: node.nodeId,
      runId: RUN,
      slug: 'commission-change',
      status: 'completed',
      pullRequestUrl: 'https://github.com/aflowai/aflow/pull/213',
    });
    expect(since()).toEqual([
      'commit:insertLink',
      'commit:insertLink',
      ['entity.plan.updated', { nodeId: node.nodeId, revision: 1 }],
    ]);

    await linkEndedRun(ctx(), {
      nodeId: node.nodeId,
      runId: RUN,
      slug: 'commission-change',
      status: 'completed',
    });
    expect(since()).toEqual(['commit:insertLink']);
  });

  it('announces what a node waits on, a write of that node', async () => {
    const waiting = await created();
    const first = await created({ title: 'First' });
    since();

    await dependPlanNode(ctx(), {
      nodeId: waiting.nodeId,
      expectedRevision: 1,
      dependsOnId: first.nodeId,
      condition: 'done',
    });
    expect(since()).toEqual([
      'commit:setDependencyAtRevision',
      ['entity.plan.updated', { nodeId: waiting.nodeId, revision: 2 }],
    ]);
  });
});

describe('entity.plan.updated — never for a refused write', () => {
  it('announces nothing for a refused create', async () => {
    const refused = await createPlanNode(ctx(), { ...NODE, parentId: MISSING });
    expect(refused).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
    expect(since().filter((entry) => typeof entry !== 'string')).toEqual([]);
  });

  it('announces nothing for a stale, unchanged or missing update', async () => {
    const node = await created();
    since();

    const refusals = [
      await updatePlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 7, title: 'Later' }),
      await updatePlanNode(ctx(), { nodeId: node.nodeId, expectedRevision: 1, title: NODE.title }),
      await updatePlanNode(ctx(), { nodeId: MISSING, expectedRevision: 1, title: 'Gone' }),
    ];
    expect(refusals.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'PLAN_NODE_STALE',
      'PLAN_NODE_UNCHANGED',
      'PLAN_NODE_NOT_FOUND',
    ]);
    expect(since()).toEqual([]);
  });

  it('announces nothing for a link the node already holds, or to a node that is gone', async () => {
    const node = await created();
    await linkPlanNode(ctx(), { nodeId: node.nodeId, kind: 'run', ref: RUN });
    since();

    const refusals = [
      await linkPlanNode(ctx(), { nodeId: node.nodeId, kind: 'run', ref: RUN }),
      await linkPlanNode(ctx(), { nodeId: MISSING, kind: 'run', ref: RUN }),
    ];
    expect(refusals.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'PLAN_NODE_LINK_EXISTS',
      'PLAN_NODE_NOT_FOUND',
    ]);
    expect(since().filter((entry) => typeof entry !== 'string')).toEqual([]);
  });
});

describe('emitPlanUpdated', () => {
  it('leaves the attention generation to the write path that called it', async () => {
    const before = (await getAttentionCache(redis, TENANT, SPACE)).generation;
    await emitPlanUpdated(redis, { tenantId: TENANT, spaceId: SPACE, nodeId: RUN, revision: 1 });
    expect((await getAttentionCache(redis, TENANT, SPACE)).generation).toBe(before);
  });

  it('never throws, whatever Redis does', async () => {
    const broken = {
      multi: () => {
        throw new Error('connection lost');
      },
    } as unknown as RedisType;
    await expect(
      emitPlanUpdated(broken, { tenantId: TENANT, spaceId: SPACE, nodeId: RUN, revision: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      emitPlanUpdated(null, { tenantId: TENANT, spaceId: SPACE, nodeId: RUN, revision: 1 }),
    ).resolves.toBeUndefined();
  });
});
