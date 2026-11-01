/**
 * Delivers the waits of the wait primitive that have ended (Plan 339 D1):
 * each waiter is told in its conversation what ended its wait — the event, or
 * its window closing with no event — and a conversation resting at its prompt
 * is woken to read it.
 *
 * A candidate drain under Plan 180: a cycle reads the deliveries due, the
 * fired subjects and the windows due, and with nothing due it reads nothing
 * else. A claimed wait stays in the delivery set until it is settled here, so
 * a process that dies mid-delivery leaves it for a later cycle.
 */
import {
  disownPullRequestWatch,
  markSessionDeclaredWait,
  rearmEndedWait,
  settleEndedWait,
  type EndedWait,
} from '@aflow/redis';
import {
  claimEndedWaits,
  describeWaitOutcome,
  rehydratePausedRunIfAbsent,
} from '@aflow/cybernetic-runtime';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskLogger,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane, WAIT_OUTCOME_ACTOR_ID, type TenantId } from '@aflow/schemas';
import { queueMessageForNextTurn } from '../SessionOrchestrator/helpers/queuedMessage.js';
import { wakeSessionForWait } from '../cybernetic/harness/sessionWakeup.js';
import type { HarnessDeps } from '../cybernetic/harness/types.js';
import { holdAgainForOwner } from '../pullRequestEvents/owner.js';

export const WAIT_DELIVERY_TASK_ID = 'orchestrator.wait_delivery';

/** `renewed` is an owner's wait whose window closed: nothing is posted, and the next one is declared. */
export type WaitDelivery = 'woke' | 'told' | 'session_gone' | 'retry' | 'renewed';

/** The last event an ended wait was told, so the next wait counts from just past it. */
function pastLastEvent(ended: EndedWait): number | undefined {
  const { outcome } = ended;
  if (outcome.endedBy !== 'event') return undefined;
  const last = outcome.laterEvents?.at(-1) ?? outcome.event;
  return last.firedAt + 1;
}

/**
 * A wait the platform declared for a pull request's owner (Plan 339 D4) is
 * renewed after each delivery, so the owner hears every change. A window that
 * closes on it posts nothing: the owner did not ask for it. Where the new wait
 * catches up on an event at once, its registration queues it in the delivery
 * set, so a later cycle delivers it under the same lease and retry.
 */
async function deliverOwnerWait(deps: HarnessDeps, ended: EndedWait): Promise<WaitDelivery> {
  const { registration } = ended;
  const delivered =
    ended.outcome.endedBy === 'window_closed' ? 'renewed' : await deliverToWaiter(deps, ended);
  if (delivered === 'retry') return delivered;
  if (delivered === 'session_gone') {
    await disownPullRequestWatch(deps.redis, registration, registration.sessionId);
    return delivered;
  }
  // A throw here puts this wait back, and its redelivery declares the next one.
  await holdAgainForOwner(deps, registration, pastLastEvent(ended));
  return delivered;
}

/**
 * Tell one waiter that its wait ended. The room post is keyed by the wait, so
 * a second delivery of the same wait posts nothing twice.
 *
 * A conversation resting past the hot-state TTL is cold, not gone: it is
 * rehydrated from its resting snapshot, told and woken. `session_gone` is left
 * for a conversation with no resting snapshot to restore, which has ended.
 *
 * `told` is a conversation not resting at its prompt. A turn in flight did not
 * read the outcome, so the settle that ends it wakes the conversation for it
 * (`wakeSessionForRunWakeups`). One parked on a person or a run reads it at
 * its next turn.
 */
export async function deliverEndedWait(deps: HarnessDeps, ended: EndedWait): Promise<WaitDelivery> {
  return ended.registration.owner !== undefined
    ? deliverOwnerWait(deps, ended)
    : deliverToWaiter(deps, ended);
}

