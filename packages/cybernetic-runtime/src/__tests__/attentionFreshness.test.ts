/**
 * The attention block is cached per space, so what it shows is only as fresh
 * as the writes that bump its generation. Here the ledger's own attention
 * writes run for real, their statements answered from an in-memory table, and
 * each is followed by the next turn's build of the cached block.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { configureLogging } from '@aflow/observability';
import type { ActiveSpaceRun } from '../ledger/types.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000741';
const SPACE = '5e1d0000-0000-4000-8000-000000000741';
const SESSION = 'c01d0000-0000-4000-8000-000000000741';
/** A second conversation in the space, which drove none of the runs `SESSION` did. */
const OTHER_SESSION = 'c01d0000-0000-4000-8000-000000000742';

const planStore = { current: new InMemoryPlanNodeStore() };

interface RunRow {
  workflowSlug: string;
  planNodeId: string | null;
  sessionId: string | null;
}

interface AttentionRow {
  id: string;
  spaceId: string;
  kind: string;
  relatedRunId: string | null;
  createdAt: Date;
  consumedAt: Date | null;
  consumedBySession: string | null;
}

/** The tenant's `attention_items` and the runs they name, as Postgres would hold them. */
const table = {
  items: [] as AttentionRow[],
  runs: new Map<string, RunRow>(),
  active: [] as ActiveSpaceRun[],
};

function newestFirst(rows: AttentionRow[]): AttentionRow[] {
  return rows
    .filter((row) => row.spaceId === SPACE)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function pendingNewestFirst(): AttentionRow[] {
  return newestFirst(table.items.filter((row) => row.consumedAt === null));
}

function consume(rows: AttentionRow[], consumedBySession: string | null): AttentionRow[] {
  for (const row of rows) Object.assign(row, { consumedAt: new Date(), consumedBySession });
  return rows;
}

/** The statements the attention ledger issues, answered from `table`; anything else reads nothing. */
function answer(query: string, params: readonly unknown[]): unknown[][] {
  const param = (token: string) => params[Number(token.slice(1)) - 1];
  if (query.startsWith('insert into "attention_items"')) {
    const [, columns, values] = /\(([^)]*)\) values \((.*)\) returning/.exec(query) ?? [];
    const row = new Map(
      (columns ?? '')
        .split(', ')
        .map((column, i) => [column.replaceAll('"', ''), (values ?? '').split(', ')[i]] as const)
        .filter(([, value]) => value?.startsWith('$'))
        .map(([column, value]) => [column, param(value!)]),
    );
    const id = randomUUID();
    table.items.push({
      id,
      spaceId: row.get('space_id') as string,
      kind: row.get('kind') as string,
      relatedRunId: (row.get('related_run_id') as string | null | undefined) ?? null,
      createdAt: new Date(),
      consumedAt: null,
      consumedBySession: null,
    });
    return [[id]];
  }
  if (query.startsWith('update "attention_items"')) {
    const pending = table.items.filter((item) => item.consumedAt === null);
    if (query.includes('"consumed_by_session" =')) {
      const [, session] = params;
      const read = pending.filter((item) => params.includes(item.id));
      return consume(read, session as string).map((row) => [row.spaceId]);
    }
    consume(
      pending.filter(
        (item) => item.kind === 'workflow_run_paused' && params.includes(item.relatedRunId),
      ),
      null,
    );
    return [];
  }
  if (query.startsWith('select') && query.includes(' limit ') && !query.includes('row_number()')) {
    const rows = query.includes('consumed_at IS NULL')
      ? pendingNewestFirst()
      : newestFirst(table.items);
    return rows.map((row) => [
      row.id,
      TENANT,
      null,
      row.spaceId,
      row.kind,
      row.relatedRunId,
      null,
      {},
      0,
      row.createdAt.toISOString(),
      row.consumedAt?.toISOString() ?? null,
      row.consumedBySession,
    ]);
  }
  if (query.includes('row_number()')) {
    return pendingNewestFirst().map((row) => {
      const run = row.relatedRunId !== null ? table.runs.get(row.relatedRunId) : undefined;
      return [
        row.id,
        row.kind,
        row.relatedRunId,
        run?.workflowSlug ?? null,
        run?.planNodeId ?? null,
        run?.sessionId ?? null,
        row.createdAt.toISOString(),
      ];
    });
  }
  if (query.includes('from "attention_items"') && query.includes('group by')) {
    const counts = new Map<string, [string | null, string | null, number]>();
    for (const row of pendingNewestFirst()) {
      const run = row.relatedRunId !== null ? table.runs.get(row.relatedRunId) : undefined;
      const group = [run?.planNodeId ?? null, run?.sessionId ?? null] as const;
      const key = JSON.stringify(group);
      counts.set(key, [...group, (counts.get(key)?.[2] ?? 0) + 1]);
    }
    return [...counts.values()];
  }
  return [];
}

