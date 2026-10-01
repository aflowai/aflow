/**
 * The wakeup of a session that started a run without waiting on it — no step
 * of it is parked, so the outcome arrives as an event on its conversation.
 */
import { createHash } from 'node:crypto';
import {
  appendSessionEvent,
  claimEventDrivenTurn,
  getSessionStateSafe,
  getStepState,
  mayWake,
  returnEventDrivenTurn,
  scheduleShardTimer,
  type SessionEvent,
  type SessionHotState,
  type StepHotState,
} from '@aflow/redis';
import { createTenantContext, eventLog, withTenantSchema } from '@aflow/database';
import {
  claimSessionWaiterDelivery,
  dispatchResume,
  rehydratePausedRun,
  resumeClaimsForStep,
  sessionWaiterDeliveryKey,
  type SessionWaiterReport,
} from '@aflow/cybernetic-runtime';
import type {
  OperationId,
  PayloadRef,
  SessionId,
  StepExecutionId,
  StepId,
  StepType,
  TenantId,
  TraceId,
  WorkflowRunWakeupEventMetadata,
} from '@aflow/schemas';
import { hasUnreadRunWakeups } from '../../SessionOrchestrator/helpers/runWakeups.js';
import type { HarnessDeps } from './types.js';

/**
 * How many turns per minute a session's own runs may start by reporting in.
 * Above it a wakeup still lands on the conversation, and the session is woken
 * at the next free slot if nothing has read it by then — so a skill that
 * pauses and resumes in a loop cannot keep the agent talking to itself.
 */
export const EVENT_DRIVEN_TURNS_PER_MINUTE = 4;

const EMPTY_RESUME_INPUT_REF = `inline:${Buffer.from('{}').toString('base64')}`;

/**
 * `read`: nothing is unread, so there is nothing to wake for. `deferred`: the
 * session is not resting at its prompt, and its next turn reads what landed.
 */
export type SessionWakeupDelivery = 'woke' | 'deferred' | 'rate_limited' | 'coalesced' | 'read';

/**
 * A wakeup's identity: the waiter it is owed to and what it reports.
 * RFC 4122-shaped so the event log's uuid column takes it; the same report
 * always reproduces the same event.
 */
