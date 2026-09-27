import type { Redis } from 'ioredis';
import { type EntityEventEnvelope, EntityEventEnvelopeSchema } from '@aflow/schemas';

// ============================================================================
// Constants
// ============================================================================

/** Default MAXLEN cap for the entity events stream. */
export const ENTITY_EVENTS_MAXLEN = 10_000;

/** Default TTL for entity event streams (7 days). */
export const ENTITY_EVENTS_TTL_SECONDS = 7 * 24 * 60 * 60;

// ============================================================================
// Key Builders
// ============================================================================

/**
 * Redis stream key for entity events within a space.
 *
 * Key pattern: `entity_events:{tenantId}:{spaceId}`
 */
export function ENTITY_EVENTS_STREAM_KEY(tenantId: string, spaceId: string): string {
  return `entity_events:${tenantId}:${spaceId}`;
}

/**
 * Pub/Sub channel for entity event notifications (best-effort wakeup for SSE).
 *
 * Key pattern: `entity_events:pubsub:{tenantId}:{spaceId}`
 */
export function ENTITY_EVENTS_PUBSUB_CHANNEL(tenantId: string, spaceId: string): string {
  return `entity_events:pubsub:${tenantId}:${spaceId}`;
}

// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Serialize an entity event envelope into flat key-value pairs for XADD.
 * Returns an array of [key, value, key, value, ...].
 */
function serializeForStream(event: EntityEventEnvelope): string[] {
  const result: string[] = [];

  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) continue;

    if (value === null) {
      result.push(key, 'null');
    } else if (typeof value === 'object') {
      result.push(key, JSON.stringify(value));
    } else if (typeof value === 'boolean') {
      result.push(key, value ? 'true' : 'false');
    } else {
      result.push(key, String(value));
    }
  }

  return result;
}

/**
 * Set of field names that must remain as strings during deserialization.
 * Prevents numeric-looking UUIDs or slugs from being parsed as numbers.
 */
const STRING_FIELDS = new Set([
  'eventId',
  'eventType',
  'spaceId',
  'tenantId',
  'causedBySessionId',
  'causedByStepExecutionId',
  'causedByEntityEventId',
  'workflowSlug',
  'workflowRunId',
  'operatingMode',
  'summary',
]);

/**
 * Deserialize Redis stream fields back into an object.
 */
function deserializeFromStream(fields: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === 'null') {
      result[key] = null;
    } else if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (STRING_FIELDS.has(key)) {
      result[key] = value;
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d*\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else if (value.startsWith('{') || value.startsWith('[')) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ============================================================================
// Stream Operations
// ============================================================================

/**
 * Append an entity event to the space's entity event stream.
 *
 * The write, the TTL extension and the subscriber wakeup travel as one
 * transaction. A PUBLISH issued separately can be lost on its own — leaving a
 * durable event that no connected subscriber is ever told about, recoverable
 * only by a periodic re-read. Sharing the XADD's round trip removes that
 * failure class and costs two fewer round trips than issuing them in sequence.
 *
 * @returns The Redis stream message ID.
 */
export async function appendEntityEvent(
  redis: Redis,
  params: {
    tenantId: string;
    spaceId: string;
    event: EntityEventEnvelope;
  },
): Promise<string> {
  const { tenantId, spaceId, event } = params;
  const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);
  const fields = serializeForStream(event);
  const channel = ENTITY_EVENTS_PUBSUB_CHANNEL(tenantId, spaceId);

  const results = await redis
    .multi()
    .xadd(streamKey, 'MAXLEN', '~', String(ENTITY_EVENTS_MAXLEN), '*', ...fields)
    .expire(streamKey, ENTITY_EVENTS_TTL_SECONDS)
    .publish(
      channel,
      JSON.stringify({ type: 'entity_event', spaceId, eventType: event.eventType, ts: Date.now() }),
    )
    .exec();

  const appended = results?.[0];
  if (!appended) {
    throw new Error('Failed to append entity event to stream');
  }
  const [appendError, messageId] = appended;
  if (appendError || typeof messageId !== 'string') {
    throw new Error('Failed to append entity event to stream', {
      ...(appendError ? { cause: appendError } : {}),
    });
  }

  return messageId;
}

/**
 * Read entity events from a space's entity event stream.
 *
 * Uses XRANGE for cursor-based reading. Pass `fromId` as the last seen
 * message ID to resume from that point (exclusive). Defaults to reading
 * from the beginning of the stream.
 *
 * @returns Array of parsed entity event envelopes.
 */
export async function readEntityEvents(
  redis: Redis,
  params: {
    tenantId: string;
    spaceId: string;
    /** Start cursor (exclusive). Use '0' for beginning. Defaults to '0'. */
    fromId?: string;
    /** Maximum number of events to return. Defaults to 100. */
    count?: number;
  },
): Promise<{ events: EntityEventEnvelope[]; lastId: string }> {
  const { tenantId, spaceId, fromId = '0', count = 100 } = params;
  const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);

  const result = await redis.xrange(streamKey, fromId, '+', 'COUNT', count);

  if (result.length === 0) {
    return { events: [], lastId: fromId };
  }

  const events: EntityEventEnvelope[] = [];
  let lastId = fromId;

  for (const [id, fields] of result) {
    // Skip the cursor itself if included
    if (id === fromId) continue;

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
      const parsed = deserializeFromStream(fieldObj);
      events.push(EntityEventEnvelopeSchema.parse(parsed));
    } catch (error) {
      console.error('Failed to parse entity event:', error);
    }
  }

  return { events, lastId };
}

/** One entry from the entity event stream with its Redis stream ID (for SSE resume). */
export interface EntityStreamEntry {
  streamId: string;
  event: EntityEventEnvelope;
}

/**
 * Read entity events with Redis stream IDs preserved (for SSE `id:` lines).
 *
 * `hasMore` reports that the page came back at the requested cap, so the
 * caller must read again from `lastCursor` to finish draining. Callers cannot
 * derive it from `entries.length`: the cursor entry and any unparseable row
 * are dropped from `entries` but still consume a slot in the page.
 */
export async function readEntityEventStreamEntries(
  redis: Redis,
  params: {
    tenantId: string;
    spaceId: string;
    fromId?: string;
    count?: number;
  },
): Promise<{ entries: EntityStreamEntry[]; lastCursor: string; hasMore: boolean }> {
  const { tenantId, spaceId, fromId = '0', count = 100 } = params;
  const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);

  const result = await redis.xrange(streamKey, fromId, '+', 'COUNT', count);

  if (result.length === 0) {
    return { entries: [], lastCursor: fromId, hasMore: false };
  }

  const entries: EntityStreamEntry[] = [];
  let lastCursor = fromId;

  for (const [id, fields] of result) {
    if (id === fromId) continue;
    lastCursor = id;

    try {
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (key !== undefined && value !== undefined) {
          fieldObj[key] = value;
        }
      }
      const parsed = deserializeFromStream(fieldObj);
      const event = EntityEventEnvelopeSchema.parse(parsed);
      entries.push({ streamId: id, event });
    } catch (error) {
      console.error('Failed to parse entity event:', error);
    }
  }

  return { entries, lastCursor, hasMore: result.length >= count };
}