/** A real drizzle instance over a fake postgres-js client: every statement is rendered, none reaches a database. */
function fakeDb(): PostgresJsDatabase {
  const client: object = Object.assign(
    () => {
      throw new Error('tagged-template query is not expected');
    },
    {
      unsafe: (query: string, params: unknown[] = []) => {
        const rows = answer(query, params);
        return Object.assign(Promise.resolve(rows), { values: () => Promise.resolve(rows) });
      },
      begin: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
      options: { parsers: {}, serializers: {} },
    },
  );
  return drizzle(client as unknown as postgres.Sql);
}

vi.mock('../plan/store.js', async () => {
  const actual = await vi.importActual<typeof import('../plan/store.js')>('../plan/store.js');
  return { ...actual, createPlanNodeStore: () => planStore.current };
});
vi.mock('../ledger/queries.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/queries.js')>('../ledger/queries.js');
  return {
    ...actual,
    listActiveRunsWithLiveness: () => Promise.resolve(table.active),
    listPlanNodeIdsDrivenBySession: () => Promise.resolve([]),
  };
});
vi.mock('../skill.js', async () => {
  const actual = await vi.importActual<typeof import('../skill.js')>('../skill.js');
  return { ...actual, listSkillsForSpace: () => Promise.resolve([]) };
});
vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    createAppletPersistence: () => ({
      transact: () => Promise.resolve({ items: [], total: 0 }),
    }),
  };
});

const { buildHelmsmanAttention, renderAttentionContext } = await import('../attentionBuilder.js');
const { readAttentionForTurn, consumeAttentionReadByTurn } = await import('../attentionTurn.js');
const {
  addAttentionItem,
  addAttentionItemInTransaction,
  listAttentionItems,
  markAttentionConsumed,
} = await import('../ledger/attention.js');
const { emitRunUpdated } = await import('../runEvents.js');
const { createPlanNode } = await import('../plan/operations.js');
const { renderOtherWorkLine } = await import('../plan/attention.js');

const DB = fakeDb();
let redis: RedisType;

/** The block as it reads through the space's cache for `sessionId`, read by no turn. */
async function turnAttention(sessionId = SESSION): Promise<string> {
  return renderAttentionContext(
    await buildHelmsmanAttention({ tenantId: TENANT, spaceId: SPACE, db: DB, redis }),
    { sessionId, planRootIds: [] },
  );
}

/**
 * One Helmsman turn of `sessionId`'s conversation: the block is built for it
 * and, as the orchestrator does on the turn's step-succeeded path, what it
 * showed is consumed only when the turn succeeds.
 */
async function turn(
  sessionId: string,
  outcome: 'succeeds' | 'fails',
  planRootIds: string[] = [],
): Promise<string> {
  const attention = await readAttentionForTurn({
    tenantId: TENANT,
    spaceId: SPACE,
    conversation: { sessionId, planRootIds },
    db: DB,
    redis,
  });
  if (outcome === 'succeeds') {
    await consumeAttentionReadByTurn({
      tenantId: TENANT,
      sessionId,
      itemIds: attention.itemIds,
      db: DB,
      redis,
    });
  }
  return attention.text;
}

