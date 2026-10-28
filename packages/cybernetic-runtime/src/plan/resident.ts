/**
 * The space's resident (Plan 331 D1, D4): one schedule wakes the Helmsman on
 * a heartbeat, and the events that change what a wake would decide — a run a
 * wake started ending, a person writing a node — wake it too. A wake never
 * overlaps another: heartbeats and events take one atomic guard
 * (`claimResidentWake`, keyed by the space); a heartbeat that arrives while a wake is in flight is
 * recorded as skipped, and an event sets the space's pending mark instead,
 * which the wake in flight answers with one more wake when it ends. That wake reads the
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
import { and, desc, eq } from 'drizzle-orm';
import {
  agentSchedules,
  insertScheduleDispatch,
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
 * How long a wake counts as in flight before its run's state exists:
 * the drain and the control stream start it within seconds, and a start that
 * never lands gives the guard back when this lapses.
 */
export const RESIDENT_WAKE_STARTING_TTL_MS = 5 * 60_000;

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

/**
 * How long the guard's record outlives its wake. It is read against the
 * wake's own state, so it never holds an ended wake back; this only bounds
 * how long a wake whose end was never recorded leaves its record behind.
 */
export const RESIDENT_WAKE_GUARD_TTL_MS = 24 * 60 * 60_000;

/**
 * The space's wake guard. Keyed by the space, not the schedule: a wake renews
 * its own schedule mid-run, and the successor's id and empty last session
 * must not read as no wake in flight, nor the wake's end as another's.
 */
export function residentWakeKey(tenantId: string, spaceId: string): string {
  return `plan:resident:wake:${tenantId}:${spaceId}`;
}

export function residentPendingKey(tenantId: string, spaceId: string): string {
  return `plan:resident:pending:${tenantId}:${spaceId}`;
}

/** The guard's value: the wake's run id and when it was claimed. */
function guardValue(runId: string, claimedAt: number): string {
  return `${runId}@${String(claimedAt)}`;
}

function parseGuard(value: string): { runId: string; claimedAt: number } {
  const at = value.lastIndexOf('@');
  if (at < 0) return { runId: value, claimedAt: 0 };
  return { runId: value.slice(0, at), claimedAt: Number(value.slice(at + 1)) || 0 };
}

interface ResidentWakeGuard {
  /** The run the guard names, whether or not it is still in flight. */
  held: string | null;
  /** That run's id, where it has not ended. */
  inFlight: string | null;
}

