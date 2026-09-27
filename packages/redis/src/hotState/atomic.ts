import type { ChainableCommander, Redis } from 'ioredis';
import { LiveDeltaChannelSchema, StreamKeys, type RecoveryEventEnvelope } from '@aflow/schemas';
import { appendRecoveryEventsToPipeline } from '../recoveryStream.js';
import type { SessionHotState, StepHotState, SessionEvent } from './schemas.js';
import { HOT_STATE_TTL_SECONDS } from './schemas.js';
import {
  serializeForHash,
  serializeForHashWithDeletes,
  serializeForStream,
} from './serialization.js';
import { sessionWakePayload } from './events.js';
import { markProjectionCandidate } from './projectionCandidates.js';
import { sessionCandidateMember } from './candidateMember.js';
import { syncQueuedSessionCandidate } from './queuedSessionCandidates.js';
import {
  syncStepStallCandidateForSession,
  syncStepStallCandidateForStep,
} from './stepStallCandidates.js';
import { syncDelegationSupervisionCandidate } from './delegationSupervisionCandidates.js';
import { syncSessionMetadataCandidate } from './sessionMetadataCandidates.js';

/**
 * Arm every session-keyed index from inside the pipeline the caller already
 * has.
 *
 * These writers do not go through `markSessionDirty` or `updateStepState` —
 * they batch a whole state transition into one round trip — so the arming is
 * reproduced here and must stay in step with them. This is the ordinary run
 * path: a transition it fails to arm is invisible to every worker that
 * discovers work through these indexes, and nothing reports the gap.
 *
 * The step clear is applied before the session clear so that a transition
 * writing an active step onto a session that is leaving RUNNING settles on
 * "not a candidate" — the readers skip a non-RUNNING session whatever its step
 * hash says, so a member left armed there would be re-read forever.
 */
function armSessionIndexesInPipeline(
  pipeline: ChainableCommander,
  tenantId: string,
  runId: string,
  step: Partial<StepHotState> | undefined,
  runUpdates: Partial<SessionHotState>,
  nowMs: number,
): void {
  markProjectionCandidate(pipeline, sessionCandidateMember(tenantId, runId));
  syncQueuedSessionCandidate(
    pipeline,
    tenantId,
    runId,
    runUpdates.status,
    runUpdates.createdAt,
    nowMs,
  );
  if (step) syncStepStallCandidateForStep(pipeline, tenantId, runId, step, nowMs);
  syncStepStallCandidateForSession(pipeline, tenantId, runId, runUpdates.status);
  syncDelegationSupervisionCandidate(pipeline, tenantId, runId, runUpdates.status, nowMs);
  syncSessionMetadataCandidate(pipeline, tenantId, runId, runUpdates.lastActivityAt, nowMs);
}
// ============================================================================
// Atomic Operations (MULTI/EXEC)
// ============================================================================

export async function atomicCreateSession(
  redis: Redis,
  run: SessionHotState,
  step: StepHotState,
  startEvent: SessionEvent,
  stepEvent: SessionEvent,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
  recoveryEvents?: RecoveryEventEnvelope[],
): Promise<void> {
  const runKey = StreamKeys.sessionStateKey(run.tenantId, run.sessionId);
  const stepKey = StreamKeys.stepStateKey(step.tenantId, step.stepExecutionId);
  const eventsKey = StreamKeys.sessionEventsStream(run.tenantId, run.sessionId);

  // MULTI, not a pipeline: this rewrites a state hash as DEL then HSET, and a
  // pipeline lets a concurrent read land between them and see the session or
  // step as gone. Readers treat absence as a fact worth acting on.
  const pipeline = redis.multi();

  // Set run state
  pipeline.del(runKey);
  pipeline.hset(runKey, serializeForHash(run));
  pipeline.expire(runKey, ttlSeconds);

  // Set step state
  pipeline.del(stepKey);
  pipeline.hset(stepKey, serializeForHash(step));
  pipeline.expire(stepKey, ttlSeconds);

  // Append UI events
  pipeline.xadd(eventsKey, 'MAXLEN', '~', '1000', '*', ...serializeForStream(startEvent));
  pipeline.xadd(eventsKey, 'MAXLEN', '~', '1000', '*', ...serializeForStream(stepEvent));
  pipeline.expire(eventsKey, ttlSeconds);

  armSessionIndexesInPipeline(pipeline, run.tenantId, run.sessionId, step, run, Date.now());

  if (recoveryEvents && recoveryEvents.length > 0) {
    appendRecoveryEventsToPipeline(
      pipeline,
      run.tenantId,
      run.sessionId,
      recoveryEvents,
      ttlSeconds,
    );
  }

  // The wake rides the transaction that wrote the events. Published after it,
  // it can be lost on its own — leaving durable events no subscriber is told
  // about, found only by a periodic re-read.
  pipeline.publish(
    StreamKeys.pubsubChannel(run.tenantId, run.sessionId),
    sessionWakePayload(run.sessionId, startEvent.eventType),
  );

  await pipeline.exec();
}