function row(itemId: string): AttentionRow {
  const found = table.items.find((item) => item.id === itemId);
  if (!found) throw new Error(`no attention item ${itemId}`);
  return found;
}

function pausedItem(runId: string) {
  return {
    spaceId: SPACE,
    kind: 'workflow_run_paused' as const,
    relatedRunId: runId,
    payload: {},
    priority: 0,
  };
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(async () => {
  table.items = [];
  table.runs = new Map([
    ['run-review', { workflowSlug: 'review-local-changes', planNodeId: null, sessionId: SESSION }],
  ]);
  table.active = [];
  planStore.current = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  // ioredis-mock instances share one keyspace.
  await redis.flushall();
});

describe('the cached attention block reads the attention items as they stand', () => {
  it('shows an item written since the last turn, and drops it once consumed', async () => {
    expect(await turnAttention()).not.toContain('run-review');

    const itemId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-review'));
    expect(await turnAttention()).toContain(
      `- attention: workflow_run_paused — review-local-changes [itemId: ${itemId}, runId: run-review]`,
    );

    await markAttentionConsumed(DB, redis, TENANT, { ids: [itemId], consumedBySession: SESSION });
    expect(await turnAttention()).not.toContain(itemId);
  });

  it('is the generation bump that makes it so — an item written around the ledger stays unseen', async () => {
    await turnAttention();
    table.items.push({
      id: 'item-around-the-ledger',
      spaceId: SPACE,
      kind: 'workflow_run_paused',
      relatedRunId: 'run-review',
      createdAt: new Date(),
      consumedAt: null,
      consumedBySession: null,
    });
    expect(await turnAttention()).not.toContain('item-around-the-ledger');
  });

  it('shows a run from the turn after it starts, and not after it ends', async () => {
    expect(await turnAttention()).toContain('No active workflow runs.');

    table.active = [
      {
        runId: 'run-commission',
        spaceId: SPACE,
        workflowSlug: 'commission-change',
        sessionId: SESSION,
        drivenByLiveConversation: true,
        status: 'running',
        startedAt: new Date('2026-10-05T08:00:00.000Z'),
        schedulerCursorAt: null,
        totalTasks: 4,
        succeededTasks: 1,
        liveTasks: 1,
        scheduledTasks: 0,
        pausedTasks: 0,
      },
    ];
    const transition = {
      tenantId: TENANT,
      spaceId: SPACE,
      runId: 'run-commission',
      workflowSlug: 'commission-change',
    };
    await emitRunUpdated(redis, { ...transition, status: 'running' });
    expect(await turnAttention()).toContain('[runId: run-commission]');

    table.active = [];
    await emitRunUpdated(redis, { ...transition, status: 'completed' });
    expect(await turnAttention()).not.toContain('run-commission');
  });
});

describe('an attention item is a wake-up, read once', () => {
  it('is consumed by the turn that reads it once that turn succeeds, so the next turn no longer shows it', async () => {
    const itemId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-review'));

    expect(await turn(SESSION, 'succeeds')).toContain(`[itemId: ${itemId}, runId: run-review]`);
    expect(row(itemId)).toMatchObject({ consumedBySession: SESSION, consumedAt: expect.any(Date) });

    expect(await turn(SESSION, 'succeeds')).not.toContain(itemId);
  });

  it('stays pending when the turn that read it fails, and the next turn shows it again', async () => {
    const itemId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-review'));
    const line = `[itemId: ${itemId}, runId: run-review]`;

    expect(await turn(SESSION, 'fails')).toContain(line);
    expect(row(itemId)).toMatchObject({ consumedAt: null, consumedBySession: null });

    expect(await turn(SESSION, 'succeeds')).toContain(line);
    expect(row(itemId)).toMatchObject({ consumedBySession: SESSION, consumedAt: expect.any(Date) });
  });

  it("is never read or consumed by a conversation that did not drive its run, which counts it as another's", async () => {
    const itemId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-review'));

    const others = await turn(OTHER_SESSION, 'succeeds');
    expect(others).not.toContain(itemId);
    expect(others).toContain(renderOtherWorkLine(0, 1));
    expect(row(itemId)).toMatchObject({ consumedAt: null, consumedBySession: null });

    const own = await turn(SESSION, 'succeeds');
    expect(own).toContain(`[itemId: ${itemId}, runId: run-review]`);
    expect(own).not.toContain("not this conversation's");
    expect(row(itemId)).toMatchObject({ consumedBySession: SESSION, consumedAt: expect.any(Date) });
  });

  it('is nobody’s when no conversation drove its run: counted for every conversation, consumed by none', async () => {
    table.runs.set('run-scheduled', {
      workflowSlug: 'ticker-market-digest',
      planNodeId: null,
      sessionId: null,
    });
    const itemId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-scheduled'));

    for (const sessionId of [SESSION, OTHER_SESSION]) {
      const block = await turn(sessionId, 'succeeds');
      expect(block).not.toContain(itemId);
      expect(block).toContain(renderOtherWorkLine(0, 1));
    }
    expect(row(itemId).consumedAt).toBeNull();
  });

  it("consumes a resumed run's pause when the run's terminal item is written", async () => {
    const transition = {
      tenantId: TENANT,
      spaceId: SPACE,
      runId: 'run-review',
      workflowSlug: 'review-local-changes',
    };
    const pausedId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-review'));
    await emitRunUpdated(redis, { ...transition, status: 'running' });
    expect(row(pausedId).consumedAt).toBeNull();

    const completedId = await addAttentionItemInTransaction(DB, TENANT, {
      ...pausedItem('run-review'),
      kind: 'workflow_run_completed',
    });
    await emitRunUpdated(redis, { ...transition, status: 'completed' });

    expect(row(pausedId)).toMatchObject({ consumedAt: expect.any(Date), consumedBySession: null });
    expect(row(completedId).consumedAt).toBeNull();
    const block = await turnAttention();
    expect(block).toContain(`attention: workflow_run_completed — review-local-changes`);
    expect(block).not.toContain(pausedId);
  });

  it("counts another conversation's pending items only", async () => {
    const created = await createPlanNode(
      {
        store: planStore.current,
        redis,
        tenantId: TENANT,
        spaceId: SPACE,
        createdBy: 'operator',
      },
      {
        kind: 'execute',
        title: '322 · Plans are platform records',
        goal: 'Work flows through the node.',
        criteria: 'Every run serves the node it was started for.',
      },
    );
    if (!created.ok) throw new Error(created.message);
    const rootId = created.node.nodeId;
    const owner = OTHER_SESSION;
    table.runs.set('run-commission', {
      workflowSlug: 'commission-change',
      planNodeId: rootId,
      sessionId: owner,
    });
    table.runs.set('run-publish', {
      workflowSlug: 'local-publish',
      planNodeId: rootId,
      sessionId: owner,
    });

    const readId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-commission'));
    await addAttentionItem(DB, redis, TENANT, pausedItem('run-publish'));
    expect(await turnAttention()).toContain("not this conversation's: 0 runs, 2 items");

    await markAttentionConsumed(DB, redis, TENANT, { ids: [readId], consumedBySession: owner });
    expect(await turnAttention()).toContain("not this conversation's: 0 runs, 1 items");

    await turn(owner, 'succeeds', [rootId]);
    expect(await turnAttention()).not.toContain("not this conversation's");
  });

  it('is listed again by workflow.run.list_attention when consumed ones are asked for', async () => {
    const itemId = await addAttentionItem(DB, redis, TENANT, pausedItem('run-review'));
    await turn(SESSION, 'succeeds');

    expect(await listAttentionItems(DB, TENANT, { spaceId: SPACE })).toEqual([]);
    const listed = await listAttentionItems(DB, TENANT, { spaceId: SPACE, includeConsumed: true });
    expect(listed).toEqual([
      expect.objectContaining({
        id: itemId,
        consumedAt: expect.any(Date),
        consumedBySession: SESSION,
      }),
    ]);
  });
});