export function runWakeupEventId(waiterId: string, deliveryKey: string): string {
  const digest = createHash('sha256').update(`run-wakeup:${waiterId}:${deliveryKey}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `recorded` is whether this call wrote the wakeup to the event log. False when
 * the delivery was already claimed, or when the event was already in the log —
 * either way someone else appended it, and appending it again would show it twice.
 */
export async function deliverSessionWakeup(
  deps: HarnessDeps,
  args: {
    tenantId: TenantId;
    sessionId: string;
    runId: string;
    waiterId: string;
    report: SessionWaiterReport;
    /** Stores the envelope under the wakeup's own id, so a repeat overwrites rather than adds. */
    storeEnvelope: (eventId: string) => Promise<PayloadRef>;
  },
): Promise<{ eventId: string; recorded: boolean; delivery: SessionWakeupDelivery }> {
  const { outcome } = args.report;
  const deliveryKey = sessionWaiterDeliveryKey(args.report);
  const eventId = runWakeupEventId(args.waiterId, deliveryKey);
  const envelopeRef = await args.storeEnvelope(eventId);

  const metadata: WorkflowRunWakeupEventMetadata = {
    runId: args.runId,
    outcome,
    waiterId: args.waiterId,
  };
  const event: SessionEvent = {
    eventId,
    eventType: 'WorkflowRunWakeup',
    timestamp: Date.now(),
    sessionId: args.sessionId,
    outputRef: envelopeRef,
    metadata,
  };

  // The claim and the durable event commit together: a crash between them can
  // neither record a delivery that never landed nor land one twice. The turn
  // builder reads wakeups from this log rather than the hot stream, which is
  // flushed only when the session next rests — for a session mid-turn, after
  // the turn that should have read this.
  const recorded = await withTenantSchema(
    deps.db,
    createTenantContext(args.tenantId),
    async (tx) => {
      const claimed = await claimSessionWaiterDelivery(tx, {
        waiterId: args.waiterId,
        report: args.report,
      });
      if (!claimed) return false;
      const inserted = await tx
        .insert(eventLog)
        .values({
          eventId,
          eventType: event.eventType,
          sessionId: args.sessionId,
          timestamp: new Date(event.timestamp),
          payloadRef: envelopeRef,
          idempotencyKey: `${eventId}:posted`,
          envelope: event,
        })
        .onConflictDoNothing()
        .returning({ eventId: eventLog.eventId });
      return inserted.length > 0;
    },
  );

  const stateResult = await getSessionStateSafe(deps.redis, args.tenantId, args.sessionId);
  const hot = stateResult.ok
    ? stateResult.state
    : await rehydratePausedRun(deps.redis, deps.db, args.tenantId, args.sessionId);

  if (recorded && hot) {
    await appendSessionEvent(deps.redis, args.tenantId, args.sessionId as SessionId, event);
  }
  if (!hot) return { eventId, recorded, delivery: 'deferred' };
  const delivery = await wakeSessionForRunWakeups(deps, args.tenantId, args.sessionId, hot);
  return { eventId, recorded, delivery };
}

/**
 * Start a turn for a session resting at its prompt with run wakeups it has not
 * read, the way a room message sent with `wake` does. Anything else — a turn
 * in flight, a step parked on a child, an approval — reads them at its next
 * turn boundary instead, and settling there calls this again.
 */
export async function wakeSessionForRunWakeups(
  deps: HarnessDeps,
  tenantId: TenantId,
  sessionId: string,
  knownState?: SessionHotState,
): Promise<SessionWakeupDelivery> {
  let state = knownState;
  if (state === undefined) {
    const stateResult = await getSessionStateSafe(deps.redis, tenantId, sessionId);
    if (!stateResult.ok) return 'deferred';
    state = stateResult.state;
  }
  const stepExecutionId = state.currentStepExecutionId;
  const step = stepExecutionId ? await getStepState(deps.redis, tenantId, stepExecutionId) : null;
  if (!stepExecutionId || !step || !mayWake(state, step)) return 'deferred';

  if (
    !(await hasUnreadRunWakeups(deps.db, deps.payloadStore, tenantId, sessionId, step.inputRef))
  ) {
    return 'read';
  }

  // One wake per pause: wakeups landing together start one turn, which reads
  // them all.
  const wakeKey = `event-wake:${stepExecutionId}`;
  const resume = {
    tenantId,
    sessionId: sessionId as SessionId,
    stepExecutionId: stepExecutionId as StepExecutionId,
    inputRef: EMPTY_RESUME_INPUT_REF,
    idempotencyKey: wakeKey,
    traceId: (state.traceId !== undefined && state.traceId.length > 0
      ? state.traceId
      : wakeKey) as TraceId,
  };

  const claims = await resumeClaimsForStep(deps.db, { tenantId, sessionId, stepExecutionId });
  if (claims.length > 0) {
    // Someone is already advancing this boundary. When it is this wake's own
    // claim, sending again is what recovers one that crashed before its send.
    if (claims.includes(wakeKey)) await dispatchResume(deps.db, deps.redis, resume);
    return 'coalesced';
  }

  const slot = await claimEventDrivenTurn(
    deps.redis,
    tenantId,
    sessionId,
    EVENT_DRIVEN_TURNS_PER_MINUTE,
  );
  if (!slot.taken) {
    await armEventWakeTimer(deps, tenantId, sessionId, state, step, slot.nextSlotAtMs);
    return 'rate_limited';
  }

  const { firstSeen } = await dispatchResume(deps.db, deps.redis, resume);
  if (!firstSeen) {
    await returnEventDrivenTurn(deps.redis, tenantId, sessionId);
    return 'coalesced';
  }
  return 'woke';
}

/**
 * Arm the session's next event-driven slot. A timer's id is its step and
 * reason, so wakeups deferred on the same pause share one timer.
 */
async function armEventWakeTimer(
  deps: HarnessDeps,
  tenantId: TenantId,
  sessionId: string,
  state: SessionHotState,
  step: StepHotState,
  dueAtMs: number,
): Promise<void> {
  await scheduleShardTimer(deps.redis, {
    tenantId,
    sessionId: sessionId as SessionId,
    stepExecutionId: step.stepExecutionId as StepExecutionId,
    stepId: step.stepId as StepId,
    operationId: step.operationId as OperationId,
    stepType: step.stepType as StepType,
    reason: 'event_wake',
    attempt: step.attempt,
    inputRef: EMPTY_RESUME_INPUT_REF,
    traceId: (state.traceId !== undefined && state.traceId.length > 0
      ? state.traceId
      : `event-wake:${step.stepExecutionId}`) as TraceId,
    dueAtMs,
  });
}
