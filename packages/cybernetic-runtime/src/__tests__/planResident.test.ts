/**
 * Plan 331 D1, D4 — the resident's wakes. A heartbeat that meets a wake in
 * flight is dropped; an event that meets one sets the space's pending mark,
 * and the wake in flight answers it with exactly one more wake when it ends,
 * which reads the board and so acts on every event the mark stood for. A
 * paused schedule is not found, so it wakes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { scheduleOccurrenceRunId, type ScheduleDispatchItem } from '@aflow/database';
import {
  isPlanResidentSchedule,
  PLAN_STREAM_SCHEDULE_TARGET,
  planResidentScheduleInput,
  planStreamScheduleInput,
  type SessionStatus,
} from '@aflow/schemas';

const sessions = vi.hoisted(() => new Map<string, { status: string }>());
vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/redis')>()),
  getSessionState: (_redis: unknown, _tenantId: string, sessionId: string) =>
    Promise.resolve(sessions.get(sessionId) ?? null),
}));

const {
  isScheduleRunInFlight,
  markScheduleRunStarting,
  requestResidentWake,
  residentPendingKey,
  residentWakeEnded,
} = await import('../plan/resident.js');
type ResidentSchedule = import('../plan/resident.js').ResidentSchedule;

const TENANT = 'a0000000-0000-4000-8000-000000000331';
const SPACE = '5e1d0000-0000-4000-8000-000000000331';
const SCHEDULE = '5c4ed000-0000-4000-8000-000000000331';
const CREATOR = '1eab6e64-861a-4b99-b396-74f35b111dbb';

let redis: RedisType;
let schedule: ResidentSchedule | null;
let enqueued: ScheduleDispatchItem[];

function resident(): ResidentSchedule {
  return {
    id: SCHEDULE,
    spaceId: SPACE,
    name: 'Resident',
    action: 'start_run',
    targetKind: PLAN_STREAM_SCHEDULE_TARGET.kind,
    targetSystemRole: PLAN_STREAM_SCHEDULE_TARGET.systemRole,
    targetAgentId: null,
    agentVersion: null,
    targetSessionId: null,
    targetStepExecutionId: null,
    inputTemplate: planResidentScheduleInput(),
    firingCount: 3,
    lastSessionId: null,
    creatorUserId: CREATOR,
    creatorTenantRole: 'admin',
    creatorSpaceRole: 'editor',
  };
}

function deps() {
  return {
    redis,
    schedules: {
      find: () => Promise.resolve(schedule),
      enqueue: (item: ScheduleDispatchItem) => {
        enqueued.push(item);
        return Promise.resolve();
      },
    },
  };
}

/** The drain dispatches the newest occurrence: its run starts and the schedule records it. */
function dispatched(status: SessionStatus = 'RUNNING'): string {
  const item = enqueued.at(-1);
  if (!item || !schedule) throw new Error('nothing enqueued');
  const runId = scheduleOccurrenceRunId(item.idempotencyKey);
  schedule = { ...schedule, lastSessionId: runId };
  sessions.set(runId, { status });
  return runId;
}

beforeEach(async () => {
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
  sessions.clear();
  schedule = resident();
  enqueued = [];
});

