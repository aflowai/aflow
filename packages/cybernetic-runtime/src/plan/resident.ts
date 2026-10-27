/**
 * The space's resident (Plan 331 D1, D4): one schedule wakes the Helmsman on
 * a heartbeat, and the events that change what a wake would decide — a run a
 * wake started ending, a person writing a node — wake it too. A wake never
 * overlaps another: a heartbeat that arrives while one is in flight is
 * dropped, and an event sets the space's pending mark instead, which the wake
 * in flight answers with one more wake when it ends. That wake reads the
 * board, so it sees every event the mark stood for, and none is dropped.
 *
 * A wake is an occurrence of the resident schedule written to the dispatch
 * outbox, as a due time writes one, so it starts through the same drain and
 * the same claim; a paused schedule is not found here, so pausing it stops
 * heartbeats and events alike.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  agentSchedules,
  createTenantContext,
  scheduleOccurrenceRunId,
  withTenantSchema,
  type AgentScheduleRow,
  type ScheduleDispatchItem,
} from '@aflow/database';
import { getSessionState } from '@aflow/redis';
import {
  isPlanResidentSchedule,
  PLAN_STREAM_SCHEDULE_TARGET,
  resolveInputTemplate,
  type SessionStatus,
  type TenantId,
} from '@aflow/schemas';

/**
 * How long an occurrence counts as in flight before its run's state exists:
 * the drain and the control stream start it within seconds, and a start that
 * never lands gives the schedule back when this lapses.
 */
export const SCHEDULE_RUN_STARTING_TTL_MS = 5 * 60_000;

/**
 * How long the pending mark outlives the wake that should answer it. A wake
 * that never ends leaves it to the next heartbeat, which reads the board too.
 */
export const RESIDENT_PENDING_TTL_MS = 24 * 60 * 60_000;

/**
 * The statuses of a run that still holds its schedule. A paused wake has
 * nobody to resume it, so it does not hold the next one back.
 */
const IN_FLIGHT_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'QUEUED',
  'RUNNING',
  'WAITING_ON_CHILD',
  'CANCELLING',
]);

export function scheduleStartingKey(tenantId: string, scheduleId: string): string {
  return `schedule:starting:${tenantId}:${scheduleId}`;
}

export function residentPendingKey(tenantId: string, spaceId: string): string {
  return `plan:resident:pending:${tenantId}:${spaceId}`;
}

/** Record that an occurrence of the schedule is starting `runId`, before its state exists. */
export async function markScheduleRunStarting(
  redis: Redis,
  tenantId: string,
  scheduleId: string,
  runId: string,
): Promise<void> {
  await redis.set(
    scheduleStartingKey(tenantId, scheduleId),
    runId,
    'PX',
    SCHEDULE_RUN_STARTING_TTL_MS,
  );
}

/**
 * Whether the schedule's previous run has not ended (Plan 331 D1): an
 * occurrence recorded and not yet started, or its last run still going.
 */
export async function isScheduleRunInFlight(
  redis: Redis,
  tenantId: string,
  schedule: { id: string; lastSessionId: string | null },
): Promise<boolean> {
  const starting = await redis.get(scheduleStartingKey(tenantId, schedule.id));
  if (starting !== null && starting !== schedule.lastSessionId) return true;
  if (schedule.lastSessionId === null) return false;
  const state = await getSessionState(redis, tenantId, schedule.lastSessionId);
  if (!state) return starting === schedule.lastSessionId;
  return IN_FLIGHT_STATUSES.has(state.status);
}

/** The facts of the resident schedule a wake reads. */
export type ResidentSchedule = Pick<
  AgentScheduleRow,
  | 'id'
  | 'spaceId'
  | 'name'
  | 'action'
  | 'targetKind'
  | 'targetSystemRole'
  | 'targetAgentId'
  | 'agentVersion'
  | 'targetSessionId'
  | 'targetStepExecutionId'
  | 'inputTemplate'
  | 'firingCount'
  | 'lastSessionId'
  | 'creatorUserId'
  | 'creatorTenantRole'
  | 'creatorSpaceRole'
>;

/** Where the resident schedule is read and its occurrences written. */
export interface ResidentScheduleStore {
  /** The space's active resident schedule, if it has one. */
  find(tenantId: string, spaceId: string): Promise<ResidentSchedule | null>;
  /** Write one occurrence to the dispatch outbox, as a due time writes one. */
  enqueue(item: ScheduleDispatchItem): Promise<void>;
}

export interface ResidentWakeDeps {
  redis: Redis;
  schedules: ResidentScheduleStore;
}

/** Why a wake was asked for, beside the heartbeat. */
export type ResidentWakeCause = 'run_ended' | 'node_written' | 'pending';

