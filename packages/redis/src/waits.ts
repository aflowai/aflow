/**
 * The store under the wait primitive (Plan 339 D1).
 *
 * A wait is a field in its subject's waiter hash, and a member of one window
 * set scored by when its window closes. An event records itself among its
 * subject's recent events, and arms the subject in one fired set only where a
 * waiter hash exists for it. Three candidate reads find all the work there
 * is: the deliveries due, the fired subjects and the windows due. None grows
 * with tenants, spaces or stored keys while nothing is due.
 *
 * Exactly one party ends a wait: whoever removes its field from the waiter
 * hash. Registration and recording are each atomic, so a waiter that asks to
 * catch up on an event already recorded reads it in its own transaction and
 * claims itself, and one registered first is in the hash the event's claimer
 * reads. A claim for delivery moves the ended wait into the delivery set in
 * the same script, under a lease: a deliverer that dies before it settles the
 * wait leaves it there, and the next cycle delivers it once the lease lapses.
 */
import type { ChainableCommander, Redis } from 'ioredis';
import {
  WAIT_EVENTS_KEPT_PER_SUBJECT,
  WAIT_EVENT_RETENTION_SECONDS,
  WAIT_WINDOW_MAX_SECONDS,
  WaitEventSchema,
  WaitOutcomeSchema,
  WaitRegistrationSchema,
  type WaitEvent,
  type WaitEventKind,
  type WaitOutcome,
  type WaitRegistration,
} from '@aflow/schemas';

/** Waits by when their window closes, across every space. */
export const WAIT_WINDOWS_KEY = 'waits:windows';

/** Subjects whose event fired while a waiter held them, not read since. */
export const WAIT_FIRED_SUBJECTS_KEY = 'waits:fired_subjects';

/** Ended waits claimed for delivery and not settled, by wait id, scored by when each is due again. */
export const WAIT_DELIVERING_KEY = 'waits:delivering';

/** The ended wait each member of {@link WAIT_DELIVERING_KEY} delivers, by wait id. */
export const WAIT_DELIVERING_DATA_KEY = 'waits:delivering:data';

/**
 * How long a claimed delivery is held before another cycle may deliver it
 * again. Delivery is keyed by the wait, so a second delivery posts nothing twice.
 */
export const WAIT_DELIVERY_LEASE_MS = 2 * 60 * 1000;

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
 * The earliest time an event that ends this wait fired at. The kinds fire many
 * times for one subject, so a wait declared without `since` waits for an event after its
 * declaration. Only an explicit `since` catches up on one recorded before.
 */
function waitsFrom(registration: WaitRegistration): number {
  return registration.since ?? registration.declaredAt;
}

/**
 * The outcome the recorded events give a wait: the first that ends it, and
 * every one after it. Null where none ends it. `events` is oldest first.
 */
function eventOutcome(registration: WaitRegistration, events: WaitEvent[]): WaitOutcome | null {
  const ending = events.filter((event) => event.firedAt >= waitsFrom(registration));
  const [first, ...later] = ending;
  if (first === undefined) return null;
  return { endedBy: 'event', event: first, ...(later.length > 0 ? { laterEvents: later } : {}) };
}

function parseEvents(raw: unknown): WaitEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => parseEvent(entry))
    .filter((event): event is WaitEvent => event !== null)
    .sort((a, b) => a.firedAt - b.firedAt);
}

/**
 * Keep the event among its subject's recent ones, and arm the subject only
 * where a waiter hash exists for it. A waiter that registers after this
 * script reads the recorded events in its own registration, so a subject
 * nobody waits on never enters the fired set.
 */
