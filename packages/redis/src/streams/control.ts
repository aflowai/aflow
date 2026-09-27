import type { Redis } from 'ioredis';
import { ControlMessageSchema, StreamKeys, type ControlMessage } from '@aflow/schemas';
import { shardFor } from '../shard.js';
import { serializeMessage } from './serialization.js';
import { armRetentionCandidate, firstReplyString } from './retention.js';
// ============================================================================
// Control Stream Operations (API → Orchestrator)
// ============================================================================

const START_RUN_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface StartRunIdempotencyClaim {
  claimed: boolean;
  /** The run the key was first claimed for; null when unreadable. */
  existingRunId: string | null;
}

/**
 * Claim a control-dispatch idempotency key before enqueuing the control
 * message. The orchestrator stores the key on the session but never checks it,
 * so dedupe exists only where the producer claims before enqueueing; producers
 * that skip the claim get no dedupe on their keys.
 *
 * `runId` is what a loser of the race gets back: the run the winner started, or
 * for a resume the session it resumed. A producer that regenerates its runId per
 * attempt therefore still recognises its own earlier dispatch.
 */
export async function claimControlDispatchIdempotency(
  redis: Redis,
  idempotencyKey: string,
  runId: string,
): Promise<StartRunIdempotencyClaim> {
  const key = controlDispatchIdempotencyKey(idempotencyKey);
  const wasSet = await redis.set(key, runId, 'EX', START_RUN_IDEMPOTENCY_TTL_SECONDS, 'NX');
  if (wasSet) {
    return { claimed: true, existingRunId: null };
  }
  return { claimed: false, existingRunId: await redis.get(key) };
}

/**
 * Give a claimed key back when the enqueue it was taken for did not happen.
 *
 * Compare-and-delete on the runId the caller claimed with: a claim it no longer
 * holds belongs to whatever dispatched next, and releasing that would let the
 * same request be enqueued twice.
 *
 * Only for a producer that can observe its own failure. A process killed
 * between the claim and the enqueue leaves the key held, and its request is
 * dropped rather than duplicated — which is the direction this whole rail
 * chooses.
 */
export async function releaseControlDispatchIdempotency(
  redis: Redis,
  idempotencyKey: string,
  runId: string,
): Promise<void> {
  await redis.eval(
    `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
     redis.call('DEL', KEYS[1])
     return 1`,
    1,
    controlDispatchIdempotencyKey(idempotencyKey),
    runId,
  );
}

function controlDispatchIdempotencyKey(idempotencyKey: string): string {
  return `aflow:idempotency:start_run:${idempotencyKey}`;
}

/**
 * Add a control message to the shard-scoped control stream.
 * Routes to aflow:shard:{shardId}:control based on runId.
 */
export async function addControlMessage(redis: Redis, message: ControlMessage): Promise<string> {
  const validated = ControlMessageSchema.parse(message);
  const fields = serializeMessage(validated);
  const shardId = shardFor(validated.runId);
  const streamKey = StreamKeys.shardControlStream(shardId);
  const pipeline = redis.pipeline().xadd(streamKey, '*', ...fields);
  armRetentionCandidate(pipeline, streamKey);
  const messageId = firstReplyString(await pipeline.exec());
  if (messageId === null) {
    throw new Error('Failed to add control message to stream');
  }
  return messageId;
}

/**
 * Tell whichever executor is running this step to abort it.
 *
 * A step execution is reachable directly, without going through the session it
 * may or may not belong to — which is the only route to a WORKFLOW OPERATION
 * task, whose `workerSessionId` IS its step execution id and which has no
 * session for a control message to address.
 *
 * Strictly best-effort, including against a synchronous throw: callers use this
 * alongside the durable cancellation path, and a failure to reach a live
 * executor must never abort the bookkeeping that actually terminates the run.
 */
export function publishStepAbort(redis: Redis, stepExecutionId: string, reason: string): void {
  try {
    void redis.publish(StreamKeys.stepAbortChannel(stepExecutionId), reason).catch(() => undefined);
  } catch {
    // Nothing to do — the caller's durable path is what guarantees the outcome.
  }
}

/**
 * How long a cancellation record outlives the cancel. It only has to cover the
 * gap between cancelling and the executor reaching the job, and a code step's own
 * outer cap is ~31 minutes, so an hour clears the longest queue wait with room to
 * spare. Bounded so cancelled ids cannot accumulate in Redis forever.
 */
const STEP_CANCELLED_TTL_SECONDS = 3600;

/**
 * Durably record that a step attempt was cancelled, so an executor that never saw
 * the abort still refuses to run it.
 *
 * The counterpart to `publishStepAbort`: Pub/Sub reaches a step already running,
 * this reaches one that has not started. A workflow OPERATION task needs it most —
 * `processJob` writes no step state for a job without a `sessionId`, so the
 * stale-attempt fence that backstops session-backed steps reads nothing and fails
 * open, and a cancelled ledger row could still be followed by a container start.
 *
 * Best-effort by design: the caller's durable ledger write is what makes the run
 * cancelled. A failure here costs the backstop, never the cancellation.
 */
export async function markStepCancelled(
  redis: Redis,
  stepExecutionId: string,
  attempt: number,
  reason: string,
): Promise<void> {
  try {
    await redis.set(
      StreamKeys.stepCancelledKey(stepExecutionId, attempt),
      reason,
      'EX',
      STEP_CANCELLED_TTL_SECONDS,
    );
  } catch {
    // Nothing to do — Pub/Sub and the ledger both remain.
  }
}

/** True when this exact step attempt was cancelled before the executor reached it. */
export async function wasStepCancelled(
  redis: Redis,
  stepExecutionId: string,
  attempt: number,
): Promise<boolean> {
  try {
    return (await redis.exists(StreamKeys.stepCancelledKey(stepExecutionId, attempt))) === 1;
  } catch {
    // Fail OPEN: a Redis blip must never stop a job that was not cancelled.
    return false;
  }
}
