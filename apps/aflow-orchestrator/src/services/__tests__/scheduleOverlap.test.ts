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
const due = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../residentDueCheck.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../residentDueCheck.js')>()),
  residentOccurrenceDue: due,
}));
vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/redis')>()),
  getSessionState: (_redis: unknown, _tenantId: string, sessionId: string) =>
    Promise.resolve(sessions.get(sessionId) ?? null),
}));

const { ScheduleEvaluator } = await import('../ScheduleEvaluator.js');
const { claimResidentWake, requestResidentWake, residentPendingKey, residentWakeKey } =
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

interface EvaluatorSeams {
  recordOccurrence(row: unknown): Promise<boolean>;
  dispatchOne(row: unknown): Promise<{ kind: string; disposition?: () => Promise<boolean> }>;
}

function evaluator(): EvaluatorSeams {
  return new ScheduleEvaluator({
    redis,
    sqlClient: sqlClient(),
    db: {} as never,
    mode: 'observe',
  }) as unknown as EvaluatorSeams;
}

async function occur(row: unknown = residentRow()): Promise<boolean> {
  return evaluator().recordOccurrence(row);
}

beforeEach(async () => {
  due.mockReset().mockResolvedValue(true);
  redis = new RedisMock() as unknown as RedisType;
  await redis.flushall();
  sessions.clear();
  statements = [];
  transactions = 0;
});

it('keeps idle heartbeats armed without spending the firing cap', async () => {
  due.mockResolvedValue(false);
  for (let tick = 0; tick < 96; tick++) expect(await occur()).toBe(false);
  expect(due).toHaveBeenCalledTimes(96);
  expect(transactions).toBe(0);
  expect(await redis.get(residentWakeKey(TENANT, SPACE))).toBeNull();
  expect(statements.every(({ query }) => !query.includes('RETURNING firing_count'))).toBe(true);
  due.mockResolvedValue(true);
  expect(await occur()).toBe(true);
});

describe('a resident heartbeat while the space’s previous wake is in flight (Plan 331 D1)', () => {
  it('starts no run and is recorded as skipped, moving to the next time without spending a firing', async () => {
    await claimResidentWake(redis, TENANT, SPACE, PREVIOUS_RUN);
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
    expect(await redis.get(residentWakeKey(TENANT, SPACE))).not.toBeNull();

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

  it('lets an event start immediately during an idle heartbeat board read', async () => {
    due.mockImplementationOnce(async () => {
      expect(await redis.get(residentWakeKey(TENANT, SPACE))).toBeNull();
      expect(await event()).toBe('started');
      return false;
    });
    expect(await occur()).toBe(false);
    expect(enqueued).toHaveLength(1);
    expect(fired()).toBe(0);
    expect(await redis.get(residentPendingKey(TENANT, SPACE))).toBeNull();
    expect(await redis.get(residentWakeKey(TENANT, SPACE))).not.toBeNull();
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
    expect(await redis.get(residentWakeKey(TENANT, SPACE))).toBeNull();
    expect(await event()).toBe('started');
  });
});

describe('the guard survives renewal, and holds only the resident (Plan 331 D1)', () => {
  const SUCCESSOR = 'c0000000-0000-4000-8000-000000000999';

  async function heldBy(): Promise<string> {
    const held = await redis.get(residentWakeKey(TENANT, SPACE));
    if (held === null) throw new Error('no wake holds the space');
    return held.slice(0, held.lastIndexOf('@'));
  }

  it('a wake that renews its schedule mid-run still holds the space: the successor’s heartbeat is skipped', async () => {
    sessions.set(PREVIOUS_RUN, { status: 'SUCCEEDED' });
    expect(await occur()).toBe(true);
    const renewing = await heldBy();
    sessions.set(renewing, { status: 'RUNNING' });

    statements = [];
    const successor = { ...residentRow(), id: SUCCESSOR, firing_count: 0, last_session_id: null };
    expect(await occur(successor)).toBe(false);
    expect(statements[0]!.query).toContain("'{overlap}'");
    expect(statements[0]!.params[1]).toBe(renewing);

    sessions.set(renewing, { status: 'SUCCEEDED' });
    expect(await occur(successor)).toBe(true);
  });

  it('another agent’s cron schedule, the shepherd’s, is never held back and takes no guard', async () => {
    const shepherd = {
      ...residentRow(),
      target_system_role: 'local-pr-shepherd',
      input_template: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
    };
    sessions.set(PREVIOUS_RUN, { status: 'RUNNING' });
    expect(await occur(shepherd)).toBe(true);
    expect(await occur(shepherd)).toBe(true);
    expect(await redis.get(residentWakeKey(TENANT, SPACE))).toBeNull();
  });

  it('a heartbeat whose dispatch is unworkable gives the guard back at once', async () => {
    sessions.set(PREVIOUS_RUN, { status: 'SUCCEEDED' });
    expect(await occur()).toBe(true);
    expect(await redis.get(residentWakeKey(TENANT, SPACE))).not.toBeNull();

    const result = await evaluator().dispatchOne({
      dispatch: {
        tenantId: TENANT,
        scheduleId: SCHEDULE,
        scheduleName: 'Resident',
        schemaName: residentRow().tenant_schema,
        spaceId: SPACE,
        action: 'start_run',
        targetKind: 'platform-role',
        targetSystemRole: 'cybernetic-helmsman',
        idempotencyKey: `schedule:${SCHEDULE}:8`,
        resolvedInput: {},
        firingCount: 8,
        creatorUserId: null,
      },
    });
    expect(result.kind).toBe('unworkable');
    expect(await result.disposition?.()).toBe(true);
    expect(await redis.get(residentWakeKey(TENANT, SPACE))).toBeNull();
  });
});
