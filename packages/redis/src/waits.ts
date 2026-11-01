/**
 * The store under the wait primitive (Plan 339 D1).
 *
 * A wait is a field in its subject's waiter hash, and a member of one window
 * set scored by when its window closes. An event records itself under its
 * subject and arms the subject in one fired set. Two candidate reads find all
 * the work there is: the fired subjects and the windows due. Neither grows with
 * tenants, spaces or stored keys while nothing is due.
 *
 * Exactly one party wakes a wait: whoever removes its field from the waiter
 * hash. Registration and recording are each one transaction, so a waiter that
 * asks to catch up on an event already recorded reads it in its own
 * transaction and claims itself, and one registered first is in the hash the
 * event's claimer reads.
 */
import type { ChainableCommander, Redis } from 'ioredis';
import {
  WAIT_EVENT_RETENTION_SECONDS,
  WAIT_WINDOW_MAX_SECONDS,
  WaitEventSchema,
  WaitRegistrationSchema,
  type WaitEvent,
  type WaitEventKind,
  type WaitOutcome,
  type WaitRegistration,
} from '@aflow/schemas';

/** Waits by when their window closes, across every space. */
export const WAIT_WINDOWS_KEY = 'waits:windows';

/** Subjects whose event fired and whose waiters have not been read since. */
export const WAIT_FIRED_SUBJECTS_KEY = 'waits:fired_subjects';

interface SubjectRef {
  tenantId: string;
  spaceId: string;
  kind: WaitEventKind;
  subject: string;
}

function subjectSuffix(ref: SubjectRef): string {
  return `${ref.tenantId}:${ref.spaceId}:${ref.kind}:${ref.subject}`;
}

export function WAIT_WAITERS_KEY(ref: SubjectRef): string {
  return `waits:waiters:${subjectSuffix(ref)}`;
}

export function WAIT_FIRED_KEY(ref: SubjectRef): string {
  return `waits:fired:${subjectSuffix(ref)}`;
}

function firedSubjectMember(ref: SubjectRef): string {
  return JSON.stringify([ref.tenantId, ref.spaceId, ref.kind, ref.subject]);
}

function parseFiredSubjectMember(member: string): SubjectRef | null {
  try {
    const parsed: unknown = JSON.parse(member);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [tenantId, spaceId, kind, subject] = parsed as unknown[];
    if (
      typeof tenantId !== 'string' ||
      typeof spaceId !== 'string' ||
      typeof kind !== 'string' ||
      typeof subject !== 'string'
    ) {
      return null;
    }
    return { tenantId, spaceId, kind: kind as WaitEventKind, subject };
  } catch {
    return null;
  }
}

/** A window member names its waiter hash and its wait, so closing it needs no other read. */
function windowMember(registration: WaitRegistration): string {
  return JSON.stringify([WAIT_WAITERS_KEY(registration), registration.waitId]);
}

function parseWindowMember(member: string): { waitersKey: string; waitId: string } | null {
  try {
    const parsed: unknown = JSON.parse(member);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [waitersKey, waitId] = parsed as unknown[];
    if (typeof waitersKey !== 'string' || typeof waitId !== 'string') return null;
    return { waitersKey, waitId };
  } catch {
    return null;
  }
}

function parseRegistration(raw: string | null | undefined): WaitRegistration | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = WaitRegistrationSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseEvent(raw: unknown): WaitEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = WaitEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Whether a recorded event ends this wait. The kinds fire many times for one
 * subject, so a wait declared without `since` waits for an event after its
 * declaration. Only an explicit `since` catches up on one recorded before.
 */
function eventEnds(registration: WaitRegistration, event: WaitEvent): boolean {
  return event.firedAt >= (registration.since ?? registration.declaredAt);
}

/**
 * Add the commands that record `event` to a transaction the caller already
 * issues, so the entity event's append carries it at no extra round trip.
 */
export function recordWaitEventInto(
  multi: ChainableCommander,
  ref: { tenantId: string; spaceId: string },
  event: WaitEvent,
): ChainableCommander {
  const subject = { ...ref, kind: event.kind, subject: event.subject };
  return multi
    .set(WAIT_FIRED_KEY(subject), JSON.stringify(event), 'EX', WAIT_EVENT_RETENTION_SECONDS)
    .zadd(WAIT_FIRED_SUBJECTS_KEY, String(event.firedAt), firedSubjectMember(subject));
}

/** Record `event` on its own, for a caller with no transaction to extend. */
export async function recordWaitEvent(
  redis: Redis,
  ref: { tenantId: string; spaceId: string },
  event: WaitEvent,
): Promise<void> {
  await recordWaitEventInto(redis.multi(), ref, event).exec();
}

/** The event recorded for a subject, if one fired within the retention. */
export async function readRecordedWaitEvent(
  redis: Redis,
  ref: SubjectRef,
): Promise<WaitEvent | null> {
  return parseEvent(await redis.get(WAIT_FIRED_KEY(ref)));
}

export type RegisterWaitResult =
  | { state: 'waiting' }
  /** The event it catches up on had fired already: the waiter is woken at once, by this call. */
  | { state: 'woken'; outcome: WaitOutcome };

/**
 * Register a wait. Where an event it catches up on was recorded already, the
 * wait ends here and the caller tells the waiter at once.
 */
