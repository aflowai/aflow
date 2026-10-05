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
import type { ActiveRunWithTaskCounts } from '../ledger/types.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000741';
const SPACE = '5e1d0000-0000-4000-8000-000000000741';
const SESSION = 'c01d0000-0000-4000-8000-000000000741';

const planStore = new InMemoryPlanNodeStore();

interface AttentionRow {
  id: string;
  spaceId: string;
  kind: string;
  relatedRunId: string | null;
  createdAt: Date;
  consumed: boolean;
}

/** The tenant's `attention_items` and the runs they name, as Postgres would hold them. */
const table = {
  items: [] as AttentionRow[],
  runs: new Map<string, { workflowSlug: string; planNodeId: string | null }>(),
  active: [] as ActiveRunWithTaskCounts[],
};

function pendingNewestFirst(): AttentionRow[] {
  return table.items
    .filter((row) => !row.consumed && row.spaceId === SPACE)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
      consumed: false,
    });
    return [[id]];
  }
  if (query.startsWith('update "attention_items"')) {
    const row = table.items.find((item) => !item.consumed && params.includes(item.id));
    if (!row) return [];
    row.consumed = true;
    return [[row.spaceId]];
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
        row.createdAt.toISOString(),
      ];
    });
  }
  if (query.includes('from "attention_items"') && query.includes('group by')) {
    const counts = new Map<string | null, number>();
    for (const row of pendingNewestFirst()) {
      const node =
        (row.relatedRunId !== null ? table.runs.get(row.relatedRunId)?.planNodeId : null) ?? null;
      counts.set(node, (counts.get(node) ?? 0) + 1);
    }
    return [...counts];
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
  return { ...actual, createPlanNodeStore: () => planStore };
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
const { addAttentionItem, markAttentionConsumed } = await import('../ledger/attention.js');
const { emitRunUpdated } = await import('../runEvents.js');

const DB = fakeDb();
let redis: RedisType;

/** One Helmsman turn's attention block, read through the space's cache. */
async function turnAttention(): Promise<string> {
  return renderAttentionContext(
    await buildHelmsmanAttention({ tenantId: TENANT, spaceId: SPACE, db: DB, redis }),
    { planRootIds: [] },
  );
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
    ['run-review', { workflowSlug: 'review-local-changes', planNodeId: null }],
  ]);
  table.active = [];
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

    await markAttentionConsumed(DB, redis, TENANT, { id: itemId, consumedBySession: SESSION });
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
      consumed: false,
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
