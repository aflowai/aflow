import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { isSlowBlockingRead } from '@aflow/lib';
import {
  LiveDeltaChannelSchema,
  StreamKeys,
  WORKFLOW_TASK_LIVE_DELTA_EVENT_TYPE,
  type LiveDeltaChannel,
  type WorkflowTaskSurfaceUpdatePayload,
  type WorkflowTaskActivityPayload,
  type StepExecutionId,
} from '@aflow/schemas';
import type { BlockingRedisConnection } from '@aflow/redis';
import {
  emitWorkflowProgress,
  publishWorkflowLiveDeltaWake,
  type WorkflowProgressEvent,
} from './workflowRunProgress.js';

const PROGRESS_BLOCK_MS = 500;

/** How often the consumer drops index entries whose stream is gone. */
const INDEX_PRUNE_INTERVAL_MS = 60_000;

function streamIdToTimestampMsLocal(id: string): number | null {
  if (!id || id === '-' || id === '+') return null;
  const dashIdx = id.indexOf('-');
  const tsRaw = dashIdx === -1 ? id : id.slice(0, dashIdx);
  const ts = Number(tsRaw);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

export interface WorkflowTaskProgressConsumerDeps {
  db: PostgresJsDatabase;
  /** Regular Redis connection — SCAN, DEL, ack, fan-out writes. */
  redis: Redis;
  blockingRedis: BlockingRedisConnection;
}

export interface WorkflowTaskProgressConsumerArgs {
  /** How often to poll for new events when no streams are active. */
  pollIntervalMs?: number;
  /** Per-XREAD batch limit. */
  batchSize?: number;
}

/**
 * Per-task cursor.
 *
 * **First discovery uses `0`** — read every entry currently on the
 * stream. The executor may have XADD'd mutations between its emission
 * and the consumer's first SCAN; `$` ("only events emitted after this
 * XREAD started") would silently drop those. The producer's MAXLEN ~1000
 * bounds the catch-up size.
 *
 * Subsequent reads advance to the last-id returned by XREAD so we don't
 * re-deliver. If the consumer restarts mid-task the cursor resets to
 * `0` and the consumer re-emits from the start of what's still on the
 * stream — re-emitting `WorkflowTaskSurfaceUpdate` mutations is
 * idempotent at the reducer (mutations replace the in-place item).
 */
type Cursor = string;
const INITIAL_CURSOR = '0' as const;

export interface StartedConsumer {
  /** Stop the consumer loop; resolves after the current iteration finishes. */
  stop(): Promise<void>;
}

/**
 * Start a polling consumer that reads progress streams across all
 * tenants. Returns a handle the orchestrator can use to stop the loop
 * on shutdown.
 *
 * Tenant-agnostic: the XADD payload carries `tenantId` as a field
 * (executor side, see `ctx.emitWorkflowProgress`); the consumer parses
 * that off each event and routes the fan-out per the embedded tenant.
 * One global SCAN + XREAD loop covers every tenant instead of N per-
 * tenant workers.
 *
 * Streams discovered via `SCAN MATCH aflow:workflow_task_progress:*`.
 * The consumer maintains an in-memory cursor map (stream → last-read
 * id) and uses `XREAD BLOCK 500 COUNT batchSize STREAMS s1 s2 ... c1
 * c2 ...` to batch-read new events across all known streams in one call.
 */
export function startWorkflowTaskProgressConsumer(
  deps: WorkflowTaskProgressConsumerDeps,
  args: WorkflowTaskProgressConsumerArgs = {},
): StartedConsumer {
  const pollIntervalMs = args.pollIntervalMs ?? 1000;
  const batchSize = args.batchSize ?? 50;
  const cursors = new Map<string, Cursor>();
  let stopped = false;
  let currentIteration: Promise<number> | null = null;
  let lastPruneMs = Date.now();

  const loop = async () => {
    while (!stopped) {
      currentIteration = runOneIteration({
        deps,
        cursors,
        batchSize,
      });
      let emitted = 0;
      try {
        emitted = await currentIteration;
      } catch (err) {
        // Best-effort loop — log and continue. A repeated failure on the
        // same stream is harmless because the cursor doesn't advance,
        // so the next iteration will retry the same events.
        console.warn(
          `[workflowTaskProgressConsumer] iteration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      currentIteration = null;
      if (stopped) break;
      // Phase 3 review fix — skip idle backoff when work was done.
      // Stream-active iterations loop immediately so the chat surface
      // tracks the executor's ~150ms flush cadence; the fixed
      // `pollIntervalMs` sleep only applies when XREAD timed out with
      // no events (no work to do anyway).
      if (emitted === 0) {
        await sleep(pollIntervalMs);
      }

      // A task that dies between its first emit and completion leaves its entry
      // behind; the stream expires under its own TTL but the member does not.
      // Pruning here rather than only at boot keeps the index tracking running
      // tasks instead of cumulative failures.
      if (!stopped && Date.now() - lastPruneMs >= INDEX_PRUNE_INTERVAL_MS) {
        lastPruneMs = Date.now();
        await pruneWorkflowTaskProgressIndex(deps.redis).catch(() => 0);
      }
    }
  };
  void loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (currentIteration) await currentIteration.catch(() => {});
    },
  };
}

async function runOneIteration(args: {
  deps: WorkflowTaskProgressConsumerDeps;
  cursors: Map<string, Cursor>;
  batchSize: number;
}): Promise<number> {
  const { deps, cursors, batchSize } = args;
  // Step 1: read the index of active per-task streams. This used to scan the
  // whole Redis keyspace on every iteration — roughly once a second, forever —
  // which made the cost proportional to every key in Redis rather than to the
  // tasks actually running, and put a 225µs command on the same thread as the
  // hot path.
  const streams = await deps.redis.smembers(StreamKeys.workflowTaskProgressIndexKey);

  if (cursors.size > 0) {
    const live = new Set(streams);
    for (const key of cursors.keys()) {
      if (!live.has(key)) cursors.delete(key);
    }
  }

  if (streams.length === 0) return 0;

  // Step 2: XREAD across all streams with a small BLOCK timeout so we
  // wake when ANY stream produces. Cursor `0` on first observation means
  // "read every entry on the stream" — covers the race where the
  // executor XADDs before the consumer's first SCAN finds the key.
  // Subsequent reads use the returned last-id (advance-only).
  //
  const ids = streams.map((s) => cursors.get(s) ?? INITIAL_CURSOR);
  const readStart = Date.now();
  const result = await deps.blockingRedis.xread(
    'COUNT',
    batchSize,
    'BLOCK',
    String(PROGRESS_BLOCK_MS),
    'STREAMS',
    ...streams,
    ...ids,
  );
  const xreadElapsedMs = Date.now() - readStart;
  if (!result) {
    if (isSlowBlockingRead(xreadElapsedMs, PROGRESS_BLOCK_MS)) {
      console.warn(
        `[PERF] hot_path_consumer_slow_read component=workflow-task-progress-consumer ` +
          `xreadElapsedMs=${String(xreadElapsedMs)} blockMs=${String(PROGRESS_BLOCK_MS)} ` +
          `entriesRead=0 streams=${String(streams.length)}`,
      );
    }
    return 0;
  }
  // Compute max message age for the batch; warn if upstream lag is high.
  let maxAgeMs = 0;
  let totalEntries = 0;
  const now = Date.now();
  for (const [, entries] of result as Array<[string, Array<[string, string[]]>]>) {
    for (const [id] of entries) {
      totalEntries += 1;
      const ts = streamIdToTimestampMsLocal(id);
      if (ts !== null) {
        const age = now - ts;
        if (age > maxAgeMs) maxAgeMs = age;
      }
    }
  }
  if (maxAgeMs > 250) {
    console.warn(
      `[PERF] hot_path_consumer_slow_read component=workflow-task-progress-consumer ` +
        `xreadElapsedMs=${String(xreadElapsedMs)} blockMs=${String(PROGRESS_BLOCK_MS)} ` +
        `entriesRead=${String(totalEntries)} messageAgeMsMax=${String(maxAgeMs)} ` +
        `streams=${String(streams.length)}`,
    );
  }

  // Step 3: parse each delivered batch into WorkflowTaskSurfaceUpdate
  // payloads + fan out via emitWorkflowProgress. The `tenantId` carried
  // in each event's fields routes the fan-out — the consumer is global,
  // emitWorkflowProgress is per-tenant.
  //
  // Cursor advancement is conditional on successful fan-out (Phase 3
  // review fix): malformed events advance because retrying them won't
  // change the outcome; fan-out failures leave the cursor unmoved and
  // break out of THIS stream's batch so the next iteration retries
  // from the failed entry. Other streams' batches continue to be
  // processed in the outer loop.
  let totalEmitted = 0;
  // Coalesced per run and channel. A wake is a signal and the reader answers it
  // by reading the whole buffer, so a burst of appended lines needs exactly one
  // — and the fan-out it skips is two indexed queries apiece.
  const wakes = new Map<string, { tenantId: string; runId: string; channel: LiveDeltaChannel }>();
  for (const [streamKey, entries] of result as Array<[string, Array<[string, string[]]>]>) {
    for (const [eventId, fieldPairs] of entries) {
      const fields = parseFieldPairs(fieldPairs);
      const tenantId = fields['tenantId'];
      const wake = decodeLiveDeltaWake(fields);
      if (wake) {
        if (tenantId) {
          wakes.set(`${tenantId}\u0000${wake.runId}\u0000${wake.channel}`, {
            tenantId,
            runId: wake.runId,
            channel: wake.channel,
          });
          totalEmitted += 1;
        }
        cursors.set(streamKey, eventId);
        continue;
      }
      const event = decodeProgressEvent(fields);
      if (!tenantId || !event) {
        // Malformed / missing required field — safe to advance cursor.
        // Retrying won't yield a different shape, and we'd otherwise
        // loop forever on the same broken entry.
        cursors.set(streamKey, eventId);
        continue;
      }
      try {
        await emitWorkflowProgress(deps, {
          tenantId,
          runId: event.payload.runId,
          event,
        });
        cursors.set(streamKey, eventId);
        totalEmitted += 1;
      } catch (err) {
        // Don't advance the cursor — the next iteration retries this
        // entry. Break out of this stream's batch so we don't keep
        // hammering downstream events (which might depend on the
        // failed one). The outer iteration loop continues processing
        // OTHER streams' batches normally.
        console.warn(
          `[workflowTaskProgressConsumer] fan-out failed runId=${event.payload.runId} taskId=${event.payload.taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
    }
  }
  for (const wake of wakes.values()) {
    await publishWorkflowLiveDeltaWake(deps, wake).catch((err: unknown) => {
      console.warn(
        `[workflowTaskProgressConsumer] live-delta wake failed runId=${wake.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  return totalEmitted;
}

/**
 * Seed the index from the keyspace once at boot.
 *
 * Streams written before the index existed are in no one's index, so without
 * this their progress would simply stop being consumed on deploy. Bounded, runs
 * once per process, and a no-op once no such streams remain. Delete when no
 * deployment can still hold pre-index streams.
 */
export async function seedWorkflowTaskProgressIndex(redis: Redis): Promise<number> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const result = await redis.scan(
      cursor,
      'MATCH',
      'aflow:workflow_task_progress:*',
      'COUNT',
      '500',
    );
    cursor = result[0];
    found.push(...result[1]);
  } while (cursor !== '0');

  if (found.length > 0) {
    await redis.sadd(StreamKeys.workflowTaskProgressIndexKey, ...found);
  }
  return found.length;
}

/**
 * Drop index entries whose stream is gone. The producer adds on first emit and
 * task completion removes, but a task that dies between those leaves an entry
 * whose stream expires under its own TTL.
 */
export async function pruneWorkflowTaskProgressIndex(redis: Redis): Promise<number> {
  const members = await redis.smembers(StreamKeys.workflowTaskProgressIndexKey);
  if (members.length === 0) return 0;
  const pipeline = redis.pipeline();
  for (const key of members) pipeline.exists(key);
  const results = (await pipeline.exec()) ?? [];
  const stale = members.filter((_, i) => Number(results[i]?.[1] ?? 1) === 0);
  if (stale.length > 0) {
    await redis.srem(StreamKeys.workflowTaskProgressIndexKey, ...stale);
  }
  return stale.length;
}

function parseFieldPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    out[pairs[i]!] = pairs[i + 1]!;
  }
  return out;
}

/**
 * Decode one stream entry into a fan-out event. `eventType` selects the shape:
 * `WorkflowTaskActivity` (a live phase/proof-of-life signal an OPERATION task
 * emits from the executor — e.g. `code.agent.run`) vs the default
 * `WorkflowTaskSurfaceUpdate` (inline surface mutations). Both land on the same
 * reducer; activity needs no surface mutations.
 */
/**
 * The progress stream only carries per-task events (activity + surface), never
 * the run-level `WorkflowRunUpdate`, so the decoder's payload always has
 * `runId` + `taskId`.
 */
type DecodedProgressEvent = Extract<
  WorkflowProgressEvent,
  { kind: 'WorkflowTaskActivity' | 'WorkflowTaskSurfaceUpdate' }
>;

export function decodeProgressEvent(fields: Record<string, string>): DecodedProgressEvent | null {
  if (fields['eventType'] === 'WorkflowTaskActivity') {
    const payload = decodeActivityPayload(fields);
    return payload ? { kind: 'WorkflowTaskActivity', payload } : null;
  }
  const payload = decodePayload(fields);
  return payload ? { kind: 'WorkflowTaskSurfaceUpdate', payload } : null;
}

/**
 * The live-buffer wake, which is not a progress event and must never become one.
 *
 * It carries the step and the run rather than any content: the bytes stay in the
 * buffer the reader already knows how to read by step, so nothing about the
 * feed's size reaches this stream.
 */
export interface WorkflowTaskLiveDeltaWake {
  runId: string;
  taskId: string;
  stepExecutionId: string;
  channel: LiveDeltaChannel;
}

export function decodeLiveDeltaWake(
  fields: Record<string, string>,
): WorkflowTaskLiveDeltaWake | null {
  if (fields['eventType'] !== WORKFLOW_TASK_LIVE_DELTA_EVENT_TYPE) return null;
  const runId = fields['runId'];
  const taskId = fields['taskId'];
  const stepExecutionId = fields['stepExecutionId'];
  if (!runId || !taskId || !stepExecutionId) return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(fields['metadata'] ?? '{}');
  } catch {
    return null;
  }
  const raw =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>)['channel']
      : undefined;
  const channel = LiveDeltaChannelSchema.safeParse(raw);
  if (!channel.success) return null;
  return { runId, taskId, stepExecutionId, channel: channel.data };
}

/**
 * Activity payload from the flat XADD fields. `operationId / stepName /
 * stepDetail` ride in the `metadata` blob (that's how `ctx.emitWorkflowProgress`
 * carries them); an operation task has no worker session, so `workerSessionId`
 * is intentionally omitted.
 */
function decodeActivityPayload(fields: Record<string, string>): WorkflowTaskActivityPayload | null {
  const runId = fields['runId'];
  const taskId = fields['taskId'];
  if (!runId || !taskId) return null;
  const sequence = Number(fields['sequence'] ?? '0');
  if (!Number.isFinite(sequence) || sequence < 0) return null;
  let metadata: Record<string, unknown> = {};
  const raw = fields['metadata'];
  if (raw) {
    try {
      metadata = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const operationId = metadata['operationId'];
  if (typeof operationId !== 'string' || operationId.length === 0) return null;
  const stepName = typeof metadata['stepName'] === 'string' ? metadata['stepName'] : undefined;
  const stepDetail =
    typeof metadata['stepDetail'] === 'string' ? metadata['stepDetail'].slice(0, 200) : undefined;
  return {
    runId,
    taskId,
    operationId,
    sequence,
    ...(stepName ? { stepName } : {}),
    ...(stepDetail ? { stepDetail } : {}),
  };
}

function decodePayload(fields: Record<string, string>): WorkflowTaskSurfaceUpdatePayload | null {
  const runId = fields['runId'];
  const taskId = fields['taskId'];
  const stepExecutionId = fields['stepExecutionId'];
  const surfaceId = fields['surfaceId'];
  const mutationsRaw = fields['surfaceMutations'];
  const sequenceStr = fields['sequence'] ?? '0';
  if (!runId || !taskId || !stepExecutionId || !surfaceId || !mutationsRaw) {
    return null;
  }
  let mutations: Array<Record<string, unknown>>;
  try {
    mutations = JSON.parse(mutationsRaw) as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
  const sequence = Number(sequenceStr);
  if (!Number.isFinite(sequence) || sequence < 0) return null;
  return {
    runId,
    taskId,
    stepExecutionId: stepExecutionId as StepExecutionId,
    surfaceId,
    surfaceMutations: mutations,
    sequence,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
