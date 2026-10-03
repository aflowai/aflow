/**
 * The open browser hand-offs: a run's page shown to the operator in a window
 * on their machine while the step that asked waits there.
 *
 * Written by the host executor, which reaches nothing durable — only Redis —
 * and read by the Action Center, which renders one item per record. A record
 * is keyed by machine, profile and site, so a second run waiting on the same
 * site joins the record already there; each run is one field of it, added when
 * its wait begins and removed when the wait ends, however it ends. The last
 * one out deletes the record.
 *
 * Bounded twice: the record expires at the latest waiting run's deadline plus
 * a margin, so an executor that dies mid-wait cannot leave it forever; and the
 * per-space index is a sorted set scored by that expiry, so its reader asks for
 * the members still in date and never reads the keyspace or a whole set.
 */
import type { Redis } from 'ioredis';
import { z } from 'zod';

import {
  BROWSER_HANDOFF_REASONS,
  BrowserProfileIdSchema,
  type BrowserHandoffReason,
} from '@aflow/schemas';

/** How long past its own deadline a record outlives a wait nobody ended. */
export const BROWSER_HANDOFF_EXPIRY_MARGIN_MS = 5 * 60_000;

/** The most hand-offs one space's Action Center reads at once. */
export const BROWSER_HANDOFFS_READ_LIMIT = 50;

const RECORD_PREFIX = 'aflow:browser-handoff:record:';
const WAITER_PREFIX = 'w:';

export function browserHandoffKey(hostname: string, profileId: string, site: string): string {
  return `${RECORD_PREFIX}${hostname}:${profileId}:${site}`;
}

export function browserHandoffSpaceIndexKey(tenantId: string, spaceId: string): string {
  return `aflow:browser-handoff:space:${tenantId}:${spaceId}`;
}

function waiterField(spaceId: string, stepExecutionId: string): string {
  return `${WAITER_PREFIX}${spaceId}:${stepExecutionId}`;
}

const HandoffMetaSchema = z.object({
  hostname: z.string().min(1),
  profileId: BrowserProfileIdSchema,
  site: z.string().min(1),
  reason: z.enum(BROWSER_HANDOFF_REASONS),
  message: z.string().min(1),
  startedAt: z.string(),
});

const HandoffWaiterSchema = z.object({
  tenantId: z.string(),
  spaceId: z.string(),
  runId: z.string(),
  stepExecutionId: z.string(),
  sessionId: z.string().optional(),
  /** When this run's own wait ends at the latest. */
  deadlineAt: z.string(),
});

export type BrowserHandoffWaiter = z.infer<typeof HandoffWaiterSchema>;

export interface BrowserHandoffRecord {
  readonly key: string;
  readonly hostname: string;
  readonly profileId: string;
  readonly site: string;
  readonly reason: BrowserHandoffReason;
  readonly message: string;
  readonly startedAt: string;
  /** The runs of the space it was read for, soonest deadline first. */
  readonly waiting: readonly BrowserHandoffWaiter[];
}

export interface JoinBrowserHandoffInput {
  readonly hostname: string;
  readonly profileId: string;
  readonly site: string;
  readonly reason: BrowserHandoffReason;
  readonly message: string;
  readonly startedAt: number;
  readonly waiter: Omit<BrowserHandoffWaiter, 'deadlineAt'> & { readonly deadlineAt: number };
}

/**
 * Adds a run to the record, creating it when it is the first. The first run's
 * reason and words stand; a later one only adds itself and, when its deadline
 * is later, moves the expiry out.
 *
 * KEYS: record, space index. ARGV: meta, waiter field, waiter, expiry (ms), now (ms).
 */
const JOIN = `
redis.call('HSETNX', KEYS[1], 'meta', ARGV[1])
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
local expiresAt = tonumber(ARGV[4])
local current = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if expiresAt > current then
  redis.call('HSET', KEYS[1], 'expiresAt', ARGV[4])
  redis.call('PEXPIREAT', KEYS[1], expiresAt)
end
local scored = redis.call('ZSCORE', KEYS[2], KEYS[1])
if not scored or tonumber(scored) < expiresAt then
  redis.call('ZADD', KEYS[2], expiresAt, KEYS[1])
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5])
local latest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
if latest[2] then
  redis.call('PEXPIREAT', KEYS[2], tonumber(latest[2]))
end
return 1
`;