export async function atomicCompleteStep(
  redis: Redis,
  tenantId: string,
  stepUpdates: Partial<StepHotState> & { stepExecutionId: string },
  runUpdates: Partial<SessionHotState> & { sessionId: string },
  event: SessionEvent | SessionEvent[],
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
  recoveryEvents?: RecoveryEventEnvelope[],
): Promise<void> {
  const runKey = StreamKeys.sessionStateKey(tenantId, runUpdates.sessionId);
  const stepKey = StreamKeys.stepStateKey(tenantId, stepUpdates.stepExecutionId);
  const eventsKey = StreamKeys.sessionEventsStream(tenantId, runUpdates.sessionId);

  // A transaction, not a pipeline: the wake published below has to land with
  // the events it announces or not at all.
  const pipeline = redis.multi();

  // Update step state — HSET set fields, HDEL cleared fields (undefined)
  {
    const { toSet, toDelete } = serializeForHashWithDeletes({ ...stepUpdates });
    if (Object.keys(toSet).length > 0) pipeline.hset(stepKey, toSet);
    if (toDelete.length > 0) pipeline.hdel(stepKey, ...toDelete);
    pipeline.expire(stepKey, ttlSeconds);
  }

  // Update run state — HSET set fields, HDEL cleared fields (undefined).
  {
    const { toSet, toDelete } = serializeForHashWithDeletes({
      ...runUpdates,
      lastUpdatedAt: Date.now(),
    });
    if (Object.keys(toSet).length > 0) pipeline.hset(runKey, toSet);
    if (toDelete.length > 0) pipeline.hdel(runKey, ...toDelete);
    pipeline.expire(runKey, ttlSeconds);
  }

  // Append UI event(s) — supports single event or array for atomic multi-event writes
  const events = Array.isArray(event) ? event : [event];
  for (const evt of events) {
    pipeline.xadd(eventsKey, 'MAXLEN', '~', '1000', '*', ...serializeForStream(evt));
  }
  pipeline.expire(eventsKey, ttlSeconds);

  // The step is finished, so its live streaming buffer has no reader left: the
  // terminal event in this same pipeline is what a client promotes the streamed
  // text into. Dropping it here — rather than in the executor when the model
  // stream ends — is what avoids a blank gap between the two.
  pipeline.del(
    ...LiveDeltaChannelSchema.options.map((channel) =>
      StreamKeys.liveStreamBuffer(tenantId, stepUpdates.stepExecutionId, channel),
    ),
  );

  armSessionIndexesInPipeline(
    pipeline,
    tenantId,
    runUpdates.sessionId,
    stepUpdates,
    runUpdates,
    Date.now(),
  );

  if (recoveryEvents && recoveryEvents.length > 0) {
    appendRecoveryEventsToPipeline(
      pipeline,
      tenantId,
      runUpdates.sessionId,
      recoveryEvents,
      ttlSeconds,
    );
  }

  const lastEvent = events[events.length - 1];
  if (lastEvent) {
    pipeline.publish(
      StreamKeys.pubsubChannel(tenantId, runUpdates.sessionId),
      sessionWakePayload(runUpdates.sessionId, lastEvent.eventType),
    );
  }

  await pipeline.exec();
}

export async function atomicScheduleStep(
  redis: Redis,
  tenantId: string,
  runId: string,
  step: StepHotState,
  runUpdates: Partial<SessionHotState>,
  event: SessionEvent,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
  recoveryEvents?: RecoveryEventEnvelope[],
): Promise<void> {
  const runKey = StreamKeys.sessionStateKey(tenantId, runId);
  const stepKey = StreamKeys.stepStateKey(tenantId, step.stepExecutionId);
  const eventsKey = StreamKeys.sessionEventsStream(tenantId, runId);

  // MULTI, not a pipeline: this rewrites a state hash as DEL then HSET, and a
  // pipeline lets a concurrent read land between them and see the session or
  // step as gone. Readers treat absence as a fact worth acting on.
  const pipeline = redis.multi();

  // Set new step state (full replace — DEL + HSET, no partial-update semantics)
  pipeline.del(stepKey);
  pipeline.hset(stepKey, serializeForHash(step));
  pipeline.expire(stepKey, ttlSeconds);

  // Update run state — HSET set fields, HDEL cleared fields (undefined).
  {
    const { toSet, toDelete } = serializeForHashWithDeletes({
      ...runUpdates,
      lastUpdatedAt: Date.now(),
    });
    if (Object.keys(toSet).length > 0) pipeline.hset(runKey, toSet);
    if (toDelete.length > 0) pipeline.hdel(runKey, ...toDelete);
    pipeline.expire(runKey, ttlSeconds);
  }

  // Append UI event
  pipeline.xadd(eventsKey, 'MAXLEN', '~', '1000', '*', ...serializeForStream(event));
  pipeline.expire(eventsKey, ttlSeconds);

  armSessionIndexesInPipeline(pipeline, tenantId, runId, step, runUpdates, Date.now());

  if (recoveryEvents && recoveryEvents.length > 0) {
    appendRecoveryEventsToPipeline(pipeline, tenantId, runId, recoveryEvents, ttlSeconds);
  }

  pipeline.publish(
    StreamKeys.pubsubChannel(tenantId, runId),
    sessionWakePayload(runId, event.eventType),
  );

  await pipeline.exec();
}