const RECORD_WAIT_EVENT_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[4])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('ZADD', KEYS[3], ARGV[1], ARGV[6])
end
return 1
`;

const RECORD_WAIT_EVENT_COMMAND = 'aflowRecordWaitEvent';

type RecordingCommander = ChainableCommander & {
  [RECORD_WAIT_EVENT_COMMAND]?: (...args: string[]) => ChainableCommander;
};

/**
 * Register the script that records a wait event on this connection. Call it
 * before the transaction that records one is opened: a transaction carries
 * the scripts its connection had when it was opened.
 */
export function prepareWaitEventRecording(redis: Redis): void {
  if (
    typeof (redis as unknown as Record<string, unknown>)[RECORD_WAIT_EVENT_COMMAND] === 'function'
  ) {
    return;
  }
  redis.defineCommand(RECORD_WAIT_EVENT_COMMAND, {
    numberOfKeys: 3,
    lua: RECORD_WAIT_EVENT_SCRIPT,
  });
}

/**
 * Add the script that records `event` to a transaction the caller already
 * issues, so the entity event's append carries it at no extra round trip. The
 * transaction must come from a connection {@link prepareWaitEventRecording}
 * has prepared.
 */
export function recordWaitEventInto(
  multi: ChainableCommander,
  ref: { tenantId: string; spaceId: string },
  event: WaitEvent,
): ChainableCommander {
  const record = (multi as RecordingCommander)[RECORD_WAIT_EVENT_COMMAND];
  if (record === undefined) {
    throw new Error('A wait event is recorded on a connection prepareWaitEventRecording prepared');
  }
  const subject = { ...ref, kind: event.kind, subject: event.subject };
  return record.call(
    multi,
    WAIT_FIRED_KEY(subject),
    WAIT_WAITERS_KEY(subject),
    WAIT_FIRED_SUBJECTS_KEY,
    String(event.firedAt),
    JSON.stringify(event),
    String(WAIT_EVENT_RETENTION_SECONDS),
    String(event.firedAt - WAIT_EVENT_RETENTION_SECONDS * 1000),
    String(-(WAIT_EVENTS_KEPT_PER_SUBJECT + 1)),
    firedSubjectMember(subject),
  );
}

/** Record `event` on its own, for a caller with no transaction to extend. */
export async function recordWaitEvent(
  redis: Redis,
  ref: { tenantId: string; spaceId: string },
  event: WaitEvent,
): Promise<void> {
  prepareWaitEventRecording(redis);
  await recordWaitEventInto(redis.multi(), ref, event).exec();
}

/** The latest event recorded for a subject, if one fired within the retention. */
export async function readRecordedWaitEvent(
  redis: Redis,
  ref: SubjectRef,
): Promise<WaitEvent | null> {
  return parseEvents(await redis.zrange(WAIT_FIRED_KEY(ref), -1, -1))[0] ?? null;
}

/**
 * Marks a conversation that has declared a wait, so a turn that comes to rest
 * reads the room for an unread outcome only there. Every outcome is posted
 * inside the longest window from its declaration, plus the time its delivery
 * takes, and a delivery that posts one sets the mark again.
 */
export function WAIT_SESSION_MARK_KEY(tenantId: string, sessionId: string): string {
  return `waits:session:${tenantId}:${sessionId}`;
}

const WAIT_SESSION_MARK_TTL_SECONDS = WAIT_WINDOW_MAX_SECONDS + 3600;

/** Mark a conversation as one a wait outcome may reach. */
export async function markSessionDeclaredWait(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await redis.set(
    WAIT_SESSION_MARK_KEY(tenantId, sessionId),
    '1',
    'EX',
    WAIT_SESSION_MARK_TTL_SECONDS,
  );
}

/** Whether a conversation has declared a wait whose outcome may still reach it. */
export async function sessionHasDeclaredWait(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<boolean> {
  return (await redis.exists(WAIT_SESSION_MARK_KEY(tenantId, sessionId))) === 1;
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
    .zrangebyscore(WAIT_FIRED_KEY(registration), String(waitsFrom(registration)), '+inf')
    .set(
      WAIT_SESSION_MARK_KEY(registration.tenantId, registration.sessionId),
      '1',
      'EX',
      WAIT_SESSION_MARK_TTL_SECONDS,
    )
    .exec();
  const outcome = eventOutcome(registration, parseEvents(results?.[3]?.[1]));
  if (outcome === null) return { state: 'waiting' };
  const claimed = await claimWait(redis, WAIT_WAITERS_KEY(registration), registration);
  // Not claimed: the fired subject's reader took it between the two calls, and
  // delivers it as any other woken wait.
  return claimed ? { state: 'woken', outcome } : { state: 'waiting' };
}

export interface EndedWait {
  registration: WaitRegistration;
  outcome: WaitOutcome;
}

/**
 * Take a wait out of its hash and its window, and — given the wait it ended
 * as — into the delivery set under a lease, all in one script. Returns 1 only
 * for the one caller that removed it.
 */
const CLAIM_WAIT_SCRIPT = `
if redis.call('HDEL', KEYS[1], ARGV[1]) ~= 1 then return 0 end
redis.call('ZREM', KEYS[2], ARGV[2])
if ARGV[4] ~= '' then
  redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
  redis.call('HSET', KEYS[4], ARGV[1], ARGV[4])
