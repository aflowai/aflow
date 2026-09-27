import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { compareStreamIds } from '../streams/streamId.js';
import type { SessionEvent } from './schemas.js';
import { HOT_STATE_TTL_SECONDS, SessionEventSchema } from './schemas.js';
import { serializeForStream, deserializeFromHash } from './serialization.js';
import { markProjectionCandidate } from './projectionCandidates.js';
import { sessionCandidateMember } from './candidateMember.js';
// ============================================================================
// Pub/Sub Notification (best-effort wakeup for SSE)
// ============================================================================

/** The wake payload, shared by the atomic append path and the standalone one. */
export function sessionWakePayload(runId: string, eventType: string): string {
  return JSON.stringify({ type: 'event', runId, eventType, ts: Date.now() });
}

// ============================================================================
// Run Event Stream Operations
// ============================================================================

/**
 * Append an event to the run's event stream, and wake its subscribers.
 *
 * The append, the TTL extension, the projection arming and the wake travel as
 * one transaction. A `PUBLISH` issued separately can be lost on its own —
 * leaving a durable event that no connected subscriber is ever told about, and
 * recoverable only by a periodic re-read. A pipeline would not fix that: it
 * batches round trips but still lets a connection drop between the `XADD` and
 * the `PUBLISH`. `MULTI` is what makes the wake as durable as the event.
 */
export async function appendSessionEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  event: SessionEvent,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<string> {
  const streamKey = StreamKeys.sessionEventsStream(tenantId, runId);
  const fields = serializeForStream(event);

  const pipeline = redis.multi();
  // XADD with MAXLEN to cap stream size (keep last 1000 events)
  pipeline.xadd(streamKey, 'MAXLEN', '~', '1000', '*', ...fields);
  pipeline.expire(streamKey, ttlSeconds);
  // An event with no accompanying state mutation must still arm projection:
  // the durable-event flush discovers work only through the candidate index,
  // and a session receiving pure event fan-out can push its stream past the
  // cap with no other writer arming it — evicting events nothing ever flushed.
  markProjectionCandidate(pipeline, sessionCandidateMember(tenantId, runId));
  pipeline.publish(
    StreamKeys.pubsubChannel(tenantId, runId),
    sessionWakePayload(runId, event.eventType),
  );
  const results = await pipeline.exec();

  const [xaddError, messageId] = results?.[0] ?? [null, null];
  if (xaddError) throw xaddError;
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('Failed to append run event to stream');
  }
  // The event landed; a failed arming after it is a real gap the flush cannot
  // see on its own. A pipeline gives no conditionality between its commands
  // and Redis has no rollback, so the repair is a detached retry on a fresh
  // round trip — off the hot path, and it only fires on a failure that
  // requires a server-side command error in the first place. Not rethrown —
  // the append succeeded and the caller's write is done.
  for (const [err] of results?.slice(1) ?? []) {
    if (err) {
      console.error(`appendSessionEvent: arming failed after append for run ${runId}:`, err);
      const repair = redis.pipeline();
      markProjectionCandidate(repair, sessionCandidateMember(tenantId, runId));
      // Command errors resolve inside the reply tuples — a rejected promise is
      // only the connection failing — so the repair's outcome has to be read
      // from every tuple or a repeated WRONGTYPE would pass as repaired.
      repair
        .exec()
        .then((repairResults) => {
          const failed = repairResults?.find(([repairErr]) => repairErr != null);
          if (repairResults == null || failed) {
            console.error(
              `appendSessionEvent: candidate re-arm failed for run ${runId}:`,
              failed?.[0] ?? new Error('re-arm pipeline returned no results'),
            );
          }
        })
        .catch((repairErr: unknown) => {
          console.error(`appendSessionEvent: candidate re-arm failed for run ${runId}:`, repairErr);
        });
      break;
    }
  }

  return messageId;
}

const SESSION_EVENT_UNKNOWN_TYPE_SEEN = new Set<string>();

function extractUnknownEventType(error: unknown): string | null {
  // Zod 3 enum mismatch shape: { issues: [{ code: 'invalid_enum_value',
  //   path: ['eventType'], received: 'X', options: [...] }] }
  if (
    error !== null &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    const issues = (error as { issues: Array<Record<string, unknown>> }).issues;
    for (const issue of issues) {
      if (
        issue['code'] === 'invalid_enum_value' &&
        Array.isArray(issue['path']) &&
        issue['path'][0] === 'eventType' &&
        typeof issue['received'] === 'string'
      ) {
        return issue['received'];
      }
    }
  }
  return null;
}

export interface SessionEventEntry {
  /** The Redis stream id this event was read at. */
  id: string;
  event: SessionEvent;
}

export interface ReadSessionEventEntriesResult {
  entries: SessionEventEntry[];
  /**
   * Entries the range actually returned, before unparseable ones were dropped.
   *
   * `entries.length` under-reports what was read, so a caller asking for
   * `limit + 1` to detect "more follow" would conclude there are none exactly
   * when a dropped entry sat in the window — and with nothing polling behind
   * it, the drain would stop there and stay stopped.
   */
  scanned: number;
  /** Stream id of the last entry inspected, or `cursor` when none followed it. */
  lastId: string;
  /**
   * Oldest id the stream still retains, or `null` when it holds nothing.
   *
   * Lets a caller answer "has my cursor been trimmed away?" without scanning:
   * a cursor older than this is gone, and no amount of reading forward from it
   * will find what came between.
   */
  oldestId: string | null;
}

