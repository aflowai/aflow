import type { Redis } from 'ioredis';
import {
  getSessionState,
  getDelegationParent,
  upsertPendingDelegationCompletion,
  peekDueDelegationSupervisionCandidates,
  refreshDelegationSupervisionCandidate,
  dropDelegationSupervisionCandidate,
  DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
} from '@aflow/redis';
import type { AgentDefinition, SessionAgentTarget } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { ShardManager } from '../../ShardManager.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import {
  isActiveChildStatus,
  reconcileParentDelegationForChild,
} from './reconcileParentDelegation.js';

/**
 * The other half of the delegation lifecycle: the parent's side of the wait.
 *
 * Everything else in the lifecycle is armed by a child reaching a resting state,
 * so a child that dies without ever resting arms nothing and its parent waits
 * forever. This sweep starts from the wait instead, and acts only on the two
 * shapes nothing else covers: a child resting while its parent still waits, and
 * a child whose hot state is gone.
 *
 * A child that is still active is left alone and the parent is pushed forward
 * with no attempt consumed — a delegation may legitimately run for hours, and an
 * active child already carries its own step-stall candidate whose reaping routes
 * through `failRun` and releases the parent.
 *
 * Reconcile runs before anything durable is written, which is the reverse of the
 * child's own completion path and deliberate: that path upserts first because it
 * is about to ack a stream message and needs the entry to survive a crash in
 * between, while here the marker is the durable record and no cycle consumes it.
 * Writing a pending entry for a child reconcile can still handle would start an
 * escalation clock on a healthy chain, which is the expensive direction of
 * error. The entry is written only for a child reconcile cannot see at all.
 *
 * The sweep never fabricates a failure. Escalation — synthetic FAILED, forced
 * parent failure — stays with the pending drain, so there is exactly one place
 * that can decide a chain is broken.
 */

type AgentDefLoader = (
  tenantId: string,
  target: SessionAgentTarget,
  agentVersion: string,
) => Promise<AgentDefinition>;

export interface SweepDelegationSupervisionDeps {
  redis: Redis;
  payloadStore: PayloadStore;
  agentDefLoader: AgentDefLoader;
  shardManager?: ShardManager | undefined;
  /** Ceiling on waiting parents examined per cycle. */
  maxBatch: number;
  /** Aborted when the cycle runs past its budget; checked between parents. */
  signal?: AbortSignal | undefined;
}

export interface DelegationSupervisionResult {
  /** Due candidates the peek returned. */
  candidates: number;
  /** Parents this instance owns and examined. */
  processed: number;
  /** Parents still legitimately waiting, pushed forward. */
  rescheduled: number;
  /** Children reconciled against a parent that was still waiting on them. */
  reconciled: number;
  /** Children whose state is gone, handed to the pending drain to escalate. */
  escalatable: number;
  /** Candidates whose parent is no longer waiting. */
  dropped: number;
  /** Parents in the wait with no child tracked and no child to reconcile through. */
  untracked: number;
}

export async function sweepDelegationSupervision(
  deps: SweepDelegationSupervisionDeps,
): Promise<DelegationSupervisionResult> {
  const { redis, shardManager, maxBatch, signal } = deps;
  const log = getOrchestratorLogger().child({ component: 'delegation-supervision' });
  const result: DelegationSupervisionResult = {
    candidates: 0,
    processed: 0,
    rescheduled: 0,
    reconciled: 0,
    escalatable: 0,
    dropped: 0,
    untracked: 0,
  };

  const now = Date.now();
  const candidates = await peekDueDelegationSupervisionCandidates(redis, maxBatch, now);
  result.candidates = candidates.length;

  for (const { tenantId, sessionId: parentRunId, dueAtMs } of candidates) {
    if (signal?.aborted) break;
    // Sweeping is shared infra: only the owning shard acts, so a non-owner
    // cannot push a parent forward and reset the owner's clock.
    if (shardManager && !shardManager.ownsRun(parentRunId)) continue;

    try {
      const advanced = await superviseWaitingParent(deps, tenantId, parentRunId, dueAtMs, now);
      result.processed += 1;
      result.rescheduled += advanced.rescheduled;
      result.reconciled += advanced.reconciled;
      result.escalatable += advanced.escalatable;
      result.dropped += advanced.dropped;
      result.untracked += advanced.untracked;
    } catch (err) {
      logOrchestratorError('[delegation-supervision] parent sweep threw', err, {
        tenantId,
        parentRunId,
      });
      // Left armed at its current score, so the next cycle retries. Reading is
      // non-destructive; nothing was consumed by the failed pass.
    }
  }

  if (result.reconciled > 0 || result.escalatable > 0 || result.untracked > 0) {
    log.info(
      `[delegation-supervision] candidates=${String(result.candidates)} ` +
        `processed=${String(result.processed)} reconciled=${String(result.reconciled)} ` +
        `escalatable=${String(result.escalatable)} untracked=${String(result.untracked)} ` +
        `dropped=${String(result.dropped)}`,
    );
  }
  return result;
}