/**
 * Takes a run off the record: the record goes when nobody is left, and the
 * space's index forgets it when nobody from that space is.
 *
 * KEYS: record, space index. ARGV: waiter field, the space's field prefix.
 */
const LEAVE = `
redis.call('HDEL', KEYS[1], ARGV[1])
local anyone = false
local sameSpace = false
for _, field in ipairs(redis.call('HKEYS', KEYS[1])) do
  if string.sub(field, 1, 2) == 'w:' then
    anyone = true
    if string.sub(field, 1, string.len(ARGV[2])) == ARGV[2] then
      sameSpace = true
    end
  end
end
if not anyone then
  redis.call('DEL', KEYS[1])
end
if not sameSpace then
  redis.call('ZREM', KEYS[2], KEYS[1])
end
if anyone then return 1 end
return 0
`;

export async function joinBrowserHandoff(
  redis: Redis,
  input: JoinBrowserHandoffInput,
): Promise<void> {
  const { waiter } = input;
  const key = browserHandoffKey(input.hostname, input.profileId, input.site);
  const meta = {
    hostname: input.hostname,
    profileId: input.profileId,
    site: input.site,
    reason: input.reason,
    message: input.message,
    startedAt: new Date(input.startedAt).toISOString(),
  };
  const stored: BrowserHandoffWaiter = {
    ...waiter,
    deadlineAt: new Date(waiter.deadlineAt).toISOString(),
  };
  await redis.eval(
    JOIN,
    2,
    key,
    browserHandoffSpaceIndexKey(waiter.tenantId, waiter.spaceId),
    JSON.stringify(meta),
    waiterField(waiter.spaceId, waiter.stepExecutionId),
    JSON.stringify(stored),
    String(waiter.deadlineAt + BROWSER_HANDOFF_EXPIRY_MARGIN_MS),
    String(Date.now()),
  );
}

export interface LeaveBrowserHandoffInput {
  readonly key: string;
  readonly tenantId: string;
  readonly spaceId: string;
  readonly stepExecutionId: string;
}

/** Returns whether anyone is still waiting on the record. */
export async function leaveBrowserHandoff(
  redis: Redis,
  input: LeaveBrowserHandoffInput,
): Promise<boolean> {
  const left = await redis.eval(
    LEAVE,
    2,
    input.key,
    browserHandoffSpaceIndexKey(input.tenantId, input.spaceId),
    waiterField(input.spaceId, input.stepExecutionId),
    `${WAITER_PREFIX}${input.spaceId}:`,
  );
  return left === 1;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toRecord(
  key: string,
  fields: Record<string, string>,
  tenantId: string,
  spaceId: string,
): BrowserHandoffRecord | null {
  const meta = HandoffMetaSchema.safeParse(parseJson(fields['meta'] ?? ''));
  if (!meta.success) return null;
  const prefix = `${WAITER_PREFIX}${spaceId}:`;
  const waiting = Object.entries(fields)
    .filter(([field]) => field.startsWith(prefix))
    .map(([, raw]) => HandoffWaiterSchema.safeParse(parseJson(raw)))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((waiter) => waiter.tenantId === tenantId && waiter.spaceId === spaceId)
    .sort((a, b) => (a.deadlineAt < b.deadlineAt ? -1 : a.deadlineAt > b.deadlineAt ? 1 : 0));
  if (waiting.length === 0) return null;
  return { key, ...meta.data, waiting };
}

/**
 * The hand-offs a space's runs are waiting on, each with only that space's
 * runs. Reads the space's index, never the keyspace.
 */
export async function readSpaceBrowserHandoffs(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  now: number = Date.now(),
): Promise<BrowserHandoffRecord[]> {
  const keys = await redis.zrangebyscore(
    browserHandoffSpaceIndexKey(tenantId, spaceId),
    now,
    '+inf',
    'LIMIT',
    0,
    BROWSER_HANDOFFS_READ_LIMIT,
  );
  if (keys.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.hgetall(key);
  const replies = (await pipeline.exec()) ?? [];
  return keys.flatMap((key, index) => {
    const [error, fields] = replies[index] ?? [null, null];
    if (error !== null || fields === null || typeof fields !== 'object') return [];
    const record = toRecord(key, fields as Record<string, string>, tenantId, spaceId);
    return record === null ? [] : [record];
  });
}