/**
 * Events after `cursor`, each with the stream id it was read at.
 *
 * `cursor` is a **Redis stream id**, not an event id — the range is served by
 * `XRANGE`, so a caller holding some other kind of identifier has to resolve it
 * to a position first.
 *
 * Unparseable entries are skipped rather than fatal: an event type this process
 * does not know is almost always one a newer deploy emitted into a shared Redis,
 * and a live reader that threw on it would stall every open session for the
 * length of a rollout. The durability flush makes the opposite trade — see
 * {@link readDurableEventEntries}, which returns those entries instead of
 * dropping them, because advancing a durable cursor past one loses it forever.
 */
export async function readSessionEventEntries(
  redis: Redis,
  tenantId: string,
  runId: string,
  cursor = '0',
  count = 100,
): Promise<ReadSessionEventEntriesResult> {
  const streamKey = StreamKeys.sessionEventsStream(tenantId, runId);

  // Exclusive start (Redis 6.2+). An inclusive range that skipped the cursor
  // afterwards would spend one of `count` on an entry the caller already has,
  // so a caller reading `limit + 1` to detect "more follow" would conclude
  // there are none exactly when the cursor is still retained.
  const from = cursor === '0' ? '-' : `(${cursor}`;

  // Range first, head second — not in parallel. Both would travel on one
  // connection in array order, so a concurrent `XADD … MAXLEN` could trim
  // between them and leave `oldestId` describing the pre-trim stream while the
  // range describes the post-trim one: the caller would read "cursor still
  // retained" and treat a gap as contiguous. Read afterwards, `oldestId` can
  // only be too new, which forces the durable fallback — the safe direction.
  const result = await redis.xrange(streamKey, from, '+', 'COUNT', count);
  const head = await redis.xrange(streamKey, '-', '+', 'COUNT', 1);
  const oldestId = head[0]?.[0] ?? null;

  const { entries, lastId } = parseStreamRows(result, cursor);

  return { entries, scanned: result.length, lastId, oldestId };
}

/**
 * Parse raw stream rows, dropping entries this process cannot read.
 *
 * Shared by the forward and reverse readers so the forward-compat rule — an
 * unknown event type is a newer deploy on a shared Redis, not a reason to stall
 * every open session — cannot drift between the two directions.
 *
 * `lastId` is the id of the last row inspected, parsed or not, so a caller can
 * advance past a page it understood none of.
 */
function parseStreamRows(
  rows: Array<[string, string[]]>,
  fallbackId: string,
): { entries: SessionEventEntry[]; lastId: string } {
  const entries: SessionEventEntry[] = [];
  let lastId = fallbackId;

  for (const [id, fields] of rows) {
    lastId = id;

    try {
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (key !== undefined && value !== undefined) {
          fieldObj[key] = value;
        }
      }
      const parsed = deserializeFromHash(fieldObj);
      entries.push({ id, event: SessionEventSchema.parse(parsed) });
    } catch (error) {
      // Unknown event type? Log once per type per process, then drop
      // silently. Forward-compat with branches that emit newer events.
      const unknownType = extractUnknownEventType(error);
      if (unknownType !== null) {
        if (!SESSION_EVENT_UNKNOWN_TYPE_SEEN.has(unknownType)) {
          SESSION_EVENT_UNKNOWN_TYPE_SEEN.add(unknownType);
          console.warn(
            `readSessionEvents: ignoring unknown event type '${unknownType}'. ` +
              `Likely emitted by a newer branch sharing this Redis instance. ` +
              `Suppressing further warnings for this type in this process.`,
          );
        }
        // Drop the event silently — known forward-compat case.
        continue;
      }
      // Anything else (corrupt field, missing required prop on a KNOWN
      // event type) is a real bug — keep logging every time.
      console.error('Failed to parse run event:', error);
    }
  }

  return { entries, lastId };
}

/** What a backward read answers with. */
export interface ReadSessionEventEntriesBeforeResult {
  /** Chronological (oldest to newest), like every other reader here. */
  entries: SessionEventEntry[];
  /** Raw rows the reverse range returned, parsed or not. */
  scanned: number;
  /** Whether the stream holds entries older than the ones returned. */
  hasOlder: boolean;
  /** Oldest id the stream still retains, or `null` when it holds nothing. */
  oldestId: string | null;
}

/**
 * The `count` events ending at `beforeId`, or the newest `count` when it is
 * `null`.
 *
 * The backward traversal. A reader asking for "a page from the beginning" of a
 * long session gets the beginning and then tails live, leaving everything
 * between unreachable; anchoring to the newest page and walking back from it is
 * what makes the recent conversation the part that always arrives and the rest
 * reachable on demand.
 *
 * `count + 1` rows are requested so `hasOlder` is answered by the same read
 * rather than by a second one.
 */
