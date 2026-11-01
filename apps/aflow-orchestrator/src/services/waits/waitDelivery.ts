/**
 * Delivers the waits of the wait primitive that have ended (Plan 339 D1):
 * each waiter is told in its conversation what ended its wait — the event, or
 * its window closing with no event — and a conversation resting at its prompt
 * is woken to read it.
 *
 * A candidate drain under Plan 180: a cycle reads the fired subjects and the
 * windows due, and with nothing due it reads nothing else.
 */
import { rearmEndedWait, type EndedWait } from '@aflow/redis';
import { claimEndedWaits, describeWaitOutcome } from '@aflow/cybernetic-runtime';
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

export const WAIT_DELIVERY_TASK_ID = 'orchestrator.wait_delivery';

export type WaitDelivery = 'woke' | 'told' | 'session_gone' | 'retry';

/**
 * Tell one waiter that its wait ended. The room post is keyed by the wait, so
 * a second delivery of the same wait posts nothing twice.
 */
export async function deliverEndedWait(deps: HarnessDeps, ended: EndedWait): Promise<WaitDelivery> {
  const { registration, outcome } = ended;
  const tenantId = registration.tenantId as TenantId;
  const posted = await queueMessageForNextTurn(deps.db, deps.redis, {
    tenantId,
    sessionId: registration.sessionId,
    deliveryKey: `wait:${registration.waitId}`,
    actorUserId: WAIT_OUTCOME_ACTOR_ID,
    actorDisplayName: 'Wait',
    body: describeWaitOutcome(registration, outcome),
  });
  if (posted === undefined) return 'session_gone';
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