interface ParentOutcome {
  rescheduled: number;
  reconciled: number;
  escalatable: number;
  dropped: number;
  untracked: number;
}

async function superviseWaitingParent(
  deps: SweepDelegationSupervisionDeps,
  tenantId: string,
  parentRunId: string,
  dueAtMs: number,
  now: number,
): Promise<ParentOutcome> {
  const { redis } = deps;
  const log = getOrchestratorLogger().child({ component: 'delegation-supervision' });
  const outcome: ParentOutcome = {
    rescheduled: 0,
    reconciled: 0,
    escalatable: 0,
    dropped: 0,
    untracked: 0,
  };

  const parent = await getSessionState(redis, tenantId, parentRunId);
  if (parent?.status !== 'WAITING_ON_CHILD') {
    // Either the release already landed, or the hot state aged out. A parent
    // whose hash is gone has no live wait to release from here: its durable
    // snapshot is restored by the read path, and that restore writes the
    // session state, which re-arms this index.
    await dropDelegationSupervisionCandidate(redis, tenantId, parentRunId, dueAtMs);
    outcome.dropped = 1;
    return outcome;
  }

  const childRunIds = parent.waitingForChildSessionIds ?? [];
  if (childRunIds.length === 0) {
    // The wait outlived the children it was waiting on: the last
    // `removeWaitingChild` landed and the release write that should have
    // followed it did not. Both release paths do those as two round trips, so a
    // process dying between them produces exactly this.
    //
    // Nothing else recovers it. The drain reads this shape as
    // `parent_not_tracking_child` and deliberately declines to escalate, so
    // leaving the marker to be re-examined means re-examining it until the hot
    // state ages out a day later with the parent never released. Every child is
    // already accounted for, which is the same condition the release itself
    // waits for, so finishing it here is completing an interrupted write rather
    // than inventing an outcome.
    const { leaveChildWaitToRunning } = await import('../helpers/delegationState.js');
    await leaveChildWaitToRunning(redis, tenantId, parentRunId, {
      fromStatus: 'WAITING_ON_CHILD',
    });
    await dropDelegationSupervisionCandidate(redis, tenantId, parentRunId, dueAtMs);
    outcome.untracked = 1;
    log.warn(
      `[delegation-supervision] released parent ${parentRunId}: waiting on no child, so its ` +
        `release write was lost`,
      { tenantId, parentRunId },
    );
    return outcome;
  }

  for (const childRunId of childRunIds) {
    if (deps.signal?.aborted) break;
    const child = await getSessionState(redis, tenantId, childRunId);
    if (child && isActiveChildStatus(child.status)) continue;

    const reconcileOutcome = await reconcileParentDelegationForChild({
      redis,
      payloadStore: deps.payloadStore,
      agentDefLoader: deps.agentDefLoader,
      tenantId,
      childRunId,
      reason: 'delegation-supervision',
    });
    if (reconcileOutcome !== 'child_state_missing') {
      outcome.reconciled += 1;
      log.info(
        `[delegation-supervision] reconciled tenant=${tenantId} parent=${parentRunId} ` +
          `child=${childRunId} childStatus=${child?.status ?? 'missing'} ` +
          `outcome=${reconcileOutcome}`,
      );
      continue;
    }

    // Reconcile is child-keyed and returns before it reads the parent when the
    // child's state is gone, so it can never release this wait. The pending
    // entry is what hands the parent's delegate step to the drain, and the
    // parent step comes from the reverse index the child hash can no longer
    // supply — it is written without an expiry for exactly this.
    const parentStepExecutionId = (await getDelegationParent(redis, tenantId, childRunId))
      ?.parentStepExecutionId;
    if (!parentStepExecutionId) {
      log.error(
        `[delegation-supervision] no parent step for child ${childRunId} of waiting parent ` +
          `${parentRunId}; the lifecycle cannot be armed from here`,
        undefined,
        { tenantId, parentRunId, childRunId, errorCode: 'DELEGATION_PARENT_UNRESOLVABLE' },
      );
      continue;
    }

    await upsertPendingDelegationCompletion(
      redis,
      tenantId,
      childRunId,
      parentRunId,
      parentStepExecutionId,
    );
    outcome.escalatable += 1;
    log.warn(
      `[delegation-supervision] child state gone for a live wait tenant=${tenantId} ` +
        `parent=${parentRunId} child=${childRunId} — handed to the pending drain`,
    );
  }

  await refreshDelegationSupervisionCandidate(
    redis,
    tenantId,
    parentRunId,
    now + DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
  );
  if (outcome.reconciled === 0 && outcome.escalatable === 0) outcome.rescheduled = 1;
  return outcome;
}