async function deliverToWaiter(deps: HarnessDeps, ended: EndedWait): Promise<WaitDelivery> {
  const { registration, outcome } = ended;
  const tenantId = registration.tenantId as TenantId;
  const post = () =>
    queueMessageForNextTurn(deps.db, deps.redis, {
      tenantId,
      sessionId: registration.sessionId,
      deliveryKey: `wait:${registration.waitId}`,
      actorUserId: WAIT_OUTCOME_ACTOR_ID,
      actorDisplayName: 'Wait',
      body: describeWaitOutcome(registration, outcome),
    });
  let posted = await post();
  if (posted === undefined) {
    // The hash was absent at the post, but a writer may have put it back
    // since. The restore writes only where it is still absent, so it cannot
    // roll back a live `lastMessageSeq`.
    const restored = await rehydratePausedRunIfAbsent(
      deps.redis,
      deps.db,
      tenantId,
      registration.sessionId,
    );
    if (!restored) return 'session_gone';
    posted = await post();
    if (posted === undefined) return 'session_gone';
  }
  // The outcome may be read by a turn that settles later than the mark set at
  // the declaration would last.
  await markSessionDeclaredWait(deps.redis, tenantId, registration.sessionId);
  const woken = await wakeSessionForWait(
    deps,
    tenantId,
    registration.sessionId,
    registration.waitId,
  );
  if (woken === 'rate_limited') return 'retry';
  return woken === 'woke' ? 'woke' : 'told';
}

export interface WaitDeliveryDeps {
  harnessDeps: HarnessDeps;
  logger: BackgroundTaskLogger;
  now?: () => number;
  deliver?: (ended: EndedWait) => Promise<WaitDelivery>;
}

export async function runWaitDeliveryCycle(
  deps: WaitDeliveryDeps,
  ctx: { maxBatch: number; budgetExhausted(): boolean; mode: 'enabled' | 'observe' },
): Promise<BackgroundTaskCycleResult> {
  // Claiming ends a wait; observe mode must not.
  if (ctx.mode === 'observe') return {};
  const { redis } = deps.harnessDeps;
  const now = deps.now ?? Date.now;
  const deliver = deps.deliver ?? ((ended: EndedWait) => deliverEndedWait(deps.harnessDeps, ended));
  const ended = await claimEndedWaits(redis, now(), ctx.maxBatch);
  if (ended.length === 0) return { candidates: 0 };

  let processed = 0;
  let failed = 0;
  for (const [index, wait] of ended.entries()) {
    if (ctx.budgetExhausted()) {
      for (const rest of ended.slice(index)) await rearmEndedWait(redis, rest);
      break;
    }
    try {
      const delivery = await deliver(wait);
      if (delivery === 'retry') {
        await rearmEndedWait(redis, wait);
        failed++;
        continue;
      }
      await settleEndedWait(redis, wait.registration.waitId);
      processed++;
      if (delivery === 'session_gone' || backgroundWorkVerboseLogsEnabled()) {
        deps.logger.info('[wait-delivery] wait ended', {
          waitId: wait.registration.waitId,
          kind: wait.registration.kind,
          subject: wait.registration.subject,
          endedBy: wait.outcome.endedBy,
          delivery,
        });
      }
    } catch (err) {
      failed++;
      deps.logger.warn('[wait-delivery] delivery failed; the wait is put back', {
        waitId: wait.registration.waitId,
        error: err instanceof Error ? err.message : String(err),
      });
      await rearmEndedWait(redis, wait).catch(() => undefined);
    }
  }
  return {
    candidates: ended.length,
    processed,
    failed,
    hasMore: ended.length === ctx.maxBatch && failed === 0,
  };
}

export function createWaitDeliveryTask(deps: WaitDeliveryDeps): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(WAIT_DELIVERY_TASK_ID);
  return createBackgroundTaskRunner(
    {
      taskId: WAIT_DELIVERY_TASK_ID,
      scope: runtime.scope,
      intervalMs: runtime.intervalMs ?? 5_000,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      logger: deps.logger,
    },
    (ctx) => runWaitDeliveryCycle(deps, ctx),
  );
}