describe('the resident schedule (Plan 331 D1)', () => {
  it('is known by its wake message and the id it hands its wake; a stream’s schedule is not one', () => {
    expect(isPlanResidentSchedule(resident())).toBe(true);
    expect(
      isPlanResidentSchedule({
        ...resident(),
        inputTemplate: planStreamScheduleInput('00000000-0000-4000-8000-000000000001'),
      }),
    ).toBe(false);
    expect(planResidentScheduleInput()).toMatchObject({
      config: { scheduleId: { $schedule: 'id' } },
    });
    expect(planResidentScheduleInput().input).not.toMatch(/rootNodeId"\s*:/);
  });

  it('holds its next occurrence while its previous run is in flight, and frees it when it ends', async () => {
    const facts = { id: SCHEDULE, lastSessionId: 'run-1' };
    sessions.set('run-1', { status: 'RUNNING' });
    expect(await isScheduleRunInFlight(redis, TENANT, facts)).toBe(true);
    sessions.set('run-1', { status: 'SUCCEEDED' });
    expect(await isScheduleRunInFlight(redis, TENANT, facts)).toBe(false);
    // A paused wake has nobody to resume it, so it holds nothing back.
    sessions.set('run-1', { status: 'PAUSED' });
    expect(await isScheduleRunInFlight(redis, TENANT, facts)).toBe(false);
  });

  it('counts an occurrence recorded but not yet started as in flight', async () => {
    await markScheduleRunStarting(redis, TENANT, SCHEDULE, 'run-2');
    expect(
      await isScheduleRunInFlight(redis, TENANT, { id: SCHEDULE, lastSessionId: 'run-1' }),
    ).toBe(true);
  });
});

describe('informational wakes (Plan 331 D4)', () => {
  it('wakes the resident at once when no wake is in flight', async () => {
    expect(
      await requestResidentWake(deps(), {
        tenantId: TENANT,
        spaceId: SPACE,
        cause: 'node_written',
      }),
    ).toBe('started');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      scheduleId: SCHEDULE,
      action: 'start_run',
      targetSystemRole: 'cybernetic-helmsman',
      creatorUserId: CREATOR,
      resolvedInput: { config: { scheduleId: SCHEDULE } },
    });
  });

  it('three runs ending during one wake start exactly one following wake, which reads them all', async () => {
    await requestResidentWake(deps(), { tenantId: TENANT, spaceId: SPACE, cause: 'run_ended' });
    const inFlight = dispatched();

    for (let i = 0; i < 3; i++) {
      expect(
        await requestResidentWake(deps(), { tenantId: TENANT, spaceId: SPACE, cause: 'run_ended' }),
      ).toBe('pending');
    }
    expect(enqueued).toHaveLength(1);
    expect(await redis.get(residentPendingKey(TENANT, SPACE))).not.toBeNull();

    sessions.set(inFlight, { status: 'SUCCEEDED' });
    expect(
      await residentWakeEnded(deps(), { tenantId: TENANT, spaceId: SPACE, sessionId: inFlight }),
    ).toBe('started');
    expect(enqueued).toHaveLength(2);
    expect(await redis.get(residentPendingKey(TENANT, SPACE))).toBeNull();

    const following = dispatched();
    sessions.set(following, { status: 'SUCCEEDED' });
    expect(
      await residentWakeEnded(deps(), { tenantId: TENANT, spaceId: SPACE, sessionId: following }),
    ).toBe('idle');
    expect(enqueued).toHaveLength(2);
  });

  it('a wake that ends with nothing pending starts nothing, and another session’s end is not the resident’s', async () => {
    await requestResidentWake(deps(), { tenantId: TENANT, spaceId: SPACE, cause: 'run_ended' });
    const inFlight = dispatched('SUCCEEDED');
    expect(
      await residentWakeEnded(deps(), { tenantId: TENANT, spaceId: SPACE, sessionId: 'other' }),
    ).toBe('not_resident');
    expect(
      await residentWakeEnded(deps(), { tenantId: TENANT, spaceId: SPACE, sessionId: inFlight }),
    ).toBe('idle');
    expect(enqueued).toHaveLength(1);
  });

  it('an event that arrives while the wake is still starting waits for it, not beside it', async () => {
    await requestResidentWake(deps(), { tenantId: TENANT, spaceId: SPACE, cause: 'node_written' });
    expect(
      await requestResidentWake(deps(), {
        tenantId: TENANT,
        spaceId: SPACE,
        cause: 'node_written',
      }),
    ).toBe('pending');
    expect(enqueued).toHaveLength(1);
  });

  it('a paused resident wakes for nothing', async () => {
    schedule = null;
    expect(
      await requestResidentWake(deps(), { tenantId: TENANT, spaceId: SPACE, cause: 'run_ended' }),
    ).toBe('no_resident');
    expect(enqueued).toEqual([]);
  });
});