export async function registerWait(
  redis: Redis,
  registration: WaitRegistration,
): Promise<RegisterWaitResult> {
  const waitersKey = WAIT_WAITERS_KEY(registration);
  const results = await redis
    .multi()
    .hset(waitersKey, registration.waitId, JSON.stringify(registration))
    // Every wait in the hash closes inside the longest window from now, and
    // the window set holds what closes it.
    .expire(waitersKey, WAIT_WINDOW_MAX_SECONDS + 3600)
    .zadd(WAIT_WINDOWS_KEY, String(registration.closesAt), windowMember(registration))
    .get(WAIT_FIRED_KEY(registration))
    .exec();
  const fired = parseEvent(results?.[3]?.[1]);
  if (fired === null || !eventEnds(registration, fired)) return { state: 'waiting' };
  const claimed = await claimWait(redis, waitersKey, registration);
  // Not claimed: the fired subject's reader took it between the two calls, and
  // delivers it as any other woken wait.
  return claimed
    ? { state: 'woken', outcome: { endedBy: 'event', event: fired } }
    : { state: 'waiting' };
}

/** Take a wait out of its hash and its window. True only for the one caller that removed it. */
async function claimWait(
  redis: Redis,
  waitersKey: string,
  registration: WaitRegistration,
): Promise<boolean> {
  const removed = await redis.hdel(waitersKey, registration.waitId);
  if (removed !== 1) return false;
  await redis.zrem(WAIT_WINDOWS_KEY, windowMember(registration));
  return true;
}

/** End a wait before anything wakes it. True where it was still waiting. */
export async function cancelWait(redis: Redis, registration: WaitRegistration): Promise<boolean> {
  return claimWait(redis, WAIT_WAITERS_KEY(registration), registration);
}

export interface EndedWait {
  registration: WaitRegistration;
  outcome: WaitOutcome;
}

/**
 * Claim the waits that events have ended: read each fired subject once, and
 * take every wait in its hash that the event ends. A wait whose `since` is
 * later than the event stays.
 */
export async function claimFiredWaits(redis: Redis, limit: number): Promise<EndedWait[]> {
  const members = await redis.zrangebyscore(
    WAIT_FIRED_SUBJECTS_KEY,
    '-inf',
    '+inf',
    'LIMIT',
    0,
    limit,
  );
  const ended: EndedWait[] = [];
  for (const member of members) {
    if ((await redis.zrem(WAIT_FIRED_SUBJECTS_KEY, member)) !== 1) continue;
    const ref = parseFiredSubjectMember(member);
    if (ref === null) continue;
    const waitersKey = WAIT_WAITERS_KEY(ref);
    const [event, waiters] = await Promise.all([
      readRecordedWaitEvent(redis, ref),
      redis.hgetall(waitersKey),
    ]);
    if (event === null) continue;
    for (const raw of Object.values(waiters)) {
      const registration = parseRegistration(raw);
      if (registration === null || !eventEnds(registration, event)) continue;
      if (await claimWait(redis, waitersKey, registration)) {
        ended.push({ registration, outcome: { endedBy: 'event', event } });
      }
    }
  }
  return ended;
}

/** Claim the waits whose window closed by `nowMs` with no event. */
export async function claimClosedWindows(
  redis: Redis,
  nowMs: number,
  limit: number,
): Promise<EndedWait[]> {
  const members = await redis.zrangebyscore(
    WAIT_WINDOWS_KEY,
    '-inf',
    String(nowMs),
    'LIMIT',
    0,
    limit,
  );
  const ended: EndedWait[] = [];
  for (const member of members) {
    const parsed = parseWindowMember(member);
    if (parsed === null) {
      await redis.zrem(WAIT_WINDOWS_KEY, member);
      continue;
    }
    const registration = parseRegistration(await redis.hget(parsed.waitersKey, parsed.waitId));
    if (registration === null) {
      // Woken or cancelled already; its window member is all that is left.
      await redis.zrem(WAIT_WINDOWS_KEY, member);
      continue;
    }
    if (await claimWait(redis, parsed.waitersKey, registration)) {
      ended.push({ registration, outcome: { endedBy: 'window_closed', closedAt: nowMs } });
    }
  }
  return ended;
}

/**
 * Put back a wait whose delivery failed, so the next cycle delivers it again:
 * an event's wait is re-armed on its subject, a closed window falls due at once.
 */
export async function rearmEndedWait(redis: Redis, ended: EndedWait): Promise<void> {
  const { registration, outcome } = ended;
  const multi = redis
    .multi()
    .hset(WAIT_WAITERS_KEY(registration), registration.waitId, JSON.stringify(registration))
    .expire(WAIT_WAITERS_KEY(registration), WAIT_WINDOW_MAX_SECONDS + 3600);
  if (outcome.endedBy === 'event') {
    multi
      .zadd(WAIT_WINDOWS_KEY, String(registration.closesAt), windowMember(registration))
      .zadd(
        WAIT_FIRED_SUBJECTS_KEY,
        String(outcome.event.firedAt),
        firedSubjectMember(registration),
      );
  } else {
    multi.zadd(WAIT_WINDOWS_KEY, String(outcome.closedAt), windowMember(registration));
  }
  await multi.exec();
}
