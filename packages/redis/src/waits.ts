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

/** How many events a subject has recorded: the number each recorded event and each registration reads. */
export function WAIT_EVENT_SEQ_KEY(ref: SubjectRef): string {
  return `waits:seq:${subjectSuffix(ref)}`;
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
 * An event as its subject keeps it: `seq` is its place in the order its
 * subject's events were recorded, which the clock of whoever fired it cannot
 * reorder.
 */
interface RecordedEvent {
  seq: number;
  event: WaitEvent;
}

/**
 * The outcome the recorded events give a wait: the first that ends it, and
 * every one after it. Null where none ends it. `events` is in recorded order.
 *
 * An event ends a wait where it fired at or after the time the wait counts
 * from, or where it was recorded after the wait registered. The second holds
 * whatever its `firedAt` says: a waiter registered first is woken by the event,
 * even one stamped by a clock behind the waiter's.
 */
function eventOutcome(
  registration: WaitRegistration,
  registeredAtSeq: number,
  events: RecordedEvent[],
): WaitOutcome | null {
  const ending = events
    .filter(({ seq, event }) => seq > registeredAtSeq || event.firedAt >= waitsFrom(registration))
    .map(({ event }) => event);
  const [first, ...later] = ending;
  if (first === undefined) return null;
  return { endedBy: 'event', event: first, ...(later.length > 0 ? { laterEvents: later } : {}) };
}

/** A recorded member is its sequence number, a space, then the event. */
function parseRecordedEvents(raw: unknown): RecordedEvent[] {
  if (!Array.isArray(raw)) return [];
  const recorded: RecordedEvent[] = [];
  for (const member of raw) {
    if (typeof member !== 'string') continue;
    const space = member.indexOf(' ');
    if (space <= 0) continue;
    const seq = Number(member.slice(0, space));
    const event = parseEvent(member.slice(space + 1));
    if (Number.isInteger(seq) && event !== null) recorded.push({ seq, event });
  }
  return recorded.sort((a, b) => a.seq - b.seq);
}

/** The hash field beside a wait that holds how many events its subject had recorded when it registered. */
function registeredAtSeqField(waitId: string): string {
  return `seq:${waitId}`;
}

/** A waiter hash's waits, each with the sequence number its subject stood at when it registered. */
function waitsOf(
  waiters: Record<string, string>,
): Array<{ registration: WaitRegistration; registeredAtSeq: number }> {
  const waits: Array<{ registration: WaitRegistration; registeredAtSeq: number }> = [];
  for (const [field, raw] of Object.entries(waiters)) {
    if (field.startsWith('seq:')) continue;
    const registration = parseRegistration(raw);
    if (registration === null) continue;
    const seq = Number(waiters[registeredAtSeqField(registration.waitId)]);
    // A wait with no sequence of its own is read by its clock alone.
    waits.push({
      registration,
      registeredAtSeq: Number.isInteger(seq) ? seq : Number.POSITIVE_INFINITY,
    });
  }
  return waits;
}

/**
 * Keep the event among its subject's recent ones, numbered in the order its
 * subject's events are recorded, and arm the subject only where a waiter hash
 * exists for it. A waiter that registers after this script reads the recorded
 * events in its own registration, so a subject nobody waits on never enters
 * the fired set. The counter lives as long as the events: a waiter, whose hash
 * lapses within a day, never outlives the number it registered at.
 */
const RECORD_WAIT_EVENT_SCRIPT = `
local seq = redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[1], seq .. ' ' .. ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[4])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('ZADD', KEYS[3], ARGV[1], ARGV[6])
end
return seq
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
    numberOfKeys: 4,
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
    WAIT_EVENT_SEQ_KEY(subject),
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
  return parseRecordedEvents(await redis.zrange(WAIT_FIRED_KEY(ref), 0, -1)).at(-1)?.event ?? null;
}

/**
 * The waits one subject holds now, each as it was registered. One hash read,
 * addressed by the subject: what holds a subject is never found by a scan.
 */
export async function readSubjectWaits(redis: Redis, ref: SubjectRef): Promise<WaitRegistration[]> {
  const waiters = await redis.hgetall(WAIT_WAITERS_KEY(ref));
  return waitsOf(waiters).map(({ registration }) => registration);
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
  | { state: 'woken'; outcome: WaitOutcome }
  /**
   * The event it catches up on had fired already, and the wait was claimed
   * into the delivery set, due at once: the next delivery cycle tells the
   * waiter, under the same lease and retry as any other ended wait.
   */
  | { state: 'queued'; outcome: WaitOutcome };

/**
 * Add the wait to its subject's hash with the number of events its subject
 * had recorded, to its window and to its conversation's mark, and return the
 * recorded events it may catch up on, all in one script. An event recorded
 * after this script carries a higher number, so it ends the wait whatever its
 * clock says.
 */
const REGISTER_WAIT_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[1], ARGV[8], redis.call('GET', KEYS[4]) or '0')
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('SET', KEYS[5], '1', 'EX', ARGV[7])
return redis.call('ZRANGEBYSCORE', KEYS[3], ARGV[6], '+inf')
`;

/**
 * Register a wait. Where an event it catches up on was recorded already, the
 * wait ends here and the caller tells the waiter at once. With
 * `queueCatchUp`, such a wait is claimed into the delivery set in the same
 * script instead, so no caller holds an ended wait that a throw could lose.
 */
export async function registerWait(
  redis: Redis,
  registration: WaitRegistration,
  options: { queueCatchUp?: boolean } = {},
): Promise<RegisterWaitResult> {
  const waitersKey = WAIT_WAITERS_KEY(registration);
  const caughtUp = await redis.eval(
    REGISTER_WAIT_SCRIPT,
    5,
    waitersKey,
    WAIT_WINDOWS_KEY,
    WAIT_FIRED_KEY(registration),
    WAIT_EVENT_SEQ_KEY(registration),
    WAIT_SESSION_MARK_KEY(registration.tenantId, registration.sessionId),
    registration.waitId,
    JSON.stringify(registration),
    // Every wait in the hash closes inside the longest window from now, and
    // the window set holds what closes it.
    String(WAIT_WINDOW_MAX_SECONDS + 3600),
    String(registration.closesAt),
    windowMember(registration),
    String(waitsFrom(registration)),
    String(WAIT_SESSION_MARK_TTL_SECONDS),
    registeredAtSeqField(registration.waitId),
  );
  // Every event recorded so far was recorded before this registration, so
  // only its clock can end the wait here.
  const outcome = eventOutcome(
    registration,
    Number.POSITIVE_INFINITY,
    parseRecordedEvents(caughtUp),
  );
  if (outcome === null) return { state: 'waiting' };
  if (options.queueCatchUp === true) {
    const queued = await claimWait(redis, WAIT_WAITERS_KEY(registration), registration, {
      ended: { registration, outcome },
      leaseUntilMs: 0,
    });
    return queued ? { state: 'queued', outcome } : { state: 'waiting' };
  }
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
redis.call('HDEL', KEYS[1], ARGV[5])
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
    registeredAtSeqField(registration.waitId),
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
 * Take a subject out of the fired set only where no event was recorded on it
 * since its reader read its events: such an event re-armed it, and its waits
 * are still to be read.
 */
const DISARM_SUBJECT_SCRIPT = `
if (redis.call('GET', KEYS[1]) or '0') == ARGV[1] then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return 1
end
return 0
`;

/**
 * Claim at most `limit` waits that events have ended: read each fired subject,
 * and take each wait in its hash that a recorded event ends, with every event
 * that ends it. A wait whose `since` is later than every event, and that no
 * event recorded after it ends, stays.
 *
 * A subject leaves the fired set only once every wait its events end is
 * claimed. A claim moves its wait into the delivery set in one script, so a
 * reader that dies between the claims and the removal leaves the subject
 * armed, and the next cycle claims what is left and removes it. A subject with
 * more waits than the limit stays armed with the rest for the next cycle.
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
    if (ended.length >= limit) break;
    const ref = parseFiredSubjectMember(member);
    if (ref === null) {
      await redis.zrem(WAIT_FIRED_SUBJECTS_KEY, member);
      continue;
    }
    const waitersKey = WAIT_WAITERS_KEY(ref);
    const read = await redis
      .multi()
      .zrange(WAIT_FIRED_KEY(ref), 0, -1)
      .hgetall(waitersKey)
      .get(WAIT_EVENT_SEQ_KEY(ref))
      .exec();
    const events = parseRecordedEvents(read?.[0]?.[1]);
    const waiters = (read?.[1]?.[1] ?? {}) as Record<string, string>;
    const seqValue: unknown = read?.[2]?.[1];
    const seqRead = typeof seqValue === 'string' ? seqValue : '0';
    let everyWaitClaimed = true;
    for (const { registration, registeredAtSeq } of waitsOf(waiters)) {
      const outcome = eventOutcome(registration, registeredAtSeq, events);
      if (outcome === null) continue;
      if (ended.length >= limit) {
        everyWaitClaimed = false;
        break;
      }
      const wait = { registration, outcome };
      if (await claimForDelivery(redis, waitersKey, wait, nowMs)) ended.push(wait);
    }
    if (everyWaitClaimed) {
      await redis.eval(
        DISARM_SUBJECT_SCRIPT,
        2,
        WAIT_EVENT_SEQ_KEY(ref),
        WAIT_FIRED_SUBJECTS_KEY,
        seqRead,
        member,
      );
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
