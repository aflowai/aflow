import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AgentScheduleRow } from '@aflow/database';
import { CHAT_SCHEDULE_LIST_LIMIT, type TenantId } from '@aflow/schemas';
import type { ActionCenterContext, ActionCenterSourceDeps } from '../types.js';

/**
 * `pairs` stands for what the chain query picks, one arrival and its newest
 * renewal per chain, and `rows` for the schedules the second read loads.
 */
const table = vi.hoisted(() => ({
  pairs: [] as Array<{ arrival_id: string; current_id: string }>,
  rows: [] as unknown[],
  executed: [] as unknown[],
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const query = {
    from: () => query,
    where: () => Object.assign(Promise.resolve(table.rows), { limit: () => table.rows }),
  };
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => query,
        execute: (statement: unknown) => {
          table.executed.push(statement);
          return Promise.resolve(table.pairs);
        },
      }),
  };
});

const { createTriggerArmedSource, readChatScheduleChains } =
  await import('./triggerArmedSource.js');

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const ARMING_SESSION = 'f0000000-0000-4000-8000-000000000011';
const ORIGINAL = '5247eee7-0000-4000-8000-000000000001';
const SUCCESSOR = '6247eee7-0000-4000-8000-000000000002';
const OTHER = '7247eee7-0000-4000-8000-000000000003';

function schedule(id: string, overrides: Partial<AgentScheduleRow>): AgentScheduleRow {
  const at = new Date();
  return {
    id,
    spaceId: SPACE,
    name: 'Local PR Shepherd',
    description: null,
    action: 'start_run',
    targetKind: 'custom-agent',
    targetSystemRole: null,
    targetAgentId: 'c0000000-0000-4000-8000-0000000000a1',
    agentVersion: null,
    targetSessionId: null,
    targetStepExecutionId: null,
    kind: 'cron',
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    scheduledAt: null,
    sourceKind: null,
    sourceSystemRole: null,
    sourceAgentId: null,
    sourceStatus: null,
    inputTemplate: {},
    status: 'active',
    maxFirings: 50,
    firingCount: 0,
    lastFiredAt: null,
    lastSessionId: null,
    nextFireAt: null,
    expiresAt: null,
    lastError: null,
    createdBy: null,
    createdBySessionId: ARMING_SESSION,
    metadata: {},
    renewsScheduleId: null,
    creatorUserId: null,
    creatorTenantRole: null,
    creatorSpaceRole: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const armed = schedule(ORIGINAL, {});
const renewal = schedule(SUCCESSOR, { renewsScheduleId: ORIGINAL });
const source = createTriggerArmedSource({} as ActionCenterSourceDeps);
const ctx = { tenantId: TENANT, spaceId: SPACE } as ActionCenterContext;

const scope = { tenantId: TENANT, spaceId: SPACE };

function chain(arrival: AgentScheduleRow, current: AgentScheduleRow = arrival): void {
  table.pairs.push({ arrival_id: arrival.id, current_id: current.id });
  table.rows.push(arrival, current);
}

beforeEach(() => {
  table.pairs = [];
  table.rows = [];
  table.executed = [];
});

describe('the chain query', () => {
  it('keeps to arrivals armed in chat, not deleted, and stops at the lane limit', async () => {
    await readChatScheduleChains({} as PostgresJsDatabase, TENANT, SPACE);
    const statement = table.executed[0] as SQL;
    const query = new PgDialect().sqlToQuery(statement);
    const text = query.sql.replace(/\s+/g, ' ');
    expect(text).toContain('created_by_session_id IS NOT NULL');
    expect(text).toContain('renews_schedule_id IS NULL');
    expect(text).toContain("status <> 'deleted'");
    expect(text).toMatch(/ORDER BY created_at DESC LIMIT \$\d+/);
    expect(query.params).toContain(CHAT_SCHEDULE_LIST_LIMIT);
  });

  it('pairs each arrival with its newest renewal, in the order the shared rule gives', async () => {
    const earlier = schedule(OTHER, { createdAt: new Date(Date.now() - 60_000) });
    chain(earlier);
    chain(armed, renewal);
    const chains = await readChatScheduleChains({} as PostgresJsDatabase, TENANT, SPACE);
    expect(chains.map((c) => [c.arrival.id, c.current.id])).toEqual([
      [ORIGINAL, SUCCESSOR],
      [OTHER, OTHER],
    ]);
  });
});

describe('a renewal is not news of an arming', () => {
  it('lists the schedule armed in chat and not its renewal', async () => {
    chain(armed, renewal);
    const items = await source.listOpen(scope);
    expect(items.map((item) => item.id)).toEqual([`trigger-armed:${ORIGINAL}`]);
  });

  it('lists no arrival the shared rule refuses', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    chain(schedule(ORIGINAL, { createdBySessionId: null }));
    chain(schedule(OTHER, { createdAt: old }));
    expect(await source.listOpen(scope)).toEqual([]);
  });

  it('finds no item for a renewal by its id', async () => {
    table.rows = [renewal];
    expect(await source.getById(ctx, `trigger-armed:${SUCCESSOR}`)).toBeNull();
    table.rows = [armed];
    expect(await source.getById(ctx, `trigger-armed:${ORIGINAL}`)).not.toBeNull();
  });
});