export async function readSessionEventEntriesBefore(
  redis: Redis,
  tenantId: string,
  runId: string,
  beforeId: string | null,
  count = 100,
): Promise<ReadSessionEventEntriesBeforeResult> {
  const streamKey = StreamKeys.sessionEventsStream(tenantId, runId);

  // `null` means "from the end" — the newest page. Otherwise walk back from the
  // caller's position, exclusive, so a page boundary does not repeat an entry
  // the caller already holds.
  const end = beforeId === null ? '+' : `(${beforeId}`;

  const rows = await redis.xrevrange(streamKey, end, '-', 'COUNT', count + 1);
  // Same ordering rule as the forward reader: the head is read after the range,
  // so a concurrent trim can only make `oldestId` too new. Too new forces the
  // durable fallback, which is the safe direction; too old would let a gap read
  // as contiguous.
  const head = await redis.xrange(streamKey, '-', '+', 'COUNT', 1);
  const oldestId = head[0]?.[0] ?? null;

  const hasOlder = rows.length > count;
  const page = hasOlder ? rows.slice(0, count) : rows;

  // `xrevrange` answers newest-first; every other reader here is chronological,
  // and a caller folding events in reverse would rebuild the wrong state.
  const { entries } = parseStreamRows([...page].reverse(), '0');

  return { entries, scanned: rows.length, hasOlder, oldestId };
}

/**
 * Read events from a run's event stream.
 * @param cursor - Start cursor ("0" for beginning, or last message ID)
 * @param count - Max events to return
 */
export async function readSessionEvents(
  redis: Redis,
  tenantId: string,
  runId: string,
  cursor = '0',
  count = 100,
): Promise<{ events: SessionEvent[]; lastId: string }> {
  const { entries, lastId } = await readSessionEventEntries(redis, tenantId, runId, cursor, count);
  return { events: entries.map((e) => e.event), lastId };
}

export interface DurableEventEntry {
  id: string;
  /** Null when the type is unknown to this process; `envelope` still carries it. */
  event: SessionEvent | null;
  envelope: Record<string, unknown>;
}

/**
 * Every entry the stream holds after `cursor`, none dropped.
 *
 * `readSessionEvents` skips what it cannot parse, which is the right contract
 * for a live reader and the wrong one for the durability flush: a cursor
 * advanced past a skipped entry forecloses it forever, and the entry most
 * likely to be skipped is one appended by a newer deploy during the rollout
 * window — precisely the events the flush exists to keep. So an unknown event
 * type is returned with a null `event` and its raw envelope, for the caller to
 * persist without understanding, and only an entry that cannot even name
 * itself throws — that is corruption, and halting there keeps the candidate
 * armed instead of committing the skip.
 */
export async function readDurableEventEntries(
  redis: Redis,
  tenantId: string,
  runId: string,
  cursor = '0',
  count = 100,
): Promise<{ entries: DurableEventEntry[]; lastId: string; oldestId: string | null }> {
  const streamKey = StreamKeys.sessionEventsStream(tenantId, runId);

  const [head, result] = await Promise.all([
    redis.xrange(streamKey, '-', '+', 'COUNT', 1),
    redis.xrange(streamKey, cursor, '+', 'COUNT', count),
  ]);
  const oldestId = head[0]?.[0] ?? null;

  const entries: DurableEventEntry[] = [];
  let lastId = cursor;
  for (const [id, fields] of result) {
    if (id === cursor) continue;
    lastId = id;

    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) fieldObj[key] = value;
    }
    const envelope = deserializeFromHash(fieldObj);
    if (
      typeof envelope['eventId'] !== 'string' ||
      typeof envelope['eventType'] !== 'string' ||
      typeof envelope['sessionId'] !== 'string'
    ) {
      throw new Error(
        `session event stream entry ${id} for run ${runId} cannot name itself; refusing to advance the durable cursor past it`,
      );
    }

    const parsed = SessionEventSchema.safeParse(envelope);
    entries.push({ id, event: parsed.success ? parsed.data : null, envelope });
  }

  return { entries, lastId, oldestId };
}

/**
 * The newest entry's position — its stream id and its event id.
 *
 * Both, because they address different things: `XRANGE` seeks by `id`, and the
 * event id identifies the event. A caller minting a resume cursor needs the
 * former; one identifying an event needs the latter.
 */
export async function readLatestSessionPosition(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<{ id: string; eventId: string } | null> {
  const streamKey = StreamKeys.sessionEventsStream(tenantId, sessionId);
  const rows = await redis.xrevrange(streamKey, '+', '-', 'COUNT', 1);
  const entry = rows[0];
  if (!entry) return null;
  const [id, fields] = entry;
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === 'eventId') {
      const eventId = fields[i + 1];
      return eventId === undefined ? null : { id, eventId };
    }
  }
  return null;
}

/**
 * Delete run event stream.
 */
export async function deleteSessionEvents(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const streamKey = StreamKeys.sessionEventsStream(tenantId, runId);
  await redis.del(streamKey);
}

export { compareStreamIds };