export function createResidentScheduleStore(db: PostgresJsDatabase): ResidentScheduleStore {
  return {
    async find(tenantId, spaceId) {
      const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
        tx
          .select()
          .from(agentSchedules)
          .where(
            and(
              eq(agentSchedules.spaceId, spaceId),
              eq(agentSchedules.status, 'active'),
              eq(agentSchedules.action, 'start_run'),
              eq(agentSchedules.targetKind, PLAN_STREAM_SCHEDULE_TARGET.kind),
              eq(agentSchedules.targetSystemRole, PLAN_STREAM_SCHEDULE_TARGET.systemRole),
            ),
          )
          .orderBy(desc(agentSchedules.createdAt))
          .limit(20),
      );
      return rows.find((row) => isPlanResidentSchedule(row)) ?? null;
    },
    async enqueue(item) {
      await db.execute(
        sql`INSERT INTO public.schedule_dispatch_outbox (idempotency_key, tenant_id, schedule_id, dispatch)
            VALUES (${item.idempotencyKey}, ${item.tenantId}::uuid, ${item.scheduleId}::uuid, ${JSON.stringify(item)}::jsonb)
            ON CONFLICT (idempotency_key) DO NOTHING`,
      );
    },
  };
}

export type ResidentWakeOutcome = 'no_resident' | 'pending' | 'started';

/** A wake ended: whether it was the resident's, and what its end started. */
export type ResidentWakeEnd = ResidentWakeOutcome | 'not_resident' | 'idle';

/** Write one occurrence of the resident schedule to the dispatch outbox. */
async function startWake(
  deps: ResidentWakeDeps,
  tenantId: string,
  schedule: ResidentSchedule,
): Promise<ResidentWakeOutcome> {
  if (schedule.creatorUserId === null) return 'no_resident';
  const idempotencyKey = `schedule:${schedule.id}:wake:${randomUUID()}`;
  const runId = scheduleOccurrenceRunId(idempotencyKey);
  const taken = await deps.redis.set(
    scheduleStartingKey(tenantId, schedule.id),
    runId,
    'PX',
    SCHEDULE_RUN_STARTING_TTL_MS,
    'NX',
  );
  if (taken !== 'OK') {
    await setPending(deps.redis, tenantId, schedule.spaceId);
    return 'pending';
  }
  const resolvedInput = await resolveInputTemplate(
    (schedule.inputTemplate ?? {}) as Record<string, unknown>,
    { schedule: { id: schedule.id }, now: new Date() },
  );
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const dispatch: ScheduleDispatchItem = {
    tenantId,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    schemaName: tenantCtx.schemaName,
    spaceId: schedule.spaceId,
    action: schedule.action,
    targetKind: schedule.targetKind,
    targetSystemRole: schedule.targetSystemRole,
    targetAgentId: schedule.targetAgentId,
    agentVersion: schedule.agentVersion,
    targetSessionId: schedule.targetSessionId,
    targetStepExecutionId: schedule.targetStepExecutionId,
    resolvedInput,
    firingCount: schedule.firingCount,
    idempotencyKey,
    creatorUserId: schedule.creatorUserId,
    creatorTenantRole: schedule.creatorTenantRole,
    creatorSpaceRole: schedule.creatorSpaceRole,
  };
  await deps.schedules.enqueue(dispatch);
  return 'started';
}

async function setPending(redis: Redis, tenantId: string, spaceId: string): Promise<void> {
  await redis.set(residentPendingKey(tenantId, spaceId), '1', 'PX', RESIDENT_PENDING_TTL_MS);
}

/**
 * An event the resident should act on (Plan 331 D4): wake it now, or — while
 * a wake is in flight — set the space's pending mark for that wake to answer.
 * Never dropped: a wake that ended between the read and the mark finds no
 * one to answer it, so the mark is taken back and a wake started here.
 */
export async function requestResidentWake(
  deps: ResidentWakeDeps,
  params: { tenantId: string; spaceId: string; cause: ResidentWakeCause },
): Promise<ResidentWakeOutcome> {
  const { tenantId, spaceId } = params;
  const schedule = await deps.schedules.find(tenantId, spaceId);
  if (!schedule) return 'no_resident';
  if (!(await isScheduleRunInFlight(deps.redis, tenantId, schedule))) {
    return startWake(deps, tenantId, schedule);
  }
  await setPending(deps.redis, tenantId, spaceId);
  const now = await deps.schedules.find(tenantId, spaceId);
  if (!now || (await isScheduleRunInFlight(deps.redis, tenantId, now))) return 'pending';
  const mark = await deps.redis.getdel(residentPendingKey(tenantId, spaceId));
  return mark === null ? 'pending' : startWake(deps, tenantId, now);
}

/**
 * A run ended: where it was the resident's wake, give the schedule back and
 * answer the pending mark with one more wake. Called once per terminal run.
 */
export async function residentWakeEnded(
  deps: ResidentWakeDeps,
  params: { tenantId: string; spaceId: string; sessionId: string },
): Promise<ResidentWakeEnd> {
  const { tenantId, spaceId, sessionId } = params;
  const schedule = await deps.schedules.find(tenantId, spaceId);
  if (schedule?.lastSessionId !== sessionId) return 'not_resident';
  const startingKey = scheduleStartingKey(tenantId, schedule.id);
  if ((await deps.redis.get(startingKey)) === sessionId) await deps.redis.del(startingKey);
  const mark = await deps.redis.getdel(residentPendingKey(tenantId, spaceId));
  if (mark === null) return 'idle';
  return requestResidentWake(deps, { tenantId, spaceId, cause: 'pending' });
}
