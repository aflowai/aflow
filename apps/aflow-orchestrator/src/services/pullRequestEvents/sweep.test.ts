/**
 * Plan 339 D4 and D5: the shepherd's schedule is a fallback sweep. A firing
 * starts the Local PR Shepherd only where an open loop pull request is
 * unattended — no owner holds it, and no waiter's window closes before the
 * next sweep. With none open it reads one empty range, starts nothing and
 * spends none of the schedule's firing cap.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type postgres from 'postgres';
import { armPullRequestWatch, clearPullRequestWatch } from '@aflow/redis';
import { declareWait } from '@aflow/cybernetic-runtime';
import {
  SHEPHERD_SCHEDULE_CRON_DEFAULT,
  SHEPHERD_SLUG,
  SHEPHERD_SWEEP_INTERVAL_MS,
} from '@aflow/schemas';
import { ScheduleEvaluator } from '../ScheduleEvaluator.js';
import { shepherdSweepDue, shepherdSweepWanted } from './sweep.js';

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = 'b0000000-0000-4000-8000-000000000339';
const OTHER_SPACE = 'b0000000-0000-4000-8000-000000000340';
const SCHEDULE = 'c0000000-0000-4000-8000-000000000339';
const AGENT = 'd0000000-0000-4000-8000-000000000339';
const WAITER = 'e0000000-0000-4000-8000-000000000339';
const T0 = 1_800_000_000_000;
const SPACE_REF = { tenantId: TENANT, spaceId: SPACE };

let redis: Redis;
let statements: Array<{ query: string; params: unknown[] }>;
let transactions: number;
let agentSlug: string;

function sqlClient(): postgres.Sql {
  const unsafe = (query: string, params: unknown[] = []) => {
    statements.push({ query, params });
    if (query.includes('.agents WHERE id')) return Promise.resolve([{ slug: agentSlug }]);
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

function shepherdRow() {
  return {
    id: SCHEDULE,
    tenant_schema: 't_a0000000000040008000000000000339',
    tenant_id: TENANT,
    space_id: SPACE,
    name: 'Local PR Shepherd',
    action: 'start_run',
    target_kind: 'custom-agent',
    target_system_role: null,
    target_agent_id: AGENT,
    agent_version: null,
    target_session_id: null,
    target_step_execution_id: null,
    kind: 'cron',
    cron_expression: SHEPHERD_SCHEDULE_CRON_DEFAULT,
    timezone: 'UTC',
    scheduled_at: null,
    next_fire_at_text: '2026-11-01 10:00:00+00',
    source_kind: null,
    source_system_role: null,
    source_agent_id: null,
    source_status: null,
    input_template: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
    status: 'active',
    max_firings: 50,
    firing_count: 7,
    last_session_id: null,
    expires_at: null,
    creator_user_id: '1eab6e64-861a-4b99-b396-74f35b111dbb',
    creator_tenant_role: 'admin',
    creator_space_role: 'editor',
  };
}

async function open(number: number, spaceId = SPACE, ownerSessionId?: string): Promise<string> {
  const subject = `aflowai/aflow#${String(number)}`;
  await armPullRequestWatch(redis, {
    tenantId: TENANT,
    spaceId,
    owner: 'aflowai',
    repo: 'aflow',
    number,
    subject,
    url: `https://github.com/aflowai/aflow/pull/${String(number)}`,
    armedAt: T0,
    ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
  });
  return subject;
}

async function waitOn(subject: string, windowSeconds: number, owner = false) {
  await declareWait(
    redis,
    {
      tenantId: TENANT,
      spaceId: SPACE,
      sessionId: WAITER,
      kind: 'pull_request.changed',
      subject,
      windowSeconds,
      ...(owner ? { owner: { onEvent: 'Run a pass aimed at it.' } } : {}),
    },
    T0,
  );
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  statements = [];
  transactions = 0;
  agentSlug = SHEPHERD_SLUG;
});

describe('the due check ahead of a shepherd sweep', () => {
  it('is not due while no loop pull request is open in the space, whatever another space has open', async () => {
    await open(1, OTHER_SPACE);
    expect(await shepherdSweepDue(redis, SPACE_REF, T0)).toEqual({
      due: false,
      open: 0,
      unattended: 0,
    });
  });

  it('is due for an open pull request nobody holds, and not once it has merged', async () => {
    const subject = await open(7);
    expect(await shepherdSweepDue(redis, SPACE_REF, T0)).toEqual({
      due: true,
      open: 1,
      unattended: 1,
    });
    await clearPullRequestWatch(redis, { ...SPACE_REF, subject });
    expect((await shepherdSweepDue(redis, SPACE_REF, T0)).due).toBe(false);
  });

  it('passes over a pull request its owner holds', async () => {
    const subject = await open(7, SPACE, WAITER);
    await waitOn(subject, 24 * 60 * 60, true);
    expect(await shepherdSweepDue(redis, SPACE_REF, T0)).toEqual({
      due: false,
      open: 1,
      unattended: 0,
    });
  });

  it('passes over a pull request whose waiter is woken before the next sweep, and not one whose waiter sleeps past it (D5)', async () => {
    const soon = await open(7);
    const late = await open(8);
    await waitOn(soon, SHEPHERD_SWEEP_INTERVAL_MS / 1000 / 4);
    await waitOn(late, (SHEPHERD_SWEEP_INTERVAL_MS / 1000) * 3);
    expect(await shepherdSweepDue(redis, SPACE_REF, T0)).toEqual({
      due: true,
      open: 2,
      unattended: 1,
    });
    await waitOn(late, SHEPHERD_SWEEP_INTERVAL_MS / 1000 / 2);
    expect((await shepherdSweepDue(redis, SPACE_REF, T0)).due).toBe(false);
  });
});

describe('the gate on a schedule firing', () => {
  it('lets every firing of another agent, or of no agent, start without reading anything', async () => {
    agentSlug = 'daily-report';
    expect(await shepherdSweepWanted(sqlClient(), redis, shepherdRow(), T0)).toBe(true);
    statements = [];
    const resident = { ...shepherdRow(), target_kind: 'platform-role', target_agent_id: null };
    expect(await shepherdSweepWanted(sqlClient(), redis, resident, T0)).toBe(true);
    expect(statements).toEqual([]);
  });

  it('records a day of idle hourly sweeps as skipped: no run starts and the firing cap is not spent', async () => {
    const evaluator = new ScheduleEvaluator({
      redis,
      sqlClient: sqlClient(),
      db: {} as never,
      mode: 'observe',
    }) as unknown as { recordOccurrence(row: unknown): Promise<boolean> };

    for (let firing = 0; firing < 24; firing++) {
      expect(await evaluator.recordOccurrence(shepherdRow())).toBe(false);
    }
    expect(transactions).toBe(0);
    expect(statements.some(({ query }) => query.includes('RETURNING firing_count'))).toBe(false);
    expect(statements.filter(({ query }) => query.includes("'skipped'"))).toHaveLength(24);

    await open(7);
    expect(await evaluator.recordOccurrence(shepherdRow())).toBe(true);
    expect(transactions).toBe(1);
  });
});