async function readResidentWakeGuard(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<ResidentWakeGuard> {
  const held = await redis.get(residentWakeKey(tenantId, spaceId));
  if (held === null) return { held, inFlight: null };
  const { runId, claimedAt } = parseGuard(held);
  const state = await getSessionState(redis, tenantId, runId);
  const going = state
    ? IN_FLIGHT_STATUSES.has(state.status)
    : Date.now() - claimedAt < RESIDENT_WAKE_STARTING_TTL_MS;
  return { held, inFlight: going ? runId : null };
}

/**
 * The resident wake in flight in the space, if any (Plan 331 D1): one
 * recorded and not yet started, or one still going.
 */
export async function residentWakeInFlight(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<string | null> {
  return (await readResidentWakeGuard(redis, tenantId, spaceId)).inFlight;
}

// Takes the guard only if it still holds what the caller judged ended: empty,
// or the record of the wake that ended. Two claimers that read the same state
// race here, and exactly one wins.
const CLAIM_RESIDENT_WAKE_LUA = `
local current = redis.call('GET', KEYS[1])
if (current == false and ARGV[3] == '') or current == ARGV[3] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`;

const RELEASE_RESIDENT_WAKE_LUA = `
local current = redis.call('GET', KEYS[1])
if current ~= false and string.sub(current, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '@' then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** A claim's answer: taken, or refused with the wake in flight that holds it. */
export type ResidentWakeClaim = { taken: true } | { taken: false; inFlight: string | null };

/**
 * The one guard every start of a resident wake takes (Plan 331 D1, D4): a
 * heartbeat and an event-driven wake alike. Refused while the space's previous
 * wake is in flight, and otherwise taken atomically, so at most one wake of
 * the space is starting or going at a time — across the renewal of its
 * schedule too. A heartbeat refused the guard is recorded as skipped, and an
 * event refused it sets the space's pending mark.
 */
export async function claimResidentWake(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  runId: string,
): Promise<ResidentWakeClaim> {
  const { held, inFlight } = await readResidentWakeGuard(redis, tenantId, spaceId);
  if (inFlight !== null) return { taken: false, inFlight };
  const taken = await redis.eval(
    CLAIM_RESIDENT_WAKE_LUA,
    1,
    residentWakeKey(tenantId, spaceId),
    guardValue(runId, Date.now()),
    String(RESIDENT_WAKE_GUARD_TTL_MS),
    held ?? '',
  );
  return Number(taken) === 1 ? { taken: true } : { taken: false, inFlight: null };
}

/** Give the guard back where `runId` still holds it: its start was abandoned, or it ended. */
export async function releaseResidentWake(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  runId: string,
): Promise<void> {
  await redis.eval(RELEASE_RESIDENT_WAKE_LUA, 1, residentWakeKey(tenantId, spaceId), runId);
}

/** Whether `sessionId` is the wake the space's guard names. */
async function holdsResidentWake(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  sessionId: string,
): Promise<boolean> {
  const held = await redis.get(residentWakeKey(tenantId, spaceId));
  return held !== null && parseGuard(held).runId === sessionId;
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
      await insertScheduleDispatch(db, {
        idempotencyKey: item.idempotencyKey,
        tenantId: item.tenantId,
        scheduleId: item.scheduleId,
        dispatch: item,
      });
    },
  };
}

export type ResidentWakeOutcome = 'no_resident' | 'pending' | 'started';

/** A wake ended: whether it was the resident's, and what its end started. */
export type ResidentWakeEnd = ResidentWakeOutcome | 'not_resident' | 'idle';

type ResidentWithCreator = ResidentSchedule & { creatorUserId: string };

function hasCreator(schedule: ResidentSchedule): schedule is ResidentWithCreator {
  return schedule.creatorUserId !== null;
}

function newWake(schedule: ResidentSchedule): { idempotencyKey: string; runId: string } {
  const idempotencyKey = `schedule:${schedule.id}:wake:${randomUUID()}`;
  return { idempotencyKey, runId: scheduleOccurrenceRunId(idempotencyKey) };
}

/** Write one occurrence of the resident schedule to the dispatch outbox; the caller holds the guard. */
async function enqueueWake(
  deps: ResidentWakeDeps,
  tenantId: string,
  schedule: ResidentWithCreator,
  wake: { idempotencyKey: string; runId: string },
): Promise<ResidentWakeOutcome> {
  try {
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
      idempotencyKey: wake.idempotencyKey,
      creatorUserId: schedule.creatorUserId,
      creatorTenantRole: schedule.creatorTenantRole,
      creatorSpaceRole: schedule.creatorSpaceRole,
    };
    await deps.schedules.enqueue(dispatch);
    return 'started';
  } catch (err) {
    await releaseResidentWake(deps.redis, tenantId, schedule.spaceId, wake.runId);
    throw err;
  }
}

async function setPending(redis: Redis, tenantId: string, spaceId: string): Promise<void> {
  await redis.set(residentPendingKey(tenantId, spaceId), '1', 'PX', RESIDENT_PENDING_TTL_MS);
}

/**
 * An event the resident should act on (Plan 331 D4): wake it now, or — while
 * a wake is in flight, a heartbeat's or an event's — set the space's pending
 * mark for that wake to answer. Both take the one guard, `claimResidentWake`.
 * Never dropped: a wake that ended between the refusal and the mark finds no
 * one to answer it, so the guard is tried once more, and whoever wins it
 * takes the mark back and starts the wake that answers it.
 */
export async function requestResidentWake(
  deps: ResidentWakeDeps,
  params: { tenantId: string; spaceId: string; cause: ResidentWakeCause },
): Promise<ResidentWakeOutcome> {
  const { tenantId, spaceId } = params;
  const schedule = await deps.schedules.find(tenantId, spaceId);
  if (!schedule || !hasCreator(schedule)) return 'no_resident';
  const wake = newWake(schedule);
  if ((await claimResidentWake(deps.redis, tenantId, spaceId, wake.runId)).taken) {
    return enqueueWake(deps, tenantId, schedule, wake);
  }
  await setPending(deps.redis, tenantId, spaceId);
  const now = await deps.schedules.find(tenantId, spaceId);
  if (!now || !hasCreator(now)) return 'pending';
  const retry = newWake(now);
  if (!(await claimResidentWake(deps.redis, tenantId, spaceId, retry.runId)).taken)
    return 'pending';
  const mark = await deps.redis.getdel(residentPendingKey(tenantId, spaceId));
  if (mark === null) {
    await releaseResidentWake(deps.redis, tenantId, spaceId, retry.runId);
    return 'pending';
  }
  return enqueueWake(deps, tenantId, now, retry);
}

/**
 * A run ended: where it was the space's resident wake — the run its guard
 * names, whichever schedule now carries the resident — give the guard back
 * and answer the pending mark with one more wake. Called once per terminal run.
 */
export async function residentWakeEnded(
  deps: ResidentWakeDeps,
  params: { tenantId: string; spaceId: string; sessionId: string },
): Promise<ResidentWakeEnd> {
  const { tenantId, spaceId, sessionId } = params;
  if (!(await holdsResidentWake(deps.redis, tenantId, spaceId, sessionId))) return 'not_resident';
  await releaseResidentWake(deps.redis, tenantId, spaceId, sessionId);
  const mark = await deps.redis.getdel(residentPendingKey(tenantId, spaceId));
  if (mark === null) return 'idle';
  return requestResidentWake(deps, { tenantId, spaceId, cause: 'pending' });
}
