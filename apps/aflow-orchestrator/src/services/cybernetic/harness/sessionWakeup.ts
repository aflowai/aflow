/**
 * The wakeup of a session that started a run without waiting on it — no step
 * of it is parked, so the outcome arrives as an event on its conversation.
 */
import { randomUUID } from 'node:crypto';
import {
  addControlMessage,
  appendSessionEvent,
  claimControlDispatchIdempotency,
  claimEventDrivenTurn,
  getSessionStateSafe,
  getStepState,
  mayWake,
  releaseControlDispatchIdempotency,
  type SessionEvent,
  type SessionHotState,
} from '@aflow/redis';
import { createTenantContext, eventLog, withTenantSchema } from '@aflow/database';
import { rehydratePausedRun } from '@aflow/cybernetic-runtime';
import type {
  IdempotencyKey,
  PayloadRef,
  SessionId,
  StepExecutionId,
  TenantId,
  TraceId,
  WaiterNotifiedOutcome,
  WorkflowRunWakeupEventMetadata,
} from '@aflow/schemas';
import type { HarnessDeps } from './types.js';

/**
 * How many turns per minute a session's own runs may start by reporting in.
 * Above it a wakeup still lands on the conversation and is read at the next
 * turn; it just does not start one — so a skill that pauses and resumes in a
 * loop cannot keep the agent talking to itself.
 */
export const EVENT_DRIVEN_TURNS_PER_MINUTE = 4;

const EMPTY_RESUME_INPUT_REF = `inline:${Buffer.from('{}').toString('base64')}`;

export type SessionWakeupDelivery = 'woke' | 'deferred' | 'rate_limited' | 'coalesced';

export async function deliverSessionWakeup(
  deps: HarnessDeps,
  args: {
    tenantId: TenantId;
    sessionId: string;
    runId: string;
    waiterId: string;
    outcome: WaiterNotifiedOutcome;
    envelopeRef: PayloadRef;
  },
): Promise<{ eventId: string; delivery: SessionWakeupDelivery }> {
  const stateResult = await getSessionStateSafe(deps.redis, args.tenantId, args.sessionId);
  const hot = stateResult.ok
    ? stateResult.state
    : await rehydratePausedRun(deps.redis, deps.db, args.tenantId, args.sessionId);

  const metadata: WorkflowRunWakeupEventMetadata = {
    runId: args.runId,
    outcome: args.outcome,
    waiterId: args.waiterId,
  };
  const event: SessionEvent = {
    eventId: randomUUID(),
    eventType: 'WorkflowRunWakeup',
    timestamp: Date.now(),
    sessionId: args.sessionId,
    outputRef: args.envelopeRef,
    metadata,
  };

  if (hot) {
    await appendSessionEvent(deps.redis, args.tenantId, args.sessionId as SessionId, event);
  }
  // The turn builder reads wakeups from the durable log, and a hot stream is
  // flushed only when the session next rests — which, for a session mid-turn,
  // is after the turn that should have read this.
  await withTenantSchema(deps.db, createTenantContext(args.tenantId), async (tx) => {
    await tx
      .insert(eventLog)
      .values({
        eventId: event.eventId,
        eventType: event.eventType,
        sessionId: args.sessionId,
        timestamp: new Date(event.timestamp),
        payloadRef: args.envelopeRef,
        idempotencyKey: `${event.eventId}:posted`,
        envelope: event,
      })
      .onConflictDoNothing();
  });

  if (!hot) return { eventId: event.eventId, delivery: 'deferred' };
  const delivery = await wakeIdleSession(deps, args.tenantId, args.sessionId, hot);
  return { eventId: event.eventId, delivery };
}

/**
 * Start a turn for a session resting at its prompt, the way a room message
 * sent with `wake` does. Anything else — a turn in flight, a step parked on a
 * child, an approval — reads the wakeup at its next turn boundary instead.
 */
async function wakeIdleSession(
  deps: HarnessDeps,
  tenantId: TenantId,
  sessionId: string,
  state: SessionHotState,
): Promise<SessionWakeupDelivery> {
  const stepExecutionId = state.currentStepExecutionId;
  const step = stepExecutionId ? await getStepState(deps.redis, tenantId, stepExecutionId) : null;
  if (!stepExecutionId || !mayWake(state, step)) return 'deferred';

  if (
    !(await claimEventDrivenTurn(deps.redis, tenantId, sessionId, EVENT_DRIVEN_TURNS_PER_MINUTE))
  ) {
    return 'rate_limited';
  }

  // One wake per pause: wakeups landing together start one turn, which reads
  // them all.
  const idempotencyKey = `event-wake:${stepExecutionId}`;
  const claim = await claimControlDispatchIdempotency(deps.redis, idempotencyKey, sessionId);
  if (!claim.claimed) return 'coalesced';

  try {
    await addControlMessage(deps.redis, {
      messageVersion: 1,
      type: 'resume_run',
      tenantId,
      runId: sessionId as SessionId,
      stepExecutionId: stepExecutionId as StepExecutionId,
      inputRef: EMPTY_RESUME_INPUT_REF,
      traceId: (state.traceId !== undefined && state.traceId.length > 0
        ? state.traceId
        : idempotencyKey) as TraceId,
      idempotencyKey: idempotencyKey as IdempotencyKey,
      requestedAtMs: Date.now(),
    });
  } catch (err) {
    await releaseControlDispatchIdempotency(deps.redis, idempotencyKey, sessionId);
    throw err;
  }
  return 'woke';
}