end
return 1
`;

async function claimWait(
  redis: Redis,
  waitersKey: string,
  registration: WaitRegistration,
  delivery?: { ended: EndedWait; leaseUntilMs: number },
): Promise<boolean> {
  const claimed = await redis.eval(
    CLAIM_WAIT_SCRIPT,
    4,
    waitersKey,
    WAIT_WINDOWS_KEY,
    WAIT_DELIVERING_KEY,
    WAIT_DELIVERING_DATA_KEY,
    registration.waitId,
    windowMember(registration),
    String(delivery?.leaseUntilMs ?? 0),
    delivery ? JSON.stringify(delivery.ended) : '',
  );
  return claimed === 1;
}

/** End a wait before anything wakes it. True where it was still waiting. */
export async function cancelWait(redis: Redis, registration: WaitRegistration): Promise<boolean> {
  return claimWait(redis, WAIT_WAITERS_KEY(registration), registration);
}

/** Claim `registration` for delivery with `outcome`. True only for the one caller that removed it. */
async function claimForDelivery(
  redis: Redis,
  waitersKey: string,
  ended: EndedWait,
  nowMs: number,
): Promise<boolean> {
  return claimWait(redis, waitersKey, ended.registration, {
    ended,
    leaseUntilMs: nowMs + WAIT_DELIVERY_LEASE_MS,
  });
}

function parseEndedWait(raw: unknown): EndedWait | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as { registration?: unknown; outcome?: unknown };
    const registration = WaitRegistrationSchema.safeParse(value.registration);
    const outcome = WaitOutcomeSchema.safeParse(value.outcome);
    return registration.success && outcome.success
      ? { registration: registration.data, outcome: outcome.data }
      : null;
  } catch {
    return null;
  }
}

/**
 * Take the deliveries due by `nowMs` — put back by a deliverer, or held by
 * one whose lease lapsed — and lease each again. A member with no ended wait
 * beside it is dropped.
 */
const CLAIM_DUE_DELIVERIES_SCRIPT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
local taken = {}
for _, id in ipairs(ids) do
  local ended = redis.call('HGET', KEYS[2], id)
  if ended then
    redis.call('ZADD', KEYS[1], ARGV[2], id)
    table.insert(taken, ended)
  else
    redis.call('ZREM', KEYS[1], id)
  end
end
return taken
`;

/** Claim the ended waits whose delivery is due again by `nowMs`. */
export async function claimDueDeliveries(
  redis: Redis,
  nowMs: number,
  limit: number,
): Promise<EndedWait[]> {
  const taken = await redis.eval(
    CLAIM_DUE_DELIVERIES_SCRIPT,
    2,
    WAIT_DELIVERING_KEY,
    WAIT_DELIVERING_DATA_KEY,
    String(nowMs),
    String(nowMs + WAIT_DELIVERY_LEASE_MS),
    String(limit),
  );
  if (!Array.isArray(taken)) return [];
  return taken
    .map((raw: unknown) => parseEndedWait(raw))
    .filter((ended): ended is EndedWait => ended !== null);
}

/** Forget a delivered wait. Its delivery set entry is all that is left of it. */
export async function settleEndedWait(redis: Redis, waitId: string): Promise<void> {
  await redis
    .multi()
    .zrem(WAIT_DELIVERING_KEY, waitId)
    .hdel(WAIT_DELIVERING_DATA_KEY, waitId)
    .exec();
}

/**
 * Claim the waits that events have ended: read each fired subject once, and
 * take every wait in its hash that a recorded event ends, with every event
 * that ends it. A wait whose `since` is later than every event stays.
 */
export async function claimFiredWaits(
  redis: Redis,
  limit: number,
  nowMs: number = Date.now(),
): Promise<EndedWait[]> {
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
    const [recorded, waiters] = await Promise.all([
      redis.zrange(WAIT_FIRED_KEY(ref), 0, -1),
      redis.hgetall(waitersKey),
    ]);
    const events = parseEvents(recorded);
    if (events.length === 0) continue;
    for (const raw of Object.values(waiters)) {
      const registration = parseRegistration(raw);
      if (registration === null) continue;
      const outcome = eventOutcome(registration, events);
      if (outcome === null) continue;
      const wait = { registration, outcome };
      if (await claimForDelivery(redis, waitersKey, wait, nowMs)) ended.push(wait);
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
    const wait: EndedWait = {
      registration,
      outcome: { endedBy: 'window_closed', closedAt: nowMs },
    };
    if (await claimForDelivery(redis, parsed.waitersKey, wait, nowMs)) ended.push(wait);
  }
  return ended;
}

/**
 * Put back a wait whose delivery did not finish, due at once, so the next
 * cycle delivers it again with the outcome it was claimed with.
 */
export async function rearmEndedWait(redis: Redis, ended: EndedWait): Promise<void> {
  const { waitId } = ended.registration;
  await redis
    .multi()
    .hset(WAIT_DELIVERING_DATA_KEY, waitId, JSON.stringify(ended))
    .zadd(WAIT_DELIVERING_KEY, '0', waitId)
    .exec();
}
