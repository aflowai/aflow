/**
 * Plan 331 D1 — overlap is a rule of the agent schedule's firing path, not of
 * the model. An occurrence whose schedule's previous run has not ended is
 * recorded as skipped: no run starts, the schedule moves to its next time
 * from now, so nothing catches up after the run, and the skip spends none of
 * its firing cap. Once the run has ended the next occurrence fires as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import { planResidentScheduleInput } from '@aflow/schemas';

const sessions = vi.hoisted(() => new Map<string, { status: string }>());
vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/redis')>()),
  getSessionState: (_redis: unknown, _tenantId: string, sessionId: string) =>
    Promise.resolve(sessions.get(sessionId) ?? null),
}));

const { ScheduleEvaluator } = await import('../ScheduleEvaluator.js');
const { requestResidentWake, residentPendingKey, scheduleStartingKey } =
  await import('@aflow/cybernetic-runtime');
type ResidentSchedule = import('@aflow/cybernetic-runtime').ResidentSchedule;
type ScheduleDispatchItem = import('@aflow/database').ScheduleDispatchItem;

const TENANT = 'a0000000-0000-4000-8000-000000000331';
const SPACE = 'b0000000-0000-4000-8000-000000000331';
const SCHEDULE = 'c0000000-0000-4000-8000-000000000331';
const PREVIOUS_RUN = 'd0000000-0000-4000-8000-000000000331';

let redis: RedisType;
let statements: Array<{ query: string; params: unknown[] }>;
let transactions: number;

function sqlClient(): postgres.Sql {
  const unsafe = (query: string, params: unknown[] = []) => {
    statements.push({ query, params });
    if (query.includes('RETURNING firing_count')) return Promise.resolve([{ firing_count: 8 }]);
    return Promise.resolve([]);
  };
  return {
    unsafe,
    begin: (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => {
      transactions += 1;
      return fn({ unsafe });
    },
  } as unknown as postgres.Sql;
}

function residentRow() {
  return {
    id: SCHEDULE,
    tenant_schema: 't_a0000000000040008000000000000331',
    tenant_id: TENANT,
    space_id: SPACE,
    name: 'Resident',
    action: 'start_run',
    target_kind: 'platform-role',
    target_system_role: 'cybernetic-helmsman',
    target_agent_id: null,
    agent_version: null,
    target_session_id: null,
    target_step_execution_id: null,
    kind: 'cron',
    cron_expression: '*/15 * * * *',
    timezone: 'UTC',
    scheduled_at: null,
    next_fire_at_text: '2026-10-27 10:15:00+00',
    source_kind: null,
    source_system_role: null,
    source_agent_id: null,
    source_status: null,
    input_template: planResidentScheduleInput(),
    status: 'active',
    max_firings: 50,
    firing_count: 7,
    last_session_id: PREVIOUS_RUN,
    expires_at: null,
    creator_user_id: '1eab6e64-861a-4b99-b396-74f35b111dbb',
    creator_tenant_role: 'admin',
    creator_space_role: 'editor',
  };
}

async function occur(): Promise<boolean> {
  const evaluator = new ScheduleEvaluator({
    redis,
    sqlClient: sqlClient(),
    db: {} as never,
    mode: 'observe',
  }) as unknown as { recordOccurrence(row: unknown): Promise<boolean> };
  return evaluator.recordOccurrence(residentRow());
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as RedisType;
  await redis.flushall();
  sessions.clear();
  statements = [];
  transactions = 0;
});

