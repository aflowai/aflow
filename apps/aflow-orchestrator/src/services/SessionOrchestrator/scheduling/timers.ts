import {
  type TenantId,
  type SessionId,
  type StepExecutionId,
  type StepId,
  type OperationId,
  type IdempotencyKey,
  type TraceId,
  type StepType,
  type StepResultMessage,
  type AflowError,
  CodeLaneDisabledError,
  toFailedRunDisplay,
  SNOOZE_OPERATION_ID,
  StreamKeys,
} from '@aflow/schemas';
import {
  addStepJob,
  addStepResult,
  addControlMessage,
  NoExecutorAvailableError,
  hasAvailableExecutor,
  getStepInFlight,
  clearStepInFlight,
  peekDueStepStallCandidates,
  refreshStepStallCandidate,
  dropStepStallCandidate,
  stepStallNextCheckAtMs,
  STEP_STALL_SCAN_INTERVAL_MS,
  TIMER_MAX_CLAIMS,
  timerId,
  type SessionEvent,
  getSessionState,
  getStepState,
  isSessionCorrupt,
  shardFor,
  validateShardOwnership,
} from '@aflow/redis';
import { backgroundTaskControlPlane } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestratorBindings } from '../lifecycle/context.js';
import type { TimerItem } from '@aflow/schemas';
import { insertTimerDeadLetter } from '@aflow/database';
import { createLeasedWorkConsumer } from '@aflow/lib';
import { dispatchInlineOp } from '../handlers/dispatchInlineOp.js';
import { processWorkflowCorrelatedTimer } from './workflowTimerDispatch.js';
import { wakeSessionForRunWakeups } from '../../cybernetic/harness/sessionWakeup.js';

/**
 * Re-arm offset for a timer this instance may not dispatch. Long enough that a
 * rejected timer is not immediately re-claimed by the same loser, short enough
 * that the real owner is not made to wait.
 */
const FENCING_REARM_DELAY_MS = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolved per look rather than at module load, so the process's installed
// control plane — operator overrides included — is the one consulted.
const stepStallRuntime = () =>
  backgroundTaskControlPlane().resolve('orchestrator.step_stall_watchdog');
import { classifyStepCompletionPath } from './stepCompletionPath.js';

