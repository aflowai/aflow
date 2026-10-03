/**
 * The open browser hand-offs: a run's page shown to the operator in a window
 * on their machine while the step that asked waits there.
 *
 * Written by the host executor, which reaches nothing durable — only Redis —
 * and read by the Action Center, which renders one item per record. A record
 * is keyed by machine, profile and site; each run is one field of it, added when
 * its wait begins and removed when the wait ends, however it ends. The last
 * one out deletes the record.
 *
 * The record can hold several runs, but no path writes a second one today: the
 * host executor refuses a hand-off on a profile whose window is already shown
 * (`window_shown`), so while one run waits on a profile, no other run reaches
 * this record.
 *
 * What the system knows of the hand-off — the site, the reason, when it began —
 * is shared by every space waiting on it. The message an agent wrote is kept
 * per space, because a profile can serve several spaces and one space's words
 * are not another's to read.
 *
 * Bounded twice: the record expires at the latest waiting run's deadline plus
 * a margin, so an executor that dies mid-wait cannot leave it forever; and the
 * per-space index is a sorted set scored by that expiry, so its reader asks for
 * the members still in date and never reads the keyspace or a whole set.
 *
 * An executor that died mid-wait leaves its records until they expire, so each
 * machine has an index of its own records too, scored the same way: the host
 * executor takes them down when it starts, before any wait of its own begins.
 * A run joining a record whose every waiter is past its deadline starts the
 * record afresh rather than inheriting a dead run's reason and start.
 */
import type { Redis } from 'ioredis';
import { z } from 'zod';

import {
  BROWSER_HANDOFF_REASONS,
  BrowserHandoffSiteSchema,
  BrowserProfileIdSchema,
  type BrowserHandoffReason,
} from '@aflow/schemas';

/** How long past its own deadline a record outlives a wait nobody ended. */
export const BROWSER_HANDOFF_EXPIRY_MARGIN_MS = 5 * 60_000;

/** The most hand-offs one space's Action Center reads at once. */
export const BROWSER_HANDOFFS_READ_LIMIT = 50;

/** How many of a machine's records one pass of the start-up clear takes down. */
export const BROWSER_HANDOFF_CLEAR_BATCH = 100;

const RECORD_PREFIX = 'aflow:browser-handoff:record:';
const WAITER_PREFIX = 'w:';
const MESSAGE_PREFIX = 'm:';

export function browserHandoffKey(hostname: string, profileId: string, site: string): string {
  return `${RECORD_PREFIX}${hostname}:${profileId}:${site}`;
}

export function browserHandoffSpaceIndexKey(tenantId: string, spaceId: string): string {
  return `aflow:browser-handoff:space:${tenantId}:${spaceId}`;
}

export function browserHandoffMachineIndexKey(hostname: string): string {
  return `aflow:browser-handoff:machine:${hostname}`;
}

function waiterField(spaceId: string, stepExecutionId: string): string {
  return `${WAITER_PREFIX}${spaceId}:${stepExecutionId}`;
}

function messageField(spaceId: string): string {
  return `${MESSAGE_PREFIX}${spaceId}`;
}

