/**
 * Retention for the transport streams — job, shard result, shard control.
 *
 * These are work queues, not observation feeds, so they cannot be capped by
 * count: `MAXLEN` has no knowledge of consumer progress and would delete a
 * backlog out from under an executor that is merely down. The trim point is
 * derived instead from what every consumer group has finished with, which needs
 * no threshold and self-tunes to any throughput.
 *
 * Discovery is candidate-driven: transport activity on a stream arms it, and
 * arming extends the pipeline the producer or consumer already issues rather
 * than adding a round trip.
 *
 * Every uncertain answer here resolves to "do not trim". A missing key is the
 * only error this module interprets; any other failure propagates, because a
 * timeout or a permission error tells us nothing about consumer progress and
 * the alternative is deleting work on the strength of a failed read.
 */
import type { ChainableCommander, Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { compareStreamIds, nextStreamId, parseStreamId } from './streamId.js';

export interface StreamRetentionResult {
  streamKey: string;
  /** Entries removed by this trim. */
  trimmed: number;
  /** Entries still held after it — nonzero means work no group has finished. */
  retained: number;
  /**
   * Age of the oldest entry still held, or null when nothing is held.
   *
   * The signal an operator alerts on. Redis stream ids are millisecond
   * timestamps, so this is measured rather than tracked: it needs no state, no
   * previous value, and no notion of which process observed the stream last. A
   * stream being worked reads in seconds; one whose consumer group has been
   * abandoned climbs without bound.
   */
  oldestRetainedAgeMs: number | null;
  /**
   * The computed frontier, or null when the stream is unclaimable (missing, or
   * carrying no consumer group) and must be left alone.
   */
  frontier: string | null;
}

interface ConsumerGroupProgress {
  name: string;
  pending: number;
  lastDeliveredId: string;
}

/** Redis reports a read against an absent stream this way. */
function isNoSuchKeyError(error: unknown): boolean {
  return error instanceof Error && /no such key/i.test(error.message);
}

/**
 * Mark a stream as worth examining. Takes the caller's pipeline so the SADD
 * rides along with the command that made it true.
 *
 * Armed on production as well as acknowledgement. An ack is the only event that
 * can move the frontier, but a stream whose consumer group has been abandoned
 * never produces another one — and that is precisely the stream an operator
 * needs to see growing. Arming on enqueue keeps it measurable.
 */
export function armRetentionCandidate(pipeline: ChainableCommander, streamKey: string): void {
  pipeline.sadd(StreamKeys.retentionCandidateSet, streamKey);
}

/**
 * Run an ack pipeline that also arms candidates.
 *
 * `pipeline.exec()` reports per-command failures in its replies instead of
 * rejecting, so an ack that failed would otherwise pass silently and the entry
 * would be redelivered with nothing logged. The first `ackCount` replies are the
 * acks and their errors are raised; a failed arm is deliberately ignored, since
 * any later activity on that stream re-arms it and retention has no deadline.
 */
export async function execAckPipeline(
  pipeline: ChainableCommander,
  ackCount: number,
): Promise<void> {
  const replies = await pipeline.exec();
  if (replies === null) return;
  for (let i = 0; i < ackCount && i < replies.length; i++) {
    const error = replies[i]?.[0];
    if (error !== null && error !== undefined) throw error;
  }
}

/**
 * The XADD reply from a pipeline that also armed a candidate.
 *
 * Same rule as `execAckPipeline`: the enqueue's own failure must surface, while
 * a failed arm is advisory. Returning null for a missing id preserves the
 * "Failed to add ..." error each producer already raises.
 */
export function firstReplyString(replies: Array<[Error | null, unknown]> | null): string | null {
  const reply = replies?.[0];
  if (reply === undefined) return null;
  const [error, value] = reply;
  if (error !== null) throw error;
  return typeof value === 'string' ? value : null;
}

/**
 * Take up to `limit` candidates. SPOP rather than SMEMBERS: the batch is bounded
 * regardless of how many streams are armed, and concurrent drainers cannot claim
 * the same stream.
 */
export async function claimRetentionCandidates(redis: Redis, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  return redis.spop(StreamKeys.retentionCandidateSet, limit);
}

/**
 * Read up to `limit` candidates without consuming them — the observe-mode
 * counterpart of `claimRetentionCandidates`. Observing must not mutate the set
 * it is observing, and popping without trimming would drop candidates that no
 * later activity is guaranteed to restore.
 */
export async function peekRetentionCandidates(redis: Redis, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  return redis.srandmember(StreamKeys.retentionCandidateSet, limit);
}

/** Put back a candidate whose trim did not happen, so it is examined again. */
export async function rearmRetentionCandidates(
  redis: Redis,
  streamKeys: readonly string[],
): Promise<void> {
  if (streamKeys.length === 0) return;
  await redis.sadd(StreamKeys.retentionCandidateSet, ...streamKeys);
}

/**
 * The oldest entry any consumer group could still need.
 *
 * Per group: the oldest unacked entry when one exists, since XAUTOCLAIM can hand
 * it to another consumer; otherwise everything delivered has been acked and the
 * group is finished up to and including its last delivered id.
 *
 * Returns null when no group has claimed the stream — nothing is known to be
 * safe, so nothing is removed.
 *
 * Deleting a consumer that still holds pending entries drops them from the PEL
 * without moving last-delivered-id back, which makes them trimmable here. That
 * is Redis discarding the work, not this function — but it means the
 * zero-pending guard in `cleanupStaleConsumers` is load-bearing for the
 * never-trim-undelivered-work invariant.
 */
export async function computeAckedFrontier(
  redis: Redis,
  streamKey: string,
): Promise<string | null> {
  const groups = await readConsumerGroups(redis, streamKey);
  if (groups === null || groups.length === 0) return null;

  let frontier: string | null = null;
  for (const group of groups) {
    const candidate = await groupFrontier(redis, streamKey, group);
    if (frontier === null || compareStreamIds(candidate, frontier) < 0) {
      frontier = candidate;
    }
  }
  return frontier;
}

/**
 * Trim a stream to its acked frontier.
 *
 * `dryRun` computes and reports without removing anything — the observe mode a
 * candidate migration rolls out behind.
 */
export async function trimToAckedFrontier(
  redis: Redis,
  streamKey: string,
  options: { dryRun?: boolean } = {},
): Promise<StreamRetentionResult> {
  const frontier = await computeAckedFrontier(redis, streamKey);

  // XLEN and the oldest surviving entry ride in the same pipeline as the trim,
  // so the "how much is left and how old is it" reading costs no extra round
  // trip and describes the stream as it is after this trim rather than before.
  const pipeline = redis.pipeline();
  const trimmingNow = frontier !== null && options.dryRun !== true;
  if (trimmingNow) pipeline.xtrim(streamKey, 'MINID', frontier);
  pipeline.xlen(streamKey).xrange(streamKey, '-', '+', 'COUNT', 1);

  const replies = await pipeline.exec();
  const offset = trimmingNow ? 1 : 0;
  const trimmed = trimmingNow ? numericReply(replies?.[0], 'XTRIM', streamKey) : 0;
  const retained = numericReply(replies?.[offset], 'XLEN', streamKey);
  const oldestId = oldestEntryId(replies?.[offset + 1], streamKey);

  return {
    streamKey,
    trimmed,
    retained,
    oldestRetainedAgeMs:
      oldestId === null ? null : Math.max(0, Date.now() - parseStreamId(oldestId).ms),
    frontier,
  };
}

async function groupFrontier(
  redis: Redis,
  streamKey: string,
  group: ConsumerGroupProgress,
): Promise<string> {
  if (group.pending === 0) return nextStreamId(group.lastDeliveredId);

  const oldest = await oldestPendingId(redis, streamKey, group.name);
  if (oldest !== null) return oldest;

  // A well-formed reply carrying no pending entry means the group drained
  // between the XINFO and the XPENDING. The last delivered id read a moment ago
  // is behind the current one, so falling back to it trims less than the stream
  // now could — the safe direction. A *failed* XPENDING never reaches here.
  return nextStreamId(group.lastDeliveredId);
}

async function readConsumerGroups(
  redis: Redis,
  streamKey: string,
): Promise<ConsumerGroupProgress[] | null> {
  let raw: unknown;
  try {
    raw = await redis.xinfo('GROUPS', streamKey);
  } catch (error) {
    if (isNoSuchKeyError(error)) return null;
    throw error;
  }
  if (!Array.isArray(raw)) return null;

  const groups: ConsumerGroupProgress[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const fields = flatPairsToRecord(entry as unknown[]);
    const name = fields['name'];
    const lastDeliveredId = fields['last-delivered-id'];
    if (name === undefined || lastDeliveredId === undefined) continue;
    groups.push({
      name,
      pending: Number.parseInt(fields['pending'] ?? '0', 10) || 0,
      lastDeliveredId,
    });
  }
  return groups;
}

/**
 * Summary-form XPENDING returns [count, minId, maxId, consumers].
 *
 * Null only for a well-formed reply naming no pending entry. A command failure
 * propagates: the caller would otherwise read "this group has nothing
 * outstanding" out of a timeout and trim entries that are still unacked.
 */
async function oldestPendingId(
  redis: Redis,
  streamKey: string,
  groupName: string,
): Promise<string | null> {
  const summary: unknown = await redis.xpending(streamKey, groupName);
  if (!Array.isArray(summary)) return null;
  const minId: unknown = (summary as unknown[])[1];
  return typeof minId === 'string' ? minId : null;
}

/**
 * MINID is inclusive, so the id after the last delivered one is what removes
 * that entry too.
 */

/**
 * First entry of an `XRANGE ... COUNT 1` reply: `[[id, [field, value, ...]]]`.
 * An empty reply means the stream holds nothing, which is not an error.
 */
function oldestEntryId(
  reply: [Error | null, unknown] | undefined,
  streamKey: string,
): string | null {
  if (reply === undefined) return null;
  const [error, value] = reply;
  if (error !== null) {
    if (isNoSuchKeyError(error)) return null;
    throw error;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const first: unknown = (value as unknown[])[0];
  if (!Array.isArray(first)) {
    throw new Error(`XRANGE on ${streamKey} returned an unreadable entry`);
  }
  const id: unknown = (first as unknown[])[0];
  return typeof id === 'string' ? id : null;
}

/**
 * A pipelined command reports its failure in the reply rather than rejecting.
 * Reading that as a zero would make a failed XTRIM indistinguishable from a
 * stream that had nothing to remove, and the candidate would be counted
 * processed and dropped.
 */
function numericReply(
  reply: [Error | null, unknown] | undefined,
  command: string,
  streamKey: string,
): number {
  if (reply === undefined) {
    throw new Error(`${command} on ${streamKey} returned no reply`);
  }
  const [error, value] = reply;
  if (error !== null) throw error;
  if (typeof value !== 'number') {
    throw new Error(`${command} on ${streamKey} returned a non-numeric reply`);
  }
  return value;
}

function flatPairsToRecord(pairs: unknown[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const key = pairs[i];
    const value = pairs[i + 1];
    if (typeof key === 'string' && (typeof value === 'string' || typeof value === 'number')) {
      record[key] = String(value);
    }
  }
  return record;
}
