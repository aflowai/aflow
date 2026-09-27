import type { Redis } from 'ioredis';
import {
  addStepResult,
  appendSessionEvent,
  claimDuePendingDelegations,
  completeDelegationLifecycle,
  abortDelegationLifecycle,
  releasePendingDelegation,
  releasePendingDelegationAfterEscalation,
  getDelegationParent,
  getSessionState,
  getStepState,
  markSessionDirty,
  updateStepState,
  type ClaimedDelegation,
  type SessionEvent,
} from '@aflow/redis';
import type {
  AgentDefinition,
  IdempotencyKey,
  OperationId,
  StepExecutionId,
  StepId,
  StepType,
  TenantId,
  TraceId,
  SessionAgentTarget,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { createBackgroundTaskRunner } from '@aflow/lib';
import { backgroundTaskControlPlane } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { reconcileParentDelegationForChild } from './reconcileParentDelegation.js';

// ============================================================================
// Tunable constants (Open Questions 1-3 in plan 131)
// ============================================================================

// ─── Tunables ────────────────────────────────────────────────────────
//
// The drain is a backstop, NOT the primary cascade mechanism. The eager
// `reconcileParentDelegationForChild` call inside `enqueuePendingAndReconcile`
// handles the happy path within milliseconds. The drain only matters
// when that path drops AND didn't self-heal — a rare condition. Defaults
// therefore favor patience over fast detection: a false escalation
// fabricates a "session failed" on a healthy chain (high cost), while a
// late escalation just delays visibility for a few minutes (low cost).
//
// Time-to-visible-failure for a truly stuck cascade with these defaults:
//   30s × 10 attempts = ~5 minutes before escalation
//
// Real-world delays the drain must tolerate WITHOUT escalating:
//   - applyResult batched behind heavy result-stream traffic
//   - GCS payload-store fetches under load
//   - resultConsumer concurrency limits (default maxConcurrent: 50)
//   - LLM generation stalls inside post-cascade agent turns
// All of these can run tens of seconds in production; the drain must
// not interpret them as "stuck."

/** Drain tick interval in milliseconds. */
export const DELEGATION_DRAIN_TASK_ID = 'orchestrator.delegation_pending';

export const DEFAULT_DRAIN_INTERVAL_MS = 30_000;
/** Lease duration: how long a claim lives before it can be reclaimed. */
export const DEFAULT_LEASE_MS = 60_000;
/** Max entries claimed per drain tick. */
export const DEFAULT_BATCH_SIZE = 50;
/** Number of retry attempts before escalating to a visible failure. */
export const DEFAULT_MAX_ATTEMPTS = 10;
/** Flat backoff between retries (ms). */
export const DEFAULT_BACKOFF_MS = 30_000;
/**
 * Backoff after an escalation tick, before the drain re-checks whether
 * the synthetic FAILED has been applied to the parent step. Longer than
 * the retry backoff so applyResult has time to land.
 */
export const DEFAULT_POST_ESCALATION_BACKOFF_MS = 60_000;
/**
 * Cap on escalation tries. After this many synthetic-FAILED injections
 * have failed to land on the parent step, fall through to `failRun` on
 * the parent session unconditionally and clear the lifecycle.
 */
export const DEFAULT_MAX_ESCALATIONS = 3;

// ============================================================================
// Types
// ============================================================================

type AgentDefLoader = (
  tenantId: string,
  target: SessionAgentTarget,
  agentVersion: string,
) => Promise<AgentDefinition>;

export interface DrainPendingDelegationsDeps {
  redis: Redis;
  payloadStore: PayloadStore;
  agentDefLoader: AgentDefLoader;
  /** Override worker id for telemetry. Defaults to a per-process id. */
  workerId?: string;
}

export interface DrainPendingDelegationsConfig {
  intervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  backoffMs?: number;
  /** Backoff after an escalation tick — longer than `backoffMs` so applyResult has time to land. */
  postEscalationBackoffMs?: number;
  /** Cap on synthetic-FAILED injections that fail to land before falling through to failRun. */
  maxEscalations?: number;
}

export interface DrainPassResult {
  claimed: number;
  completed: number;
  retried: number;
  escalated: number;
  /** Hit maxEscalations and fell through to failRun + complete. */
  escalation_capped: number;
  aborted: number;
  unresolvable: number;
}

const PROCESS_WORKER_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ============================================================================
// "Done" check (plan 131 §"Done" check)
// ============================================================================

interface DoneCheckInputs {
  childRunId: string;
  parentStepStatus: string | undefined;
  parentSessionStatus: string | undefined;
  parentDelegationPauseSource: string | undefined;
  parentRequestedInputRef: string | undefined;
  parentPausedChildSessionId: string | undefined;
}

/**
 * Has the parent's delegate step been observed terminal? Returns one of:
 *   - 'done': parent step SUCCEEDED/FAILED, OR PAUSED with the parent
 *      session showing a bubbled child-input pause specifically for
 *      THIS child (matched on `pausedChildSessionId` + non-empty
 *      `requestedInputRef`). Lifecycle can be cleared.
 *   - 'pending': parent step still in flight, or PAUSED but the bubble
 *      is for a different child or hasn't been fully applied yet.
 *      Reconcile + retry.
 *
 * Why the strict bubble checks: a parent with multiple delegations may
 * have an OTHER child's bubbled pause already applied (its own
 * lifecycle entry). If we accept any `delegationPauseSource='child_input'`
 * as "done" without matching ids, we'd prematurely clear THIS lifecycle
 * and reopen the silent-cascade-drop class.
 */
function evaluateDone(inputs: DoneCheckInputs): 'done' | 'pending' {
  const {
    childRunId,
    parentStepStatus,
    parentSessionStatus,
    parentDelegationPauseSource,
    parentRequestedInputRef,
    parentPausedChildSessionId,
  } = inputs;
  if (parentStepStatus === 'SUCCEEDED' || parentStepStatus === 'FAILED') return 'done';
  if (
    parentStepStatus === 'PAUSED' &&
    parentSessionStatus === 'PAUSED' &&
    parentDelegationPauseSource === 'child_input' &&
    parentPausedChildSessionId === childRunId &&
    parentRequestedInputRef !== undefined &&
    parentRequestedInputRef !== ''
  ) {
    return 'done';
  }
  return 'pending';
}

// ============================================================================
// Escalation (plan 131 §"Escalation")
// ============================================================================

/**
 * Attempt 1: inject a synthetic FAILED step result on the parent's
 * delegate step. Preserves the parent session — onFailure routing fires
 * normally. Mirrors `resumeParentOnChildComplete`'s "unpause first"
 * invariant: if the parent step is PAUSED/SCHEDULED, transition to
 * STARTED before the synthetic result so applyResult's terminal-step
 * guard doesn't drop it.
 *
 * Returns true on success, false if the step is missing or is already
 * in an unrecoverable state — caller should fall back to failRun.
 */
async function injectSyntheticFailure(args: {
  redis: Redis;
  tenantId: string;
  parentRunId: string;
  parentStepExecutionId: string;
  childRunId: string;
  code: string;
  message: string;
  attempt: number;
}): Promise<boolean> {
  const {
    redis,
    tenantId,
    parentRunId,
    parentStepExecutionId,
    childRunId,
    code,
    message,
    attempt,
  } = args;
  const stepState = await getStepState(redis, tenantId, parentStepExecutionId);
  if (!stepState) {
    return false;
  }

  // Unpause invariant: applyResult drops results targeted at terminal
  // steps. SUCCEEDED/FAILED on the parent step means a sibling cascade
  // already advanced it — nothing more to do here, return true (no-op).
  if (stepState.status === 'SUCCEEDED' || stepState.status === 'FAILED') {
    return true;
  }
  if (stepState.status !== 'STARTED') {
    await updateStepState(redis, tenantId, parentStepExecutionId, {
      sessionId: parentRunId,
      status: 'STARTED',
    });
  }

  const now = Date.now();
  const errorPayload = {
    code,
    message,
    classification: 'internal' as const,
    retryable: false,
    timestamp: new Date(now).toISOString(),
    childSessionId: childRunId,
    delegationLifecycleAttempt: attempt,
  };
  const errorRef = `inline:${Buffer.from(JSON.stringify(errorPayload)).toString('base64')}`;

  // Branded types (TenantId/SessionId/StepExecutionId/etc.) — cast via
  // `as unknown as <Branded>` since at runtime these are strings; the
  // upstream addStepResult validation runs the brand check on receive.
  // TraceId must be non-empty (TraceIdSchema.min(1)). Step state has no
  // traceId field; fall back to parent session's traceId, then to a
  // synthesized non-empty value derived from the step id.
  const parentForTrace = await getSessionState(redis, tenantId, parentRunId);
  const traceId = (parentForTrace?.traceId ??
    `delegation-drain:${parentStepExecutionId}`) as TraceId;
  await addStepResult(redis, {
    messageVersion: 1,
    tenantId: tenantId as TenantId,
    sessionId: parentRunId as unknown as Parameters<typeof addStepResult>[1]['sessionId'],
    stepExecutionId: parentStepExecutionId as unknown as StepExecutionId,
    parentStepExecutionId: (stepState.parentStepExecutionId ?? null) as StepExecutionId | null,
    stepId: stepState.stepId as StepId,
    stepType: stepState.stepType as StepType,
    operationId: stepState.operationId as OperationId,
    attempt: stepState.attempt,
    idempotencyKey: `delegation-stall:${parentStepExecutionId}:${attempt}` as IdempotencyKey,
    status: 'FAILED',
    errorRef,
    error: errorPayload,
    resolvedInputRef: stepState.inputRef,
    durationMs: 0,
    traceId,
    finishedAtMs: now,
  });

  return true;
}

/**
 * Emit a `SessionStalled` event on the parent session so observers/UI
 * surface the cause clearly. Reusing the existing event type with a
 * `metadata.code` discriminator avoids schema/catalog/UI work.
 *
 * No-op when parentRunId is empty (the unresolvable case — telemetry
 * for that path uses structured logs only, not session events).
 */
async function emitParentStalledEvent(args: {
  redis: Redis;
  tenantId: string;
  parentRunId: string;
  childRunId: string;
  code: string;
  message: string;
}): Promise<void> {
  const { redis, tenantId, parentRunId, childRunId, code, message } = args;
  if (!parentRunId) return;
  const event: SessionEvent = {
    eventId: crypto.randomUUID(),
    eventType: 'SessionStalled',
    timestamp: Date.now(),
    sessionId: parentRunId,
    metadata: {
      code,
      message,
      childRunId,
      origin: 'delegation-lifecycle-drain',
    },
  };
  try {
    await appendSessionEvent(redis, tenantId as TenantId, parentRunId, event);
    await markSessionDirty(redis, tenantId as TenantId, parentRunId);
  } catch (err) {
    logOrchestratorError(
      `[delegation-drain] Failed to emit SessionStalled on parent ${parentRunId}:`,
      err,
      { tenantId, parentRunId, childRunId },
    );
  }
}

// ============================================================================
// Per-entry processing
// ============================================================================

interface ProcessEntryDeps extends DrainPendingDelegationsDeps {
  config: Required<DrainPendingDelegationsConfig>;
}

type EntryOutcome =
  | 'completed'
  | 'retried'
  | 'escalated'
  | 'escalation_capped' // hit maxEscalations → failRun fallback + complete
  | 'aborted'
  | 'unresolvable';

async function processEntry(
  deps: ProcessEntryDeps,
  entry: ClaimedDelegation,
): Promise<EntryOutcome> {
  const { redis, payloadStore, agentDefLoader, config } = deps;
  const { tenantId, childRunId, data } = entry;
  const log = getOrchestratorLogger().child({ component: 'delegation-drain' });

  // ── Resolve parent ids (pending data → reverse index → child hot state) ──

  let parentRunId = data.parentRunId;
  let parentStepExecutionId = data.parentStepExecutionId;

  if (!parentRunId || !parentStepExecutionId) {
    const rev = await getDelegationParent(redis, tenantId, childRunId);
    if (rev) {
      parentRunId = rev.parentRunId;
      parentStepExecutionId = rev.parentStepExecutionId;
    }
  }

  if (!parentRunId || !parentStepExecutionId) {
    const childState = await getSessionState(redis, tenantId, childRunId);
    if (childState?.parentSessionId && childState.parentStepExecutionId) {
      parentRunId = childState.parentSessionId;
      parentStepExecutionId = childState.parentStepExecutionId;
    }
  }

  if (!parentRunId || !parentStepExecutionId) {
    // Unresolvable. We don't have a session id to anchor a SessionStalled
    // event to; structured log + lifecycle abort. Manual recovery.
    log.error(
      `[delegation-drain] DELEGATION_PARENT_UNRESOLVABLE — pending data, reverse ` +
        `index, and child hot state all missing parent linkage. Aborting lifecycle ` +
        `entry; parent step (if any) cannot be advanced from here.`,
      undefined,
      {
        tenantId,
        childRunId,
        attempt: data.attempt,
        errorCode: 'DELEGATION_PARENT_UNRESOLVABLE',
      },
    );
    await abortDelegationLifecycle(redis, tenantId, childRunId);
    return 'unresolvable';
  }

  // ── Read parent step + session state ──

  const [parentStepState, parentSessionState] = await Promise.all([
    getStepState(redis, tenantId, parentStepExecutionId),
    getSessionState(redis, tenantId, parentRunId),
  ]);

  // ── "Done" check ──

  const doneVerdict = evaluateDone({
    childRunId,
    parentStepStatus: parentStepState?.status,
    parentSessionStatus: parentSessionState?.status,
    parentDelegationPauseSource: parentSessionState?.delegationPauseSource,
    parentRequestedInputRef: parentSessionState?.requestedInputRef,
    parentPausedChildSessionId: parentSessionState?.pausedChildSessionId,
  });
  if (doneVerdict === 'done') {
    await completeDelegationLifecycle(redis, tenantId, childRunId);
    log.debug(
      `[delegation-drain] complete tenant=${tenantId} child=${childRunId} parent=${parentRunId} ` +
        `step=${parentStepExecutionId} status=${parentStepState?.status ?? 'missing'}`,
    );
    return 'completed';
  }

  // ── Not done: re-fire reconcile (idempotent push), then re-check ──

  let reconcileOutcome: Awaited<ReturnType<typeof reconcileParentDelegationForChild>> | undefined;
  let lastError: string | undefined;
  try {
    reconcileOutcome = await reconcileParentDelegationForChild({
      redis,
      payloadStore,
      tenantId,
      childRunId,
      reason: `delegation-drain:attempt-${data.attempt + 1}`,
      agentDefLoader,
    });
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    log.warn(
      `[delegation-drain] reconcile threw tenant=${tenantId} child=${childRunId} ` +
        `parent=${parentRunId}: ${lastError}`,
    );
  }

  // Re-read step + session state — reconcile may have applied synchronously.
  const [parentStepState2, parentSessionState2] = await Promise.all([
    getStepState(redis, tenantId, parentStepExecutionId),
    getSessionState(redis, tenantId, parentRunId),
  ]);
  const doneVerdict2 = evaluateDone({
    childRunId,
    parentStepStatus: parentStepState2?.status,
    parentSessionStatus: parentSessionState2?.status,
    parentDelegationPauseSource: parentSessionState2?.delegationPauseSource,
    parentRequestedInputRef: parentSessionState2?.requestedInputRef,
    parentPausedChildSessionId: parentSessionState2?.pausedChildSessionId,
  });
  if (doneVerdict2 === 'done') {
    await completeDelegationLifecycle(redis, tenantId, childRunId);
    log.info(
      `[delegation-drain] reconcile completed cascade tenant=${tenantId} child=${childRunId} ` +
        `parent=${parentRunId} outcome=${reconcileOutcome ?? 'thrown'} ` +
        `attempt=${data.attempt + 1}`,
    );
    return 'completed';
  }

  // ── Lifecycle-already-resolved outcomes ───────────────────────────────
  //
  // These reconcile outcomes mean the system has already moved past this
  // delegation through some other path — there's no cascade to advance.
  // The lifecycle entry is orphaned; clear it instead of escalating.
  //
  // Why this matters: the drain previously treated all "not done" outcomes
  // identically, which caused false escalation on healthy chains (e.g. a
  // cancel cascade that left an old delegate step stuck in PAUSED while
  // the parent moved on, leaving a pending entry pointing at the now-stale
  // step). The drain would re-fire reconcile 5 times, see no progress,
  // and inject a synthetic FAILED on the parent — fabricating the very
  if (
    reconcileOutcome === 'parent_already_advanced' ||
    reconcileOutcome === 'parent_not_tracking_child' ||
    reconcileOutcome === 'parent_interrupted_suppressed' ||
    reconcileOutcome === 'child_not_resting'
  ) {
    await completeDelegationLifecycle(redis, tenantId, childRunId);
    log.info(
      `[delegation-drain] lifecycle_already_resolved tenant=${tenantId} child=${childRunId} ` +
        `parent=${parentRunId} outcome=${reconcileOutcome} — clearing orphan entry, no escalation`,
    );
    return 'completed';
  }

  // Reconcile-side anomaly: parent or child state is gone. Escalate.
  if (reconcileOutcome === 'parent_state_missing' || reconcileOutcome === 'child_state_missing') {
    return escalate({
      redis,
      tenantId,
      childRunId,
      parentRunId,
      parentStepExecutionId,
      attempt: data.attempt + 1,
      escalationsSoFar: data.escalations ?? 0,
      maxEscalations: config.maxEscalations,
      postEscalationBackoffMs: config.postEscalationBackoffMs,
      code:
        reconcileOutcome === 'parent_state_missing'
          ? 'PARENT_STATE_MISSING'
          : 'CHILD_STATE_MISSING',
      message:
        reconcileOutcome === 'parent_state_missing'
          ? 'Parent session state missing for this delegation; cascade cannot complete.'
          : 'Child session state missing for this delegation; cascade cannot complete.',
    });
  }

  // ── Decide retry vs escalate ──

  const nextAttempt = data.attempt + 1;
  const escalationsSoFar = data.escalations ?? 0;
  if (nextAttempt >= config.maxAttempts) {
    return escalate({
      redis,
      tenantId,
      childRunId,
      parentRunId,
      parentStepExecutionId,
      attempt: nextAttempt,
      escalationsSoFar,
      maxEscalations: config.maxEscalations,
      postEscalationBackoffMs: config.postEscalationBackoffMs,
      code: 'DELEGATION_RECONCILE_STALLED',
      message:
        `Delegation cascade did not complete after ${config.maxAttempts} attempts; ` +
        `parent step status=${parentStepState2?.status ?? 'missing'}, ` +
        `parent session status=${parentSessionState2?.status ?? 'missing'}.`,
    });
  }

  await releasePendingDelegation(
    redis,
    tenantId,
    childRunId,
    Date.now() + config.backoffMs,
    nextAttempt,
    lastError,
  );
  log.debug(
    `[delegation-drain] retry tenant=${tenantId} child=${childRunId} parent=${parentRunId} ` +
      `attempt=${nextAttempt}/${config.maxAttempts} reconcile=${reconcileOutcome ?? 'thrown'}`,
  );
  return 'retried';
}

async function escalate(args: {
  redis: Redis;
  tenantId: string;
  childRunId: string;
  parentRunId: string;
  parentStepExecutionId: string;
  attempt: number;
  escalationsSoFar: number;
  maxEscalations: number;
  postEscalationBackoffMs: number;
  code: string;
  message: string;
}): Promise<EntryOutcome> {
  const {
    redis,
    tenantId,
    childRunId,
    parentRunId,
    parentStepExecutionId,
    attempt,
    escalationsSoFar,
    maxEscalations,
    postEscalationBackoffMs,
    code,
    message,
  } = args;
  const log = getOrchestratorLogger().child({ component: 'delegation-drain' });

  // 0. Defense-in-depth: re-verify the parent session ACTUALLY still
  //    tracks this child before fabricating a failure. The processEntry
  //    flow above is supposed to have caught this already via the
  //    `lifecycle_already_resolved` branch, but a race between drain
  //    ticks could change parent state between the upstream check and
  //    here. Failing this check means the parent has moved past this
  //    child (cancel cascade, sibling completion, etc.) — clear the
  //    lifecycle instead of injecting a synthetic FAILED that would
  //    fabricate the very failure we're supposed to detect.
  const liveParent = await getSessionState(redis, tenantId, parentRunId);
  if (liveParent) {
    const tracksChildNow =
      (liveParent.waitingForChildSessionIds?.includes(childRunId) ?? false) ||
      liveParent.pausedChildSessionId === childRunId;
    if (!tracksChildNow) {
      await completeDelegationLifecycle(redis, tenantId, childRunId);
      log.info(
        `[delegation-drain] escalation_aborted_parent_moved_on tenant=${tenantId} ` +
          `child=${childRunId} parent=${parentRunId} step=${parentStepExecutionId} ` +
          `code=${code} — parent no longer tracking this child, clearing lifecycle ` +
          `instead of injecting synthetic FAILED`,
      );
      return 'completed';
    }
  }

  // 1. Try synthetic FAILED on parent delegate step (preserves session).
  //    addStepResult enqueues onto the result stream — it does NOT apply
  //    the result. The drain re-checks the parent step status on the
  //    next tick and only clears the lifecycle when applyResult has
  //    actually transitioned the step to terminal.
  let injected = false;
  try {
    injected = await injectSyntheticFailure({
      redis,
      tenantId,
      parentRunId,
      parentStepExecutionId,
      childRunId,
      code,
      message,
      attempt,
    });
  } catch (err) {
    logOrchestratorError('[delegation-drain] synthetic-FAILED injection threw', err, {
      tenantId,
      parentRunId,
      parentStepExecutionId,
      childRunId,
    });
  }

  // 2. Emit SessionStalled (visible event) on every escalation tick.
  await emitParentStalledEvent({ redis, tenantId, parentRunId, childRunId, code, message });

  // 3. If injection isn't possible (parent step missing), fall through
  //    to failRun. We only clear the lifecycle if failRun ACTUALLY
  //    terminates the parent — otherwise the durable evidence has to
  //    survive so a future drain tick can retry. failRun can fail by
  //    throwing (e.g. its own delegation upsert throws when cascading
  //    parent failure upward); without this guard we'd silently delete
  //    the only proof the cascade is unfinished.
  if (!injected) {
    let failRunOk = false;
    try {
      const { failRun } = await import('./failRun.js');
      await failRun(redis, tenantId, parentRunId, code, message, 'internal');
      failRunOk = true;
    } catch (err) {
      logOrchestratorError('[delegation-drain] failRun fallback threw', err, {
        tenantId,
        parentRunId,
        childRunId,
        parentStepExecutionId,
      });
    }
    if (failRunOk) {
      await completeDelegationLifecycle(redis, tenantId, childRunId);
      log.warn(
        `[delegation-drain] escalated path=failRun-fallback (parent step missing) ` +
          `attempt=${attempt} code=${code}`,
        { tenantId, childRunId, parentRunId, parentStepExecutionId, code, attempt },
      );
      return 'escalated';
    }
    // failRun threw — release for retry. The pending entry survives so
    // a future drain tick can attempt escalation again.
    await releasePendingDelegationAfterEscalation(
      redis,
      tenantId,
      childRunId,
      Date.now() + postEscalationBackoffMs,
      `failRun fallback threw; pending entry retained for retry.`,
    );
    log.error(
      `[delegation-drain] escalated_with_failrun_retry — failRun threw, lifecycle retained`,
      undefined,
      {
        tenantId,
        childRunId,
        parentRunId,
        parentStepExecutionId,
        attempt,
        errorCode: 'DELEGATION_RECONCILE_STALLED',
      },
    );
    return 'retried';
  }

  // 4. Synthetic-FAILED path: count this escalation and decide whether
  //    to keep waiting or fall through to failRun on the next tick.
  const nextEscalations = escalationsSoFar + 1;
  if (nextEscalations >= maxEscalations) {
    // Cap reached. The synthetic FAILED has been injected `maxEscalations`
    // times without ever landing on the parent step (otherwise the Done
    // check would have caught it before we got here). Force-fail the
    // parent session and clear the lifecycle ONLY if failRun returns
    // cleanly — otherwise retain the pending entry so a future tick
    // retries.
    let failRunOk = false;
    try {
      const { failRun } = await import('./failRun.js');
      await failRun(
        redis,
        tenantId,
        parentRunId,
        code,
        `${message} Synthetic-FAILED injection did not land after ${maxEscalations} tries; ` +
          `force-failing parent session.`,
        'internal',
      );
      failRunOk = true;
    } catch (err) {
      logOrchestratorError('[delegation-drain] failRun (post-escalation cap) threw', err, {
        tenantId,
        parentRunId,
        childRunId,
        parentStepExecutionId,
      });
    }
    if (failRunOk) {
      await completeDelegationLifecycle(redis, tenantId, childRunId);
      log.error(
        `[delegation-drain] escalation_capped — synthetic-FAILED never applied, ` +
          `force-failed parent`,
        undefined,
        {
          tenantId,
          childRunId,
          parentRunId,
          parentStepExecutionId,
          escalations: nextEscalations,
          maxEscalations,
          errorCode: 'DELEGATION_RECONCILE_STALLED',
        },
      );
      return 'escalation_capped';
    }
    // failRun threw at the cap. Retain the pending entry; the lifecycle
    // becomes the only durable record that escalation is unresolved.
    // We bump escalations so retries don't repeatedly count as the
    // first cap-hit attempt; the entry stays at this state until a
    // future drain succeeds.
    await releasePendingDelegationAfterEscalation(
      redis,
      tenantId,
      childRunId,
      Date.now() + postEscalationBackoffMs,
      `failRun at escalation cap threw; pending entry retained for retry.`,
    );
    log.error(
      `[delegation-drain] escalation_cap_retry — failRun threw at cap, lifecycle ` +
        `retained for next tick`,
      undefined,
      {
        tenantId,
        childRunId,
        parentRunId,
        parentStepExecutionId,
        escalations: nextEscalations,
        errorCode: 'DELEGATION_RECONCILE_STALLED',
      },
    );
    return 'retried';
  }

  // 5. Synthetic injected but lifecycle stays pending. Next drain tick
  //    re-checks the parent step status; if the synthetic landed via
  //    applyResult (parent step now terminal), the Done check completes
  //    the lifecycle. If not, we'll re-inject on the next escalation
  //    pass (idempotent because each injection has a distinct
  //    idempotency key).
  await releasePendingDelegationAfterEscalation(
    redis,
    tenantId,
    childRunId,
    Date.now() + postEscalationBackoffMs,
    `Synthetic-FAILED injected (escalation ${String(nextEscalations)}/${String(maxEscalations)}); awaiting applyResult.`,
  );
  log.warn(
    `[delegation-drain] escalated tenant=${tenantId} child=${childRunId} parent=${parentRunId} ` +
      `step=${parentStepExecutionId} code=${code} attempt=${attempt} ` +
      `escalations=${nextEscalations}/${maxEscalations} ` +
      `path=synthetic-FAILED (lifecycle remains pending until parent step observed terminal)`,
  );
  return 'escalated';
}

// ============================================================================
// Public API: single drain pass
// ============================================================================

/**
 * Run one drain pass: claim due entries, process them, release/escalate
 * as needed. Safe to call concurrently with itself across orchestrator
 * instances — the per-entry lease prevents double-claim.
 *
 * Intended to be invoked on a timer (`DEFAULT_DRAIN_INTERVAL_MS`).
 */
export async function drainPendingDelegations(
  deps: DrainPendingDelegationsDeps,
  config: DrainPendingDelegationsConfig = {},
): Promise<DrainPassResult> {
  const merged: Required<DrainPendingDelegationsConfig> = {
    intervalMs: config.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS,
    leaseMs: config.leaseMs ?? DEFAULT_LEASE_MS,
    batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoffMs: config.backoffMs ?? DEFAULT_BACKOFF_MS,
    postEscalationBackoffMs: config.postEscalationBackoffMs ?? DEFAULT_POST_ESCALATION_BACKOFF_MS,
    maxEscalations: config.maxEscalations ?? DEFAULT_MAX_ESCALATIONS,
  };

  const workerId = deps.workerId ?? PROCESS_WORKER_ID;
  const claimed = await claimDuePendingDelegations(
    deps.redis,
    workerId,
    merged.leaseMs,
    merged.batchSize,
  );

  const counts: DrainPassResult = {
    claimed: claimed.length,
    completed: 0,
    retried: 0,
    escalated: 0,
    escalation_capped: 0,
    aborted: 0,
    unresolvable: 0,
  };

  for (const entry of claimed) {
    try {
      const outcome = await processEntry({ ...deps, config: merged }, entry);
      counts[outcome] += 1;
    } catch (err) {
      logOrchestratorError(
        `[delegation-drain] processEntry threw for child=${entry.childRunId}:`,
        err,
        { tenantId: entry.tenantId, childRunId: entry.childRunId },
      );
      // Best-effort release so the entry retries next tick instead of
      // staying leased until the lease expires.
      await releasePendingDelegation(
        deps.redis,
        entry.tenantId,
        entry.childRunId,
        Date.now() + merged.backoffMs,
        entry.data.attempt + 1,
        err instanceof Error ? err.message : String(err),
      ).catch(() => {});
      counts.retried += 1;
    }
  }

  return counts;
}

// ============================================================================
// Public API: long-running loop (started by orchestrator boot)
// ============================================================================

export interface DelegationDrainLoop {
  stop: () => Promise<void>;
}

/**
 * Start a periodic drain. Runs forever until `stop()` is called.
 * Single-instance leadership is the caller's responsibility — this
 * just starts a timer.
 */
/**
 * The drain, on the standard runner.
 *
 * Cadence and batch come from the registry rather than from the module's own
 * defaults, so an operator raising a ceiling there reaches the code that
 * enforces it. The lease and attempt ceiling stay local: they describe how long
 * one delegation may be worked and how many times it may be retried before
 * escalating, which is a property of the delegation rather than of how often
 * the drain looks.
 */
export function startDelegationDrainLoop(
  deps: DrainPendingDelegationsDeps,
  config: DrainPendingDelegationsConfig = {},
): DelegationDrainLoop {
  const runtime = backgroundTaskControlPlane().resolve(DELEGATION_DRAIN_TASK_ID);
  const runner = createBackgroundTaskRunner(
    {
      taskId: DELEGATION_DRAIN_TASK_ID,
      scope: runtime.scope,
      intervalMs: config.intervalMs ?? runtime.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS,
      maxBatch: config.batchSize ?? runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      logger: getOrchestratorLogger(),
    },
    async (ctx) => {
      if (ctx.mode === 'observe') return {};
      const result = await drainPendingDelegations(deps, { ...config, batchSize: ctx.maxBatch });
      if (result.claimed > 0) {
        getOrchestratorLogger().debug(
          `[delegation-drain] tick claimed=${String(result.claimed)} completed=${String(result.completed)} ` +
            `retried=${String(result.retried)} escalated=${String(result.escalated)} ` +
            `aborted=${String(result.aborted)} unresolvable=${String(result.unresolvable)}`,
        );
      }
      return { candidates: result.claimed, processed: result.completed };
    },
  );
  runner.start();
  return { stop: () => runner.stop() };
}