describe('an occurrence while the previous run is in flight (Plan 331 D1)', () => {
  it('starts no run and is recorded as skipped, moving to the next time without spending a firing', async () => {
    sessions.set(PREVIOUS_RUN, { status: 'RUNNING' });
    expect(await occur()).toBe(false);
    expect(transactions).toBe(0);
    expect(statements).toHaveLength(1);
    const [skip] = statements;
    expect(skip!.query).toContain("'{overlap}'");
    expect(skip!.query).not.toContain('firing_count = firing_count + 1');
    expect(skip!.query).not.toContain('schedule_dispatch_outbox');
    // The next time is computed from now: no catch-up firing for the one skipped.
    expect(new Date(String(skip!.params[0])).getTime()).toBeGreaterThan(Date.now());
    expect(skip!.params[1]).toBe(PREVIOUS_RUN);
  });

  it('fires as before once the previous run has ended, and holds the next occurrence until its own run starts', async () => {
    sessions.set(PREVIOUS_RUN, { status: 'SUCCEEDED' });
    expect(await occur()).toBe(true);
    expect(transactions).toBe(1);
    expect(statements.some((s) => s.query.includes('schedule_dispatch_outbox'))).toBe(true);
    expect(await redis.get(scheduleStartingKey(TENANT, SCHEDULE))).not.toBeNull();

    statements = [];
    expect(await occur()).toBe(false);
    expect(statements[0]!.query).toContain("'{overlap}'");
  });
});

describe('heartbeats and event wakes share one guard (Plan 331 D4)', () => {
  let enqueued: ScheduleDispatchItem[];

  function resident(): ResidentSchedule {
    const row = residentRow();
    return {
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      action: row.action,
      targetKind: row.target_kind,
      targetSystemRole: row.target_system_role,
      targetAgentId: null,
      agentVersion: null,
      targetSessionId: null,
      targetStepExecutionId: null,
      inputTemplate: row.input_template,
      firingCount: row.firing_count,
      lastSessionId: row.last_session_id,
      creatorUserId: row.creator_user_id,
      creatorTenantRole: row.creator_tenant_role,
      creatorSpaceRole: row.creator_space_role,
    };
  }

  function event() {
    return requestResidentWake(
      {
        redis,
        schedules: {
          find: () => Promise.resolve(resident()),
          enqueue: (item: ScheduleDispatchItem) => {
            enqueued.push(item);
            return Promise.resolve();
          },
        },
      },
      { tenantId: TENANT, spaceId: SPACE, cause: 'run_ended' },
    );
  }

  const fired = () => statements.filter((s) => s.query.includes('schedule_dispatch_outbox')).length;
  const skipped = () => statements.filter((s) => s.query.includes("'{overlap}'")).length;

  beforeEach(() => {
    enqueued = [];
    sessions.set(PREVIOUS_RUN, { status: 'SUCCEEDED' });
  });

  it('a heartbeat and an event arriving while an event’s wake is in flight: one wake, the heartbeat skipped, the event pending', async () => {
    expect(await event()).toBe('started');
    expect(await occur()).toBe(false);
    expect(await event()).toBe('pending');

    expect(enqueued).toHaveLength(1);
    expect(fired()).toBe(0);
    expect(skipped()).toBe(1);
    expect(await redis.get(residentPendingKey(TENANT, SPACE))).not.toBeNull();
  });

  it('an event arriving while a heartbeat’s wake is in flight is marked pending, not started beside it', async () => {
    expect(await occur()).toBe(true);
    expect(await event()).toBe('pending');
    expect(await occur()).toBe(false);

    expect(fired()).toBe(1);
    expect(enqueued).toEqual([]);
    expect(skipped()).toBe(1);
    expect(await redis.get(residentPendingKey(TENANT, SPACE))).not.toBeNull();
  });

  it('a heartbeat and an event arriving at once start exactly one wake', async () => {
    const [heartbeat, woke] = await Promise.all([occur(), event()]);
    expect(Number(heartbeat) + Number(woke === 'started')).toBe(1);
    expect(fired() + enqueued.length).toBe(1);
  });

  it('a heartbeat whose advance loses to another instance gives the guard back', async () => {
    const lost = new ScheduleEvaluator({
      redis,
      sqlClient: {
        unsafe: () => Promise.resolve([]),
        begin: (fn: (tx: { unsafe: () => Promise<unknown[]> }) => Promise<unknown>) =>
          fn({ unsafe: () => Promise.resolve([]) }),
      } as unknown as postgres.Sql,
      db: {} as never,
      mode: 'observe',
    }) as unknown as { recordOccurrence(row: unknown): Promise<boolean> };
    expect(await lost.recordOccurrence(residentRow())).toBe(false);
    expect(await redis.get(scheduleStartingKey(TENANT, SCHEDULE))).toBeNull();
    expect(await event()).toBe('started');
  });
});