const HandoffMetaSchema = z.object({
  hostname: z.string().min(1),
  profileId: BrowserProfileIdSchema,
  site: BrowserHandoffSiteSchema,
  reason: z.enum(BROWSER_HANDOFF_REASONS),
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
  /** What the first run of the space it was read for asked the operator. */
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
 * reason stands, and the first run of each space's words stand for that space;
 * a later one only adds itself and, when its deadline is later, moves the
 * expiry out. A record none of whose runs may still be waiting is begun again,
 * so a run never joins one a dead executor left.
 *
 * Deadlines are compared as ISO-8601 strings, which order as the instants do.
 *
 * KEYS: record, space index, machine index.
 * ARGV: meta, waiter field, waiter, expiry (ms), now (ms), message field, message, now (ISO).
 */
const JOIN = `
local live = false
local fields = redis.call('HGETALL', KEYS[1])
for i = 1, #fields, 2 do
  if string.sub(fields[i], 1, 2) == 'w:' then
    local deadline = string.match(fields[i + 1], '"deadlineAt":"([^"]+)"')
    if deadline and deadline > ARGV[8] then
      live = true
    end
  end
end
if not live then
  redis.call('DEL', KEYS[1])
end
redis.call('HSETNX', KEYS[1], 'meta', ARGV[1])
redis.call('HSETNX', KEYS[1], ARGV[6], ARGV[7])
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
local expiresAt = tonumber(ARGV[4])
local current = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if expiresAt > current then
  redis.call('HSET', KEYS[1], 'expiresAt', ARGV[4])
  redis.call('PEXPIREAT', KEYS[1], expiresAt)
end
for _, index in ipairs({ KEYS[2], KEYS[3] }) do
  local scored = redis.call('ZSCORE', index, KEYS[1])
  if not live or not scored or tonumber(scored) < expiresAt then
    redis.call('ZADD', index, expiresAt, KEYS[1])
  end
  redis.call('ZREMRANGEBYSCORE', index, '-inf', ARGV[5])
  local latest = redis.call('ZREVRANGE', index, 0, 0, 'WITHSCORES')
  if latest[2] then
    redis.call('PEXPIREAT', index, tonumber(latest[2]))
  end
end
return 1
`;

/**
 * Takes a run off the record: the record goes when nobody is left, and the
 * space's index and its message go when nobody from that space is.
 *
 * KEYS: record, space index, machine index.
 * ARGV: waiter field, the space's field prefix, message field.
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
  redis.call('ZREM', KEYS[3], KEYS[1])
end
if not sameSpace then
  redis.call('ZREM', KEYS[2], KEYS[1])
  if anyone then
    redis.call('HDEL', KEYS[1], ARGV[3])
  end
end
if anyone then return 1 end
return 0
`;

export async function joinBrowserHandoff(
  redis: Redis,
  input: JoinBrowserHandoffInput,
): Promise<void> {
  const { waiter } = input;
  if (!BrowserHandoffSiteSchema.safeParse(input.site).success) {
    throw new Error(
      `A hand-off is for a site, a host of 1 to 253 characters; this one has ${String(input.site.length)}`,
    );
  }
  const key = browserHandoffKey(input.hostname, input.profileId, input.site);
  const now = Date.now();
  const meta = {
    hostname: input.hostname,
    profileId: input.profileId,
    site: input.site,
    reason: input.reason,
    startedAt: new Date(input.startedAt).toISOString(),
  };
  const stored: BrowserHandoffWaiter = {
    ...waiter,
    deadlineAt: new Date(waiter.deadlineAt).toISOString(),
  };
  await redis.eval(
    JOIN,
    3,
    key,
    browserHandoffSpaceIndexKey(waiter.tenantId, waiter.spaceId),
    browserHandoffMachineIndexKey(input.hostname),
    JSON.stringify(meta),
    waiterField(waiter.spaceId, waiter.stepExecutionId),
    JSON.stringify(stored),
    String(waiter.deadlineAt + BROWSER_HANDOFF_EXPIRY_MARGIN_MS),
    String(now),
    messageField(waiter.spaceId),
    input.message,
    new Date(now).toISOString(),
  );
}

export interface LeaveBrowserHandoffInput {
  readonly key: string;
  /** The machine whose record it is. */
  readonly hostname: string;
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
    3,
    input.key,
    browserHandoffSpaceIndexKey(input.tenantId, input.spaceId),
    browserHandoffMachineIndexKey(input.hostname),
    waiterField(input.spaceId, input.stepExecutionId),
    `${WAITER_PREFIX}${input.spaceId}:`,
    messageField(input.spaceId),
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
  const message = fields[messageField(spaceId)];
  if (!meta.success || message === undefined || message === '') return null;
  const prefix = `${WAITER_PREFIX}${spaceId}:`;
  const waiting = Object.entries(fields)
    .filter(([field]) => field.startsWith(prefix))
    .map(([, raw]) => HandoffWaiterSchema.safeParse(parseJson(raw)))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((waiter) => waiter.tenantId === tenantId && waiter.spaceId === spaceId)
    .sort((a, b) => (a.deadlineAt < b.deadlineAt ? -1 : a.deadlineAt > b.deadlineAt ? 1 : 0));
  if (waiting.length === 0) return null;
  return { key, ...meta.data, message, waiting };
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

export interface BrowserHandoffSpace {
  readonly tenantId: string;
  readonly spaceId: string;
}

/**
 * Takes down every record this machine holds, and each from its spaces'
 * indexes, through the machine's own index. Only for an executor that is
 * starting: none of its waits has begun, so every record there belongs to one
 * that is gone. Returns the spaces whose Action Center lost an item.
 */
export async function clearMachineBrowserHandoffs(
  redis: Redis,
  hostname: string,
): Promise<BrowserHandoffSpace[]> {
  const index = browserHandoffMachineIndexKey(hostname);
  const spaces = new Map<string, BrowserHandoffSpace>();
  for (;;) {
    const keys = await redis.zrange(index, 0, BROWSER_HANDOFF_CLEAR_BATCH - 1);
    if (keys.length === 0) break;
    const read = redis.pipeline();
    for (const key of keys) read.hgetall(key);
    const replies = (await read.exec()) ?? [];
    const clear = redis.multi();
    keys.forEach((key, at) => {
      const [error, fields] = replies[at] ?? [null, null];
      if (error === null && fields !== null && typeof fields === 'object') {
        for (const [field, raw] of Object.entries(fields as Record<string, string>)) {
          if (!field.startsWith(WAITER_PREFIX)) continue;
          const waiter = HandoffWaiterSchema.safeParse(parseJson(raw));
          if (!waiter.success) continue;
          const { tenantId, spaceId } = waiter.data;
          clear.zrem(browserHandoffSpaceIndexKey(tenantId, spaceId), key);
          spaces.set(`${tenantId}:${spaceId}`, { tenantId, spaceId });
        }
      }
      clear.del(key);
      clear.zrem(index, key);
    });
    const failed = ((await clear.exec()) ?? []).find(([error]) => error !== null)?.[0];
    if (failed) throw failed;
    if (keys.length < BROWSER_HANDOFF_CLEAR_BATCH) break;
  }
  return [...spaces.values()];
}