export function createProcessDueTimers(bindings: SessionOrchestratorBindings) {
  const { deps, stallWatchdog, forceCompleteInFlightStep } = bindings;
  const { redis, shardManager, db } = deps;

  return async function processDueTimers(): Promise<number> {
    const {
      claimDueShardTimers,
      ackShardTimer,
      ackShardTimerById,
      rescheduleClaimedTimer,
      updateSessionState,
      appendSessionEvent,
      markSessionDirty,
    } = await import('@aflow/redis');

    // Claiming leases the timer rather than deleting it, so a crash between
    // here and dispatch no longer loses the wake-up: the lease expires and the
    // timer becomes due again. Every path below therefore ends in an explicit
    // ack or reschedule.
    const claim = await claimDueShardTimers(redis, shardManager?.ownedShards() ?? []);
    const timers = claim.timers;

    if (claim.legacyClaimed > 0) {
      getOrchestratorLogger().warn(
        '[SessionOrchestrator] Skipped timers still stored in the pre-id format; boot migration converts them',
        { count: claim.legacyClaimed },
      );
    }

    /**
     * Marks the timer handled. Acknowledging is compare-and-ack against the
     * lease, so a producer that re-armed this timer mid-handling keeps its
     * newer arming.
     */
    const settle = async (timer: TimerItem): Promise<void> => {
      await ackShardTimer(redis, timer, claim.leaseUntilMs).catch((err: unknown) => {
        logOrchestratorError('[SessionOrchestrator] Failed to acknowledge timer', err, {
          tenantId: timer.tenantId,
          sessionId: timer.sessionId,
          stepExecutionId: timer.stepExecutionId,
        });
      });
    };

    const poisonContext = (t: TimerItem) => ({
      tenantId: t.tenantId,
      sessionId: t.sessionId,
      stepExecutionId: t.stepExecutionId,
      reason: t.reason,
    });

    // Past its redelivery budget this timer is never handled again — but its
    // wake was owed to a step, and dropping it with only a log leaves that
    // step waiting forever on nothing. The disposition is the watchdog's:
    // fail the step through applyResult so its retry/onFailure policy runs
    // and the outcome is visible on the run. Past twice the budget the
    // disposition itself is what keeps failing, and the payload is archived
    // to the durable dead-letter table instead — replayable, and lossless
    // where a capped Redis list trimmed away the records it existed to keep.
    // Either way the consumer keeps the timer leased until its ack, so an
    // outcome interrupted by the same outage that poisoned the timer is
    // redelivered rather than lost.
    const poisonedConsumer = createLeasedWorkConsumer<{ timer: TimerItem; claims: number }>({
      name: 'timer-poison',
      work: async ({ timer: poisoned, claims }) => {
        if (claims > TIMER_MAX_CLAIMS * 2) {
          return {
            kind: 'unworkable',
            disposition: async () => {
              await insertTimerDeadLetter(db, {
                timerId: timerId(poisoned),
                tenantId: poisoned.tenantId,
                sessionId: poisoned.sessionId ?? null,
                stepExecutionId: poisoned.stepExecutionId,
                reason: poisoned.reason,
                claims,
                payload: poisoned,
              });
              logOrchestratorError(
                '[SessionOrchestrator] Poisoned timer archived to the dead-letter table',
                new Error('TIMER_POISONED'),
                poisonContext(poisoned),
              );
              return true;
            },
          };
        }
        return (await disposePoisonedTimer(poisoned))
          ? { kind: 'completed' }
          : { kind: 'yield', reason: 'workflow_correlated' };
      },
      ack: ({ timer: t }) => ackShardTimer(redis, t, claim.leaseUntilMs),
      retire: ({ timer: t }) => ackShardTimer(redis, t, claim.leaseUntilMs),
      onEvent: (event) => {
        switch (event.kind) {
          case 'work_error':
          case 'disposition_failed':
            logOrchestratorError(
              '[SessionOrchestrator] Poisoned-timer disposition failed; leaving it leased',
              event.error,
              poisonContext(event.claim.timer),
            );
            break;
          case 'ack_error':
          case 'retire_error':
            logOrchestratorError(
              '[SessionOrchestrator] Failed to acknowledge timer',
              event.error,
              poisonContext(event.claim.timer),
            );
            break;
          case 'discarded':
          case 'discard_error':
          case 'ack_refused':
          case 'retire_refused':
          case 'budget_error':
          case 'after_completed_error':
          case 'release_error':
            break;
        }
      },
    });
    await poisonedConsumer.runClaimed(claim.poisoned);

    // Decodes as JSON but no longer matches the schema — vintage drift no
    // disposition can act on. Archived raw, with whatever identity the
    // payload still names, and acknowledged by storage identity; the archive
    // failing leaves it leased like any other poisoned timer.
    const malformedConsumer = createLeasedWorkConsumer<{
      raw: string;
      claims: number;
      shardId: number;
      timerId: string;
    }>({
      name: 'timer-poison-malformed',
      work: (malformed) =>
        Promise.resolve({
          kind: 'unworkable',
          disposition: async () => {
            // This lane is the terminal backstop — nothing in it may throw
            // forever. cjson and JSON.parse disagree (inf/nan), the payload can
            // be a JSON null, and identities can be legacy non-uuids the
            // insert's casts reject; each of those must still archive, as raw
            // text with null identities, rather than cycle leased for good.
            let loose: Record<string, unknown> | null = null;
            try {
              const parsed: unknown = JSON.parse(malformed.raw);
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                loose = parsed as Record<string, unknown>;
              }
            } catch {
              loose = null;
            }
            const uuidOrNull = (v: unknown): string | null =>
              typeof v === 'string' && UUID_RE.test(v) ? v : null;
            const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
            await insertTimerDeadLetter(db, {
              timerId: malformed.timerId,
              tenantId: uuidOrNull(loose?.['tenantId']),
              sessionId: uuidOrNull(loose?.['sessionId']),
              stepExecutionId: uuidOrNull(loose?.['stepExecutionId']),
              reason: str(loose?.['reason']) ?? 'unparseable',
              claims: malformed.claims,
              payload: loose ?? { raw: malformed.raw },
            });
            logOrchestratorError(
              '[SessionOrchestrator] Malformed poisoned timer archived to the dead-letter table',
              new Error('TIMER_POISONED'),
              { timerId: malformed.timerId, shardId: malformed.shardId },
            );
            return true;
          },
        }),
      ack: (m) => ackShardTimerById(redis, m.shardId, m.timerId, claim.leaseUntilMs),
      retire: (m) => ackShardTimerById(redis, m.shardId, m.timerId, claim.leaseUntilMs),
      onEvent: (event) => {
        switch (event.kind) {
          case 'disposition_failed':
          case 'work_error':
          case 'retire_error':
          case 'ack_error':
            logOrchestratorError(
              '[SessionOrchestrator] Malformed poisoned timer archive failed; leaving it leased',
              event.error,
              { timerId: event.claim.timerId, shardId: event.claim.shardId },
            );
            break;
          case 'discarded':
          case 'discard_error':
          case 'ack_refused':
          case 'retire_refused':
          case 'budget_error':
          case 'after_completed_error':
          case 'release_error':
            break;
        }
      },
    });
    await malformedConsumer.runClaimed(claim.malformedPoisoned);

    for (const timer of timers) {
      // Each timer is isolated. The claim already charged a redelivery to every
      // timer in this batch, so letting one failure abort the loop would leave
      // the rest leased-but-undispatched and, after enough such cycles, drop
      // them as poison without ever having tried them.
      try {
        await handleTimer(timer);
      } catch (error) {
        // Deliberately not settled. Acknowledging is compare-and-ack, so it
        // deletes the timer — and a handler that threw has not done the thing
        // the timer exists for. Leaving the lease is what the claim protocol is
        // for: it expires, the timer is redelivered, and its claim count rises
        // until the poison path takes it. Settling here turned a transient
        // Redis or executor error into a permanently lost retry, snooze or
        // timeout wake.
        logOrchestratorError('[SessionOrchestrator] Timer handler failed', error, {
          tenantId: timer.tenantId,
          sessionId: timer.sessionId,
          stepExecutionId: timer.stepExecutionId,
          reason: timer.reason,
        });
      }
    }

    /** Returns whether the timer may be acknowledged. */
    async function disposePoisonedTimer(timer: TimerItem): Promise<boolean> {
      const context = {
        tenantId: timer.tenantId,
        sessionId: timer.sessionId,
        stepExecutionId: timer.stepExecutionId,
        reason: timer.reason,
      };
      if (timer.workflowExecution !== undefined) {
        // The session-side disposition below cannot speak for the workflow
        // lane; stuck-task visibility there belongs to the workflow's own
        // checks. Left leased rather than acknowledged, so the claim's
        // dead-letter backstop archives the payload instead of an ack
        // deleting the only copy.
        logOrchestratorError(
          '[SessionOrchestrator] Poisoned workflow-correlated timer left for the dead-letter backstop',
          new Error('TIMER_POISONED'),
          context,
        );
        return false;
      }

      if (timer.reason === 'event_wake') {
        // No step is waiting on this wake: the wakeups it was for stay in the
        // log and are read at the session's next turn.
        logOrchestratorError(
          '[SessionOrchestrator] Dropping poisoned event wake',
          new Error('TIMER_POISONED'),
          context,
        );
        return true;
      }

      // Schema invariant guarantees a timer without workflowExecution names a
      // session; the non-null assertion is safe.
      const sessionId = timer.sessionId!;

      const stepState = await getStepState(redis, timer.tenantId, timer.stepExecutionId);
      // Attempt-aware on purpose: a poisoned timer can be redelivered AFTER its
      // disposition landed (the ack is swallowed on failure), and by then the
      // step has advanced. A retry wake is current only while the step is
      // still FAILED behind it; every other wake only at its exact attempt.
      // Without this, a stale redelivery rewinds the step's attempt and
      // re-executes work an earlier disposition already consumed.
      const stillWaitingOnThisTimer =
        stepState?.operationId === timer.operationId &&
        (timer.reason === 'retry'
          ? stepState.status === 'FAILED' && stepState.attempt < timer.attempt
          : stepState.attempt === timer.attempt &&
            (stepState.status === 'SCHEDULED' ||
              stepState.status === 'STARTED' ||
              stepState.status === 'PAUSED'));
      if (!stillWaitingOnThisTimer) {
        logOrchestratorError(
          '[SessionOrchestrator] Dropping poisoned timer whose step has moved on',
          new Error('TIMER_POISONED'),
          context,
        );
        return true;
      }

      // For a retry wake the step still holds the attempt that already failed,
      // while the timer carries the attempt that never dispatched. The
      // disposition consumes the timer's attempt — exactly as the real dispatch
      // would have — so applyResult's retry math advances instead of
      // rescheduling the same attempt under the same timer id forever.
      const failedAttempt = timer.reason === 'retry' ? timer.attempt : stepState.attempt;

      if (stepState.status === 'PAUSED' || stepState.status === 'FAILED') {
        // applyResult rejects results targeting PAUSED steps, and a FAILED
        // step awaiting its retry wake needs the same reset before the
        // synthetic result can land.
        const { updateStepState } = await import('@aflow/redis');
        await updateStepState(redis, timer.tenantId, timer.stepExecutionId, {
          sessionId,
          status: 'STARTED',
          ...(timer.reason === 'retry' ? { attempt: timer.attempt } : {}),
        });
        // The reset and the synthetic result are not atomic, and recovery for
        // the gap differs by wake. A half-applied RETRY reset no longer
        // matches the currency guard, so redelivery acks it as moved on —
        // correctly: the reset's own pipeline armed the step-stall candidate,
        // and a STARTED step with no executor reaps there as a retryable
        // failure. Every other wake still matches at its exact attempt and is
        // simply dispositioned again on redelivery.
      }

      const now = Date.now();
      const syntheticResult: StepResultMessage = {
        messageVersion: 1,
        tenantId: timer.tenantId as TenantId,
        sessionId,
        stepExecutionId: timer.stepExecutionId as StepExecutionId,
        parentStepExecutionId:
          stepState.parentStepExecutionId != null
            ? (stepState.parentStepExecutionId as StepExecutionId)
            : null,
        stepId: stepState.stepId as StepId,
        stepType: stepState.stepType as StepType,
        operationId: stepState.operationId as OperationId,
        attempt: failedAttempt,
        idempotencyKey:
          timer.reason === 'retry'
            ? (`${sessionId}:${timer.stepExecutionId}:${String(timer.attempt)}` as IdempotencyKey)
            : (stepState.idempotencyKey as IdempotencyKey),
        status: 'FAILED',
        outputRef: null,
        errorRef: null,
        requestedInputRef: null,
        // A lost timeout wake must not become a retryable failure: retrying
        // re-runs the delegation while its never-cancelled children are still
        // live, which is exactly what the real timeout branch's non-retryable
        // error exists to forbid. The other wakes retry — a fresh attempt gets
        // a fresh timer. Skipped compensation is a recorded residue: the
        // children the real branch would have cancelled stay running, and
        // their late results are discarded by the terminal-state guard.
        error:
          timer.reason === 'timeout'
            ? {
                code: 'TIMER_POISONED',
                classification: 'timeout' as const,
                message:
                  `The timeout wake for this delegation was redelivered repeatedly ` +
                  `without being handled; failing the step in its place.`,
                retryable: false,
                timestamp: new Date(now).toISOString(),
              }
            : {
                code: 'TIMER_POISONED',
                classification: 'transient' as const,
                message:
                  `The ${timer.reason} wake for this step was redelivered repeatedly ` +
                  `without being handled; failing the step so its retry policy ` +
                  `decides instead of waiting forever.`,
                retryable: true,
                timestamp: new Date(now).toISOString(),
              },
        traceId: timer.traceId as TraceId,
        finishedAtMs: now,
      };
      // A redelivery after a landed disposition whose ack was lost re-fails
      // whatever attempt is current by then — bounded by the step's retry
      // budget and visible each time, never a silent hang.
      await bindings.applyResult({
        result: syntheticResult,
        messageId: `poison:${timer.stepExecutionId}`,
      });
      return true;
    }

    async function handleTimer(timer: TimerItem): Promise<void> {
      if (timer.workflowExecution !== undefined) {
        await processWorkflowCorrelatedTimer(
          redis,
          deps.payloadStore,
          timer,
          timer.workflowExecution,
        );
        await settle(timer);
        return;
      }
      if (timer.sessionId === undefined) {
        // Schema invariant (exactly one of sessionId/workflowExecution)
        // makes this unreachable — defensive skip.
        await settle(timer);
        return;
      }

      if (await isSessionCorrupt(redis, timer.tenantId, timer.sessionId)) {
        await settle(timer);
        return;
      }

      if (shardManager) {
        const timerShardId = shardFor(timer.sessionId);
        const expectedToken = shardManager.fencingToken(timerShardId);
        // A fencing rejection is not this timer's fault, so it is re-armed
        // without consuming a redelivery — but at a short offset rather than its
        // original past due time, because re-arming in the past keeps the shard
        // permanently due and this instance re-claims it every tick.
        //
        // Local ownership is also dropped, matching the result and control
        // consumers: without that the instance never stops believing it owns the
        // shard and the loop never ends.
        if (expectedToken === 0) {
          console.warn(
            `[FES] Timer fencing: shard ${String(timerShardId)} not owned, re-scheduling timer for run ${timer.sessionId}`,
          );
          await rescheduleClaimedTimer(redis, timer, Date.now() + FENCING_REARM_DELAY_MS);
          return;
        }
        const valid = await validateShardOwnership(
          redis,
          timerShardId,
          deps.consumerName,
          expectedToken,
        );
        if (!valid) {
          console.warn(
            `[FES] Timer fencing failed for shard ${String(timerShardId)} (run ${timer.sessionId}), re-scheduling`,
          );
          shardManager.revokeShard(timerShardId);
          await rescheduleClaimedTimer(redis, timer, Date.now() + FENCING_REARM_DELAY_MS);
          return;
        }
      }

      if (timer.reason === 'event_wake') {
        // A store error throws and leaves the lease, so this timer's own
        // redelivery and poison budget bound the retries; re-arming here
        // would reset that budget on every fire.
        await wakeSessionForRunWakeups(
          { db, redis, payloadStore: deps.payloadStore },
          timer.tenantId,
          timer.sessionId,
        );
        await settle(timer);
        return;
      }

      if (timer.reason === 'delayed_start' && timer.operationId === SNOOZE_OPERATION_ID) {
        try {
          const snoozeRunState = await getSessionState(redis, timer.tenantId, timer.sessionId);
          await dispatchInlineOp(
            redis,
            deps.payloadStore,
            {
              tenantId: timer.tenantId,
              runId: timer.sessionId,
              // Synthetic — the snooze handler never reads the agent
              // definition; routing back to the agent uses durable step
              // hot state written at schedule time (same as executor
              // results re-dispatched from timers).
              agentDefinition: {
                flowId: 'snooze-timer-inline',
                flowVersion: '1',
                steps: [],
                metadata: { name: '', description: '' },
              } as never,
              traceId: timer.traceId,
              ...(snoozeRunState?.spaceId !== undefined ? { spaceId: snoozeRunState.spaceId } : {}),
            },
            {
              stepId: timer.stepId,
              stepType: timer.stepType,
              operation: timer.operationId,
              config: {},
              tags: ['dynamic'],
              optional: false,
              onSuccess: { next: [] },
              onFailure: { next: [] },
            },
            timer.stepExecutionId,
            `${timer.sessionId}:${timer.stepExecutionId}:${String(timer.attempt)}` as IdempotencyKey,
            timer.inputRef,
            timer.attempt,
            Date.now(),
            timer.parentStepExecutionId,
          );
        } catch (error) {
          // Rethrown rather than settled: the wake did not happen, and the
          // caller's catch leaves the lease so it is redelivered.
          logOrchestratorError(
            `[SessionOrchestrator] Failed to dispatch snooze completion from timer`,
            error,
            {
              tenantId: timer.tenantId,
              sessionId: timer.sessionId,
              stepExecutionId: timer.stepExecutionId,
            },
          );
          throw error;
        }
        await settle(timer);
        return;
      }

      if (timer.reason === 'timeout') {
        try {
          const parentState = await getSessionState(redis, timer.tenantId, timer.sessionId);
          if (!parentState) {
            await settle(timer);
            return;
          }
          // Guard: only act if parent is still waiting for children
          if (
            (parentState.status !== 'PAUSED' && parentState.status !== 'WAITING_ON_CHILD') ||
            parentState.delegationPauseSource !== 'child_running'
          ) {
            // Child already completed or parent already resumed — skip
            await settle(timer);
            return;
          }
          const timerStepState = await getStepState(redis, timer.tenantId, timer.stepExecutionId);
          if (
            timerStepState?.status !== 'PAUSED' ||
            timerStepState.operationId !== 'agent.control.delegate'
          ) {
            getOrchestratorLogger().debug(
              `[SessionOrchestrator] Skipping stale delegation timeout: step ${timer.stepExecutionId} ` +
                `is ${timerStepState?.status ?? '(missing)'} / ${timerStepState?.operationId ?? '(missing)'} ` +
                `for session ${timer.sessionId}`,
            );
            await settle(timer);
            return;
          }

          const allChildIds = parentState.waitingForChildSessionIds ?? [];
          const childStates = await Promise.all(
            allChildIds.map((id) => getSessionState(redis, timer.tenantId, id)),
          );
          const childrenForThisDelegate: string[] = [];
          for (let i = 0; i < allChildIds.length; i++) {
            if (childStates[i]?.parentStepExecutionId === timer.stepExecutionId) {
              childrenForThisDelegate.push(allChildIds[i]!);
            }
          }

          // Cancel only this delegate's children
          for (const childId of childrenForThisDelegate) {
            await addControlMessage(redis, {
              messageVersion: 1,
              type: 'cancel_run',
              tenantId: timer.tenantId,
              runId: childId as SessionId,
              traceId: timer.traceId,
              idempotencyKey: `timeout-cancel:${timer.sessionId}:${childId}` as IdempotencyKey,
              requestedAtMs: Date.now(),
            });
          }

          // Atomically remove only this delegate's children from the parent's
          // waiting list. The final return value is the count of *sibling*
          // children still active (belonging to other delegate steps).
          const { removeWaitingChild: removeWaitingChildForTimeout } = await import('@aflow/redis');
          let remainingSiblings = allChildIds.length;
          for (const childId of childrenForThisDelegate) {
            remainingSiblings = await removeWaitingChildForTimeout(
              redis,
              timer.tenantId,
              timer.sessionId,
              childId,
            );
          }

          // Reset THIS delegate step PAUSED → STARTED so applyResult will
          // accept the synthetic FAILED result we're about to enqueue.
          // (applyResult's idempotency check rejects results targeting PAUSED
          // steps; without this, the synthetic result is silently discarded.)
          const { updateStepState: updateStepStateForTimeout } = await import('@aflow/redis');
          await updateStepStateForTimeout(redis, timer.tenantId, timer.stepExecutionId, {
            sessionId: timer.sessionId,
            status: 'STARTED',
          });

          // Session-level transition mirrors resumeParentOnChildComplete: only
          // flip out of WAITING_ON_CHILD when ALL delegations have been
          // resolved. If sibling delegates are still active, leave the
          // session in WAITING_ON_CHILD; the per-step result we emit below
          // will decrement the agent's barrier counter, and the session will
          // resume when the last sibling completes.
          if (remainingSiblings === 0) {
            const { leaveChildWaitToRunning } = await import('../helpers/delegationState.js');
            await leaveChildWaitToRunning(redis, timer.tenantId, timer.sessionId, {
              fromStatus: parentState.status,
            });
          }

          // Fail the delegate step on the parent
          const timeoutError = {
            code: 'DELEGATION_TIMEOUT',
            message: `Delegation timed out. The sub-agent did not complete within the specified timeout.`,
            classification: 'timeout' as const,
            retryable: false,
            timestamp: new Date().toISOString(),
          };
          const errorRef = `inline:${Buffer.from(JSON.stringify(timeoutError)).toString('base64')}`;

          await addStepResult(redis, {
            messageVersion: 1,
            tenantId: timer.tenantId,
            sessionId: timer.sessionId,
            stepExecutionId: timer.stepExecutionId,
            parentStepExecutionId: null,
            stepId: timer.stepId,
            stepType: timer.stepType,
            operationId: timer.operationId,
            attempt: timer.attempt,
            idempotencyKey: `timeout:${timer.sessionId}:${timer.stepExecutionId}` as IdempotencyKey,
            status: 'FAILED',
            errorRef,
            error: timeoutError,
            resolvedInputRef: timer.inputRef,
            durationMs: 0,
            traceId: timer.traceId,
            finishedAtMs: Date.now(),
          });

          getOrchestratorLogger().info(
            `[SessionOrchestrator] Delegation timeout for step ${timer.stepExecutionId}: ` +
              `cancelled ${String(childrenForThisDelegate.length)} child(ren) of this delegate; ` +
              `${String(remainingSiblings)} sibling delegate child(ren) still active for session ${timer.sessionId}`,
          );
        } catch (error) {
          // Rethrown rather than settled: the timeout was not delivered, and
          // the caller's catch leaves the lease so it is redelivered. The
          // branch's own staleness guards make the retry safe.
          logOrchestratorError(`[SessionOrchestrator] Failed to handle delegation timeout`, error, {
            tenantId: timer.tenantId,
            sessionId: timer.sessionId,
            stepExecutionId: timer.stepExecutionId,
          });
          throw error;
        }
        await settle(timer);
        return;
      }

      if (timer.reason === 'retry' || timer.reason === 'delayed_start') {
        try {
          // Look up credential context from SessionHotState (cold path — retries/delays)
          const timerRunState = await getSessionState(redis, timer.tenantId, timer.sessionId);

          // Reset step state to SCHEDULED for the new attempt before
          // dispatching. The retry path entered with `failStep(willRetry: true)`
          const { updateStepState: updateStepStateForRetry } = await import('@aflow/redis');
          // which set `status: 'FAILED'` on the step. Without this reset:
          //
          //   1. The executor's `shouldMarkStarted` check
          //      (`executor-runtime/src/executor.ts:482`) only flips status
          //      to STARTED when status === 'SCHEDULED'. For a step still
          //      showing FAILED from the prior attempt, the executor runs
          //      attempt N+1 with the step status stuck at FAILED.
          //   2. When attempt N+1's result arrives, applyResult's
          //      idempotency guard sees status === 'FAILED' and discards
          //      the result as a "late result" (`index.ts:1525-1567`).
          //   3. The step never escapes FAILED, the run never escapes
          //      RUNNING, the parent stays WAITING_ON_CHILD forever —
          //      observed wedge during live testing on 2026-05-06 when
          //      Anthropic returned `AI_RATE_LIMIT` for the runner.
          //
          // Resetting status + attempt + clearing prior endedAt/errorRef
          // makes the retry indistinguishable from a fresh dispatch from
          // the state machine's perspective.
          await updateStepStateForRetry(redis, timer.tenantId, timer.stepExecutionId, {
            sessionId: timer.sessionId,
            status: 'SCHEDULED',
            attempt: timer.attempt,
            scheduledAt: Date.now(),
            startedAt: undefined,
            endedAt: undefined,
            errorRef: undefined,
            outputRef: undefined,
          });

          await addStepJob(redis, {
            messageVersion: 1,
            tenantId: timer.tenantId,
            sessionId: timer.sessionId,
            stepExecutionId: timer.stepExecutionId,
            stepId: timer.stepId,
            stepType: timer.stepType,
            operationId: timer.operationId,
            attempt: timer.attempt,
            idempotencyKey:
              `${timer.sessionId}:${timer.stepExecutionId}:${String(timer.attempt)}` as IdempotencyKey,
            inputRef: timer.inputRef,
            traceId: timer.traceId,
            scheduledAtMs: Date.now(),
            credentialOwnerId: timerRunState?.createdBy,
            spaceId: timerRunState?.spaceId,
          });
        } catch (error) {
          // A retry timer re-enters dispatch, so it meets the same gates a first
          // attempt does — including a lane breaker that opened after the step
          // was first scheduled.
          const refusal = error instanceof CodeLaneDisabledError ? error.toAflowError() : undefined;
          if (refusal !== undefined || error instanceof NoExecutorAvailableError) {
            const failure: AflowError = refusal ?? {
              code: 'EXECUTOR_UNAVAILABLE',
              message: error instanceof Error ? error.message : String(error),
              classification: 'internal',
              retryable: true,
              timestamp: new Date().toISOString(),
            };
            logOrchestratorError(
              `[SessionOrchestrator] Timer re-dispatch refused (${failure.code}): ${timer.stepType}`,
              error,
              {
                tenantId: timer.tenantId,
                sessionId: timer.sessionId,
                stepType: timer.stepType,
                stepExecutionId: timer.stepExecutionId,
              },
            );
            await updateSessionState(redis, timer.tenantId, timer.sessionId, {
              status: 'FAILED',
              endedAt: Date.now(),
            });
            const timerFailure = toFailedRunDisplay(failure, {
              runId: timer.sessionId,
              includeDebug: true,
            });
            const failEvent: SessionEvent = {
              eventId: crypto.randomUUID(),
              eventType: 'SessionFailed',
              timestamp: Date.now(),
              sessionId: timer.sessionId,
              metadata: {
                errorCode: failure.code,
                errorMessage: timerFailure.errorMessage,
                errorClassification: failure.classification,
                ...(timerFailure.userError ? { userError: timerFailure.userError } : {}),
              },
            };
            await appendSessionEvent(redis, timer.tenantId, timer.sessionId, failEvent);
            await markSessionDirty(redis, timer.tenantId, timer.sessionId);
            await settle(timer);
            return;
          }
          throw error;
        }
      }

      await settle(timer);
    }

    // Opportunistic watchdog scan (piggybacks on the existing timer tick).
    // This avoids adding another worker/interval in the orchestrator.
    const now = Date.now();
    // Gated on the resolved mode, not just budgeted by it: an accepted disable
    // is reported with the disabled signal, and a sweep that kept running
    // behind that report would have the platform asserting the reaper is off
    // while it reaps.
    const stallRuntime = stepStallRuntime();
    if (
      stallRuntime.mode === 'enabled' &&
      now - stallWatchdog.lastStepStallScanMs >= STEP_STALL_SCAN_INTERVAL_MS
    ) {
      stallWatchdog.lastStepStallScanMs = now;
      try {
        // Due-ordered, so the cap always takes the oldest work rather than
        // whichever sessions the read happened to return.
        const candidates = await peekDueStepStallCandidates(redis, stallRuntime.maxBatch, now);
        for (const { tenantId, sessionId: runId, dueAtMs } of candidates) {
          if (shardManager && !shardManager.ownsRun(runId)) continue;

          const state = await getSessionState(redis, tenantId, runId);
          if (state?.status !== 'RUNNING' || !state.currentStepExecutionId) {
            await dropStepStallCandidate(redis, tenantId, runId, dueAtMs);
            continue;
          }

          const stepState = await getStepState(redis, tenantId, state.currentStepExecutionId);
          if (!stepState) {
            await dropStepStallCandidate(redis, tenantId, runId, dueAtMs);
            continue;
          }
          if (stepState.status !== 'SCHEDULED' && stepState.status !== 'STARTED') {
            await dropStepStallCandidate(redis, tenantId, runId, dueAtMs);
            continue;
          }

          // The single shared completion-path authority (also used by orphan
          // recovery and the parallel-barrier sweep) — a STARTED step with a
          // live in-flight key within its deadline+backstop, a SCHEDULED step
          // inside its pickup grace, or any step inside the snooze window still
          // has a completion path. Never reap on elapsed time alone.
          const { hasCompletionPath, isStarted, executorOwnsStep, stepDeadlineAtMs } =
            await classifyStepCompletionPath(
              { redis, getStepInFlight, hasAvailableExecutor },
              stepState,
              now,
            );
          if (hasCompletionPath) {
            await refreshStepStallCandidate(
              redis,
              tenantId,
              runId,
              stepStallNextCheckAtMs(stepState, now),
            );
            continue;
          }

          const ageMs = isStarted
            ? now - (stepState.startedAt ?? stepState.scheduledAt)
            : now - stepState.scheduledAt;
          // The only way a STARTED step with a still-live executor key reaches
          // here is by blowing past its own deadline+backstop — a zombie.
          if (isStarted && executorOwnsStep) {
            getOrchestratorLogger().warn(
              `[watchdog] Step ${stepState.stepId} (${stepState.stepType}) blew past its executor deadline — treating as stall`,
              { tenantId, runId, ageMs, deadlineAtMs: stepDeadlineAtMs },
            );
          }

          // Both stall shapes become a RETRYABLE failure routed through
          // applyResult, so the step's onFailure/retry policy runs and the
          // outcome flows back to the agent (and propagates to any waiting
          // parent) instead of a terminal dead-end:
          //   - STARTED: executor crashed/restarted mid-flight; its result
          //     (e.g. an LLM response) is irrecoverably lost.
          //   - SCHEDULED: no executor picked the step up within grace — most
          //     often a saturated-but-alive executor, which retry self-heals
          //     once a slot frees.
          // The one exception is an agent TURN whose executor vanished mid-flight:
          // pause it (resumable from conversation history) rather than fail.
          const isAgentStep = stepState.stepType === 'agent';

          if (isStarted && isAgentStep && !executorOwnsStep) {
            getOrchestratorLogger().warn(
              `[watchdog] Pausing orphaned agent session ${runId}: step ${stepState.stepId} ` +
                `was in-flight ${String(ageMs)}ms with no executor heartbeat`,
              { tenantId, runId, stepExecutionId: stepState.stepExecutionId },
            );

            const forceCompleted = await forceCompleteInFlightStep(tenantId, runId, 'interrupted');

            if (forceCompleted) {
              continue; // Successfully paused — skip synthetic failure path
            }
            // Unexpected: step state may have changed between check and
            // force-complete. Fall back to synthetic failure below.
            getOrchestratorLogger().warn(
              `[watchdog] forceCompleteInFlightStep returned false for ${runId} — falling back to synthetic failure`,
            );
          }

          const abandonMessage = !isStarted
            ? `Step remained SCHEDULED for ${String(ageMs)}ms and no executor picked it up ` +
              `(${stepState.stepType}). The executor was unavailable or saturated; retrying.`
            : executorOwnsStep
              ? `Step exceeded its execution deadline and the executor did not return a result. ` +
                `In-flight for ${String(ageMs)}ms (${stepState.stepType}).`
              : `Step was in-flight when the executor disappeared. ` +
                `In-flight for ${String(ageMs)}ms with no executor heartbeat for ${stepState.stepType}.`;
          console.warn(
            `[SessionOrchestrator] Failing orphaned step ${stepState.stepId} (${stepState.stepType}) ` +
              `in run ${runId}: ${abandonMessage}`,
          );
          const syntheticResult: StepResultMessage = {
            messageVersion: 1,
            tenantId: tenantId as TenantId,
            sessionId: runId as SessionId,
            stepExecutionId: stepState.stepExecutionId as StepExecutionId,
            parentStepExecutionId:
              stepState.parentStepExecutionId != null
                ? (stepState.parentStepExecutionId as StepExecutionId)
                : null,
            stepId: stepState.stepId as StepId,
            stepType: stepState.stepType as StepType,
            operationId: stepState.operationId as OperationId,
            attempt: stepState.attempt,
            idempotencyKey: stepState.idempotencyKey as IdempotencyKey,
            status: 'FAILED',
            outputRef: null,
            errorRef: null,
            requestedInputRef: null,
            error: {
              code: 'STEP_ABANDONED',
              // Required by the schema. Without it the whole object fails to parse
              // as an AflowError, and the failure is reported as a non-retryable
              // internal one — the opposite of what an abandoned step is.
              classification: 'transient' as const,
              message: abandonMessage,
              retryable: true,
              timestamp: new Date(now).toISOString(),
            },
            traceId: (state.traceId ?? crypto.randomUUID()) as TraceId,
            finishedAtMs: now,
          };
          try {
            await bindings.applyResult({
              result: syntheticResult,
              messageId: `watchdog:${stepState.stepExecutionId}`,
            });
          } catch (applyErr) {
            logOrchestratorError(
              `[SessionOrchestrator] Failed to apply synthetic failure for orphaned step ${stepState.stepExecutionId}`,
              applyErr,
              { tenantId, runId },
            );
          }

          if (isStarted) {
            // Only a STARTED step may have a live (zombie) container/executor.
            // Tell it to abort and tear down so the orphaned work doesn't keep
            // running detached, and clear the in-flight key so a late refresh
            // can't resurrect liveness for this reaped step.
            redis
              .publish(StreamKeys.stepAbortChannel(stepState.stepExecutionId), 'watchdog-stall')
              .catch(() => {});
            await clearStepInFlight(redis, stepState.stepExecutionId).catch(() => {});
          }
        }
      } catch (err) {
        logOrchestratorError('[SessionOrchestrator] Step-stall watchdog scan failed', err, {
          component: 'step-stall-watchdog',
        });
      }
    }

    return timers.length;
  };
}
