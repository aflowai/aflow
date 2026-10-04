/**
 * Fire time schedules, and drain what firing recorded.
 *
 * Two independent cycles. Discovery claims tenants from the schedule due
 * pointer, reads their due rows through the index the predicate already had,
 * and — in one transaction per occurrence — advances the schedule and records a
 * dispatch. Dispatch claims recorded occurrences and lowers each to the same
 * `start_run` / `resume_run` control message every other producer uses.
 *
 * They are separate because coupling them loses fires. Draining only when
 * something new came due leaves a recorded occurrence waiting on an unrelated
 * schedule's next tick, in any tenant, anywhere in the fleet.
 *
 * Nothing here holds a fleet-wide lock. Exclusion is the two claims: a tenant is
 * claimed with `SKIP LOCKED` and a lease, and so is an occurrence, so two
 * instances cannot work the same one and a claimant that dies hands its work
 * back at lease expiry rather than taking it away.
 */
import type { Redis } from 'ioredis';
import { getOrchestratorLogger, logOrchestratorError } from '../lib/orchestratorLogger.js';
import type postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  IdempotencyKey,
  TraceId,
  PayloadRef,
  PersistentAgentTarget,
  SystemRole,
  AgentId,
} from '@aflow/schemas';
import {
  agentTargetKey,
  getNextCronFireTime,
  backgroundTaskControlPlane,
  resolveInputTemplate,
  type BackgroundTaskMode,
  type InputResolutionContext,
  type SourceRunContext,
  type ActorContext,
} from '@aflow/schemas';
import { createLeasedWorkConsumer, type LeasedWorkResult } from '@aflow/lib';
import {
  addControlMessage,
  claimControlDispatchIdempotency,
  releaseControlDispatchIdempotency,
  getSessionState,
} from '@aflow/redis';
import {
  claimDueTenants,
  claimScheduleDispatches,
  deleteScheduleDispatch,
  insertScheduleDispatch,
  releaseScheduleDispatch,
  releaseTenantDueClaim,
  settleTenantDue,
  SCHEDULE_DUE_POINTER,
  type ScheduleDispatchRow,
} from '@aflow/database';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleContext,
  type BackgroundTaskCycleResult,
  type BackgroundTaskRunner,
} from '@aflow/lib';

const DUE_TASK_ID = 'orchestrator.schedule_evaluator';
const DISPATCH_TASK_ID = 'orchestrator.schedule_dispatch';
const RECORDER_TASK_ID = 'orchestrator.completion_schedule_recorder';

/**
 * How long a failed dispatch waits before another instance may take it. The
 * claim itself is the retry timer, so this is the backoff.
 */
const DISPATCH_RETRY_BACKOFF_MS = 30_000;

/**
 * Attempts after which an occurrence is abandoned rather than retried forever.
 * The failure is written to the schedule's `last_error`, which is the operator's
 * view of it.
 */
const DISPATCH_MAX_ATTEMPTS = 5;

const OWNERLESS_SCHEDULE_ERROR =
  'Schedule has no creator identity (creator_user_id) — runs it starts cannot resolve credentials and would fail on their first step. Recreate the schedule from a user-initiated session.';

export interface ScheduleEvaluatorConfig {
  redis: Redis;
  sqlClient: postgres.Sql;
  instanceId?: string;
  /** Override the registry's mode, for tests. Production resolves it. */
  mode?: BackgroundTaskMode;
}

/** What an `on_completion` schedule matches on, and what its inputs can read. */
export interface TerminalRunFacts {
  tenantId: string;
  runId: string;
  spaceId: string;
  target: PersistentAgentTarget;
  /** The durable terminal status, as written to `sessions`. */
  status: string;
  outputRef?: string;
}

/**
 * Implemented by the evaluator, depended on by whoever makes a terminal run
 * durable. Narrow on purpose: the caller owns when a run is durable, not what
 * firing means.
 */
export interface CompletionScheduleRecorder {
  recordForTerminalRun(run: TerminalRunFacts): Promise<number>;
}

interface DueScheduleRow {
  id: string;
  tenant_schema: string;
  tenant_id: string;
  space_id: string;
  name: string;
  action: string;
  target_kind: string | null;
  target_system_role: string | null;
  target_agent_id: string | null;
  agent_version: string | null;
  target_session_id: string | null;
  target_step_execution_id: string | null;
  kind: string;
  cron_expression: string | null;
  timezone: string;
  scheduled_at: Date | null;
  /**
   * Rendered by Postgres rather than read as a Date: the advance compares it
   * back against the stored value, and a timestamptz round-tripped through a
   * JS Date loses the sub-millisecond digits, so every comparison would fail.
   */
  next_fire_at_text: string | null;
  source_kind: string | null;
  source_system_role: string | null;
  source_agent_id: string | null;
  source_status: string | null;
  input_template: Record<string, unknown>;
  status: string;
  max_firings: number | null;
  firing_count: number;
  last_session_id: string | null;
  expires_at: Date | null;
  creator_user_id: string | null;
  creator_tenant_role: string | null;
  creator_space_role: string | null;
}

interface DispatchItem extends Record<string, unknown> {
  tenantId: string;
  scheduleId: string;
  scheduleName: string;
  schemaName: string;
  spaceId: string;
  action: string;
  targetKind: string | null;
  targetSystemRole: string | null;
  targetAgentId: string | null;
  agentVersion: string | null;
  targetSessionId: string | null;
  targetStepExecutionId: string | null;
  resolvedInput: Record<string, unknown>;
  firingCount: number;
  idempotencyKey: string;
  creatorUserId: string | null;
  creatorTenantRole: string | null;
  creatorSpaceRole: string | null;
}

const SCHEDULE_COLUMNS = `
  id, space_id, name, action,
  target_kind, target_system_role, target_agent_id, agent_version,
  target_session_id, target_step_execution_id, kind,
  cron_expression, timezone, scheduled_at,
  next_fire_at::text AS next_fire_at_text,
  source_kind, source_system_role, source_agent_id, source_status,
  input_template,
  status, max_firings, firing_count,
  last_session_id, expires_at,
  creator_user_id, creator_tenant_role, creator_space_role
`;

/** What the advance writes, derived from the schedule's own limits. */
function nextFireState(
  schedule: DueScheduleRow,
  newFiringCount: number,
): { nextFireAt: string | null; status: string } {
  let nextFireAt: string | null = null;
  if (schedule.kind === 'cron' && schedule.cron_expression) {
    nextFireAt = getNextCronFireTime(schedule.cron_expression, schedule.timezone);
  }
  const expired =
    schedule.kind === 'one_shot' ||
    (schedule.max_firings !== null && newFiringCount >= schedule.max_firings) ||
    (schedule.expires_at !== null && new Date(schedule.expires_at) <= new Date());
  if (expired) return { nextFireAt: null, status: 'expired' };
  return { nextFireAt, status: 'active' };
}

export class ScheduleEvaluator {
  private readonly redis: Redis;
  private readonly sqlClient: postgres.Sql;
  private readonly instanceId: string;
  private readonly due: BackgroundTaskRunner;
  private readonly dispatch: BackgroundTaskRunner;
  private readonly dispatchLeaseMs: number;
  private readonly resolvedMode: () => BackgroundTaskMode;
  private readonly recorderMode: () => BackgroundTaskMode;
  private readonly dueLeaseMs: number;

  constructor(config: ScheduleEvaluatorConfig) {
    this.redis = config.redis;
    this.sqlClient = config.sqlClient;
    this.instanceId = config.instanceId ?? randomUUID();

    const dueRuntime = backgroundTaskControlPlane().resolve(DUE_TASK_ID);
    const dispatchRuntime = backgroundTaskControlPlane().resolve(DISPATCH_TASK_ID);
    // Completion recording carries its own task: due-time discovery's disable
    // is declared safe, and recording refusals park terminal projection
    // candidates — a consequence discovery's switch must not silently gain.
    const recorderRuntime = backgroundTaskControlPlane().resolve(RECORDER_TASK_ID);
    const resolvedMode = config.mode ?? dueRuntime.mode;
    this.resolvedMode = () => resolvedMode;
    const recorderMode = config.mode ?? recorderRuntime.mode;
    this.recorderMode = () => recorderMode;
    this.dispatchLeaseMs = dispatchRuntime.maxCycleMs;
    this.dueLeaseMs = dueRuntime.maxCycleMs;

    this.due = createBackgroundTaskRunner(
      {
        taskId: DUE_TASK_ID,
        scope: dueRuntime.scope,
        intervalMs: dueRuntime.intervalMs ?? 15_000,
        maxBatch: dueRuntime.maxBatch,
        maxCycleMs: dueRuntime.maxCycleMs,
        mode: config.mode ?? dueRuntime.mode,
        logger: getOrchestratorLogger(),
      },
      (ctx) => this.discoverDue(ctx),
    );

    this.dispatch = createBackgroundTaskRunner(
      {
        taskId: DISPATCH_TASK_ID,
        scope: dispatchRuntime.scope,
        intervalMs: dispatchRuntime.intervalMs ?? 15_000,
        maxBatch: dispatchRuntime.maxBatch,
        maxCycleMs: dispatchRuntime.maxCycleMs,
        mode: config.mode ?? dispatchRuntime.mode,
        logger: getOrchestratorLogger(),
      },
      (ctx) => this.drainDispatches(ctx.maxBatch, ctx.mode === 'observe'),
    );
  }

  start(): void {
    this.due.start();
    this.dispatch.start();
    getOrchestratorLogger().debug(`[ScheduleEvaluator] Started (instanceId=${this.instanceId})`);
  }

  async stop(): Promise<void> {
    await Promise.all([this.due.stop(), this.dispatch.stop()]);
    getOrchestratorLogger().debug('[ScheduleEvaluator] Stopped');
  }

  /** One discovery cycle followed by one drain. Used by tests and operator tools. */
  async evaluateOnce(): Promise<void> {
    await this.due.runOnce();
    await this.dispatch.runOnce();
  }

  // ============================================================================
  // Discovery — claim due tenants, record their occurrences
  // ============================================================================

  private async discoverDue(ctx: BackgroundTaskCycleContext): Promise<BackgroundTaskCycleResult> {
    const claimToken = randomUUID();
    const claimed = await claimDueTenants(this.sqlClient, SCHEDULE_DUE_POINTER, {
      limit: ctx.maxBatch,
      leaseMs: this.dueLeaseMs,
      claimToken,
    });
    if (claimed.length === 0) return { candidates: 0 };

    // One budget for the whole cycle, not one per tenant. Reusing the batch
    // ceiling per tenant multiplies it by the number of tenants claimed, and the
    // resulting cycle outlives the tenant leases that are its only exclusion.
    let remaining = ctx.maxBatch;
    let recorded = 0;
    let failed = 0;
    let truncated = 0;
    let workIndex = 0;

    const tenants = createLeasedWorkConsumer<(typeof claimed)[number]>({
      name: 'schedule-due-tenants',
      work: async (claim) => {
        // A slice, not the whole remainder. Claims come back oldest-due first
        // and a settled tenant with overdue rows left keeps its old score, so
        // handing the head of the queue the full budget lets one tenant with a
        // deep backlog win every cycle while the rest are claimed, released,
        // and never advanced. Everyone claimed this cycle gets a share; what a
        // tenant does not use flows to the ones after it.
        const index = workIndex++;
        const share = Math.max(1, Math.ceil(remaining / (claimed.length - index)));
        try {
          const outcome = await this.recordDueSchedules(
            claim.tenantId,
            Math.min(share, remaining),
            ctx,
          );
          recorded += outcome.recorded;
          remaining -= outcome.attempted;
          if (outcome.truncated) truncated++;
          return { kind: 'completed' };
        } catch (err) {
          failed++;
          logOrchestratorError('[ScheduleEvaluator] tenant discovery failed', err, {
            tenantId: claim.tenantId,
          });
          // Settled anyway: the due rows stay where they are and the cadence is
          // the retry pace — holding the tenant pointer would only starve the
          // ones behind it.
          return { kind: 'failed_settled' };
        }
      },
      ack: async (claim) => {
        // A rearmed settlement is a refusal in the contract's terms: work
        // landed mid-cycle, the recompute was discarded, and the claim is
        // already handed back for the next cycle to see the newer state.
        const settlement = await settleTenantDue(
          this.sqlClient,
          SCHEDULE_DUE_POINTER,
          claim,
          claimToken,
        );
        return !settlement.rearmed;
      },
      release: (claim) =>
        releaseTenantDueClaim(this.sqlClient, SCHEDULE_DUE_POINTER, claim.tenantId, claimToken),
      onEvent: (event) => {
        switch (event.kind) {
          case 'ack_error':
            logOrchestratorError('[ScheduleEvaluator] settle failed', event.error, {
              tenantId: event.claim.tenantId,
            });
            break;
          case 'release_error':
            logOrchestratorError(
              '[ScheduleEvaluator] release failed; the lease expires instead',
              event.error,
              { tenantId: event.claim.tenantId },
            );
            break;
          case 'discarded':
          case 'discard_error':
          case 'work_error':
          case 'ack_refused':
          case 'retire_refused':
          case 'retire_error':
          case 'disposition_failed':
          case 'budget_error':
          case 'after_completed_error':
            break;
        }
      },
    });

    // Holding a lease is itself a side effect: it keeps the tenant away from
    // whatever else would fire it while this one only watches — observe
    // releases everything unworked.
    const batch = await tenants.runClaimed(claimed, {
      shouldContinue:
        ctx.mode === 'observe'
          ? () => false
          : () => remaining > 0 && !ctx.budgetExhausted() && !ctx.signal.aborted,
    });
    if (ctx.mode === 'observe') return { candidates: claimed.length };
    const deferred = batch.released + truncated;

    // Fire what this cycle just recorded rather than waiting a cadence for the
    // dispatch runner: the drain is recovery, not the normal path to a run.
    // Skipped once the budget is gone — the drain runs a full cycle under its
    // own ceiling, and a discovery cycle that starts one anyway occupies
    // roughly twice the lease it holds.
    if (recorded > 0 && !ctx.budgetExhausted() && !ctx.signal.aborted) {
      await this.dispatch.runOnce();
    }

    if (backgroundWorkVerboseLogsEnabled()) {
      getOrchestratorLogger().info('[background-work] schedule discovery cycle', {
        trigger: 'candidate',
        claimed: claimed.length,
        recorded,
        failed,
        deferred,
      });
    }

    return {
      candidates: claimed.length,
      processed: recorded,
      failed,
      // Work left behind by the budget must raise this too — but only when the
      // cycle actually moved something. A backlog of rows that fail on every
      // attempt leaves them all still due, and re-arming at zero delay on that
      // turns the evaluator into a hot loop against Postgres with no backoff;
      // the cadence is the right pace for retrying failures.
      hasMore: recorded > 0 && (deferred > 0 || claimed.length === ctx.maxBatch),
    };
  }

  private async recordDueSchedules(
    tenantId: string,
    limit: number,
    ctx: BackgroundTaskCycleContext,
  ): Promise<{ recorded: number; attempted: number; truncated: boolean }> {
    const schemaName = schemaFor(tenantId);

    // Retiring is a separate act from not-firing, and both are needed. The
    // state after a run was the only thing that ever set `expired`, so a
    // schedule whose end passed between firings kept its `active` row: not
    // selected below, but still counted as armed everywhere a reader asks what
    // this space has running. Bounded like the selection it precedes.
    await this.sqlClient.unsafe(
      `UPDATE "${schemaName}".agent_schedules
          SET status = 'expired', next_fire_at = NULL, updated_at = NOW()
        WHERE id IN (
          SELECT id FROM "${schemaName}".agent_schedules
           WHERE status = 'active'
             AND expires_at IS NOT NULL
             AND expires_at <= NOW()
           LIMIT $1::int
        )`,
      [limit],
    );

    const rows = await this.sqlClient.unsafe<DueScheduleRow[]>(
      `SELECT ${SCHEDULE_COLUMNS}
         FROM "${schemaName}".agent_schedules
        WHERE status = 'active'
          AND kind IN ('cron', 'one_shot')
          AND next_fire_at <= NOW()
          -- An expiry that does not prevent a firing is not an expiry. It was
          -- only consulted when computing the state AFTER a run, so a schedule
          -- already past its end fired once more and was retired afterwards —
          -- which is exactly the run the operator set an expiry to avoid. The
          -- retirement above covers the same rows; this stands for one that
          -- expires between the two statements.
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY next_fire_at
        LIMIT $1::int`,
      [limit],
    );

    let recorded = 0;
    let attempted = 0;
    for (const raw of rows) {
      if (ctx.budgetExhausted() || ctx.signal.aborted) {
        return { recorded, attempted, truncated: true };
      }
      const schedule: DueScheduleRow = { ...raw, tenant_schema: schemaName, tenant_id: tenantId };
      attempted++;
      try {
        if (await this.recordOccurrence(schedule)) recorded++;
      } catch (err) {
        logOrchestratorError(`[ScheduleEvaluator] Failed to record schedule ${schedule.id}:`, err, {
          scheduleId: schedule.id,
          tenantId,
        });
        await this.setScheduleError(
          schemaName,
          schedule.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return { recorded, attempted, truncated: rows.length === limit };
  }

  /**
   * Advance the schedule and record the occurrence in one transaction.
   *
   * The advance is what makes the row stop being due, so it and the durable
   * record of the occurrence have to commit together. Either both land — the
   * occurrence exists once and will be dispatched — or neither does and the row
   * is still due, recomputes the same firing count, and produces the same
   * occurrence key.
   */
  private async recordOccurrence(schedule: DueScheduleRow): Promise<boolean> {
    const newFiringCount = schedule.firing_count + 1;

    if (schedule.action === 'start_run' && !schedule.creator_user_id) {
      logOrchestratorError(
        `[ScheduleEvaluator] Schedule ${schedule.id} has no creator_user_id; skipping dispatch`,
        new Error('ownerless_schedule'),
        { scheduleId: schedule.id, tenantId: schedule.tenant_id },
      );
      await this.advanceOnly(schedule, newFiringCount, OWNERLESS_SCHEDULE_ERROR);
      return false;
    }

    let resolvedInput: Record<string, unknown>;
    try {
      const ctx: InputResolutionContext = { now: new Date() };
      resolvedInput = await resolveInputTemplate(schedule.input_template, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logOrchestratorError(
        `[ScheduleEvaluator] Input resolution failed for ${schedule.id}: ${msg}`,
        err,
        { scheduleId: schedule.id, tenantId: schedule.tenant_id },
      );
      await this.advanceOnly(schedule, newFiringCount, `Input resolution failed: ${msg}`);
      return false;
    }

    const { nextFireAt, status } = nextFireState(schedule, newFiringCount);

    return this.sqlClient.begin(async (tx) => {
      const firedCount = await advanceScheduleInTx(
        tx,
        schedule,
        { nextFireAt, status },
        dueGuard(schedule),
      );
      if (firedCount === null) return false;
      const key = occurrenceKey(schedule.id, firedCount);
      await insertScheduleDispatch(tx, {
        idempotencyKey: key,
        tenantId: schedule.tenant_id,
        scheduleId: schedule.id,
        dispatch: buildDispatchItem(schedule, firedCount, key, resolvedInput),
      });
      return true;
    });
  }

  /** Advance past an occurrence that will never be dispatched, recording why. */
  private async advanceOnly(
    schedule: DueScheduleRow,
    newFiringCount: number,
    errorMsg: string,
  ): Promise<void> {
    const { nextFireAt, status } = nextFireState(schedule, newFiringCount);
    await this.sqlClient.begin(async (tx) => {
      await advanceScheduleInTx(tx, schedule, { nextFireAt, status, errorMsg }, dueGuard(schedule));
    });
  }

  // ============================================================================
  // Dispatch — claim recorded occurrences, emit control messages
  // ============================================================================

  private async drainDispatches(
    maxBatch: number,
    observe: boolean,
  ): Promise<BackgroundTaskCycleResult> {
    if (observe) return {};
    const claimToken = randomUUID();
    const claimed = await claimScheduleDispatches(this.sqlClient, {
      limit: maxBatch,
      leaseMs: this.dispatchLeaseMs,
      claimToken,
    });
    if (claimed.length === 0) return { candidates: 0 };

    const retireDispatch = async (row: (typeof claimed)[number]) => {
      await deleteScheduleDispatch(this.sqlClient, row.idempotencyKey, claimToken);
      return true;
    };
    const occurrences = createLeasedWorkConsumer<(typeof claimed)[number]>({
      name: 'schedule-dispatch',
      work: async (row) => {
        try {
          return await this.dispatchOne(row);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logOrchestratorError('[ScheduleEvaluator] dispatch failed', err, {
            scheduleId: row.scheduleId,
            tenantId: row.tenantId,
            attempts: row.attempts,
          });
          return {
            kind: 'failed',
            budget: async () => {
              if (row.attempts >= DISPATCH_MAX_ATTEMPTS) {
                await this.setScheduleError(
                  schemaFor(row.tenantId),
                  row.scheduleId,
                  `Dispatch abandoned after ${String(row.attempts)} attempts: ${message}`,
                );
                return { evict: true };
              }
              // Short of abandonment the occurrence is re-scored with backoff
              // rather than left to its lease: the error rides the row where
              // the next attempt (and the operator) can see it.
              await releaseScheduleDispatch(this.sqlClient, row.idempotencyKey, claimToken, {
                retryAfterMs: DISPATCH_RETRY_BACKOFF_MS,
                error: message,
              });
              return { evict: false };
            },
          };
        }
      },
      ack: retireDispatch,
      retire: retireDispatch,
      onEvent: (event) => {
        switch (event.kind) {
          case 'ack_error':
          case 'retire_error':
          case 'disposition_failed':
          case 'budget_error':
            logOrchestratorError('[ScheduleEvaluator] dispatch settlement failed', event.error, {
              scheduleId: event.claim.scheduleId,
              tenantId: event.claim.tenantId,
            });
            break;
          case 'discarded':
          case 'discard_error':
          case 'work_error':
          case 'ack_refused':
          case 'retire_refused':
          case 'after_completed_error':
          case 'release_error':
            break;
        }
      },
    });
    const batch = await occurrences.runClaimed(claimed);
    // A dispatch whose settlement threw is not cleanly processed: the work
    // landed but the row stays leased, and it retries at lease pace rather
    // than the release backoff — the count has to say so.
    const processed = batch.completed + batch.retired - batch.ackErrors;
    const failed =
      batch.evicted + batch.failures + batch.workErrors + batch.ackErrors + batch.budgetErrors;

    if (backgroundWorkVerboseLogsEnabled()) {
      getOrchestratorLogger().info('[background-work] schedule dispatch cycle', {
        trigger: 'candidate',
        claimed: claimed.length,
        processed,
        failed,
      });
    }

    return {
      candidates: claimed.length,
      processed,
      failed,
      hasMore: claimed.length === maxBatch,
    };
  }

  private async dispatchOne(row: ScheduleDispatchRow): Promise<LeasedWorkResult> {
    const item = row.dispatch as unknown as DispatchItem;

    if (await this.isSpaceArchived(item)) {
      return {
        kind: 'unworkable',
        disposition: async () => {
          getOrchestratorLogger().info(
            `[ScheduleEvaluator] Skipping fire — space ${item.spaceId} is archived`,
          );
          await this.setScheduleError(
            item.schemaName,
            item.scheduleId,
            `Space ${item.spaceId} is archived; schedule fire skipped.`,
          );
          return true;
        },
      };
    }

    if (item.action === 'start_run') {
      return this.emitStartRun(item);
    }
    if (item.action === 'resume_run') {
      return this.emitResumeRun(item);
    }
    // An action nothing lowers is not a transient failure; retrying it forever
    // would keep the occurrence and its error out of the operator's view.
    return {
      kind: 'unworkable',
      disposition: async () => {
        await this.setScheduleError(
          item.schemaName,
          item.scheduleId,
          `Unknown schedule action "${item.action}"; nothing dispatched.`,
        );
        return true;
      },
    };
  }

  private async emitStartRun(item: DispatchItem): Promise<LeasedWorkResult> {
    const creatorUserId = item.creatorUserId;
    const target = resolveDispatchTarget(item);
    if (!creatorUserId || !target) {
      return {
        kind: 'unworkable',
        disposition: async () => {
          await this.setScheduleError(
            item.schemaName,
            item.scheduleId,
            creatorUserId ? 'Schedule target columns are malformed.' : OWNERLESS_SCHEDULE_ERROR,
          );
          return true;
        },
      };
    }

    const runId = occurrenceRunId(item.idempotencyKey);
    // The drain is at-least-once: it can die between the XADD and the delete.
    // The claim is what makes a redelivery harmless — the loser learns which run
    // the winner started and retires the occurrence instead of starting another.
    const claim = await claimControlDispatchIdempotency(this.redis, item.idempotencyKey, runId);
    if (!claim.claimed) {
      getOrchestratorLogger().debug(
        `[ScheduleEvaluator] Occurrence ${item.idempotencyKey} already started run ${String(claim.existingRunId)}`,
      );
      return { kind: 'completed' };
    }

    // Give the claim back if the enqueue fails: the retry would otherwise find
    // the key held, read that as "already started", and retire an occurrence
    // that never produced a run.
    try {
      await addControlMessage(this.redis, {
        messageVersion: 1,
        type: 'start_run',
        tenantId: item.tenantId as TenantId,
        runId,
        target,
        agentVersion: item.agentVersion ?? '1',
        inputRef: encodeInput(item.resolvedInput),
        traceId: `sched-${item.scheduleId.slice(0, 8)}-${runId.slice(0, 8)}` as TraceId,
        idempotencyKey: item.idempotencyKey as IdempotencyKey,
        createdBy: creatorUserId,
        requestedAtMs: Date.now(),
        spaceId: item.spaceId,
        trigger: 'schedule',
        actorContext: buildActorContext({
          tenantId: item.tenantId,
          spaceId: item.spaceId,
          creatorUserId,
          creatorTenantRole: item.creatorTenantRole,
          creatorSpaceRole: item.creatorSpaceRole,
        }),
        activatedByPerson: false,
      });
    } catch (err) {
      // Released so the retry can claim, which is safe only because the run id
      // is derived from the occurrence: if the XADD actually landed, the retry
      // emits the same id and `startRun` deduplicates it. Releasing while the id
      // was random is what turned an ambiguous write into two runs.
      await releaseControlDispatchIdempotency(this.redis, item.idempotencyKey, runId);
      throw err;
    }

    await this.recordLastSession(item.schemaName, item.scheduleId, runId);
    getOrchestratorLogger().debug(
      `[ScheduleEvaluator] Fired schedule "${item.scheduleName}" → run ${runId} (target: ${agentTargetKey(target)})`,
    );
    return { kind: 'completed' };
  }

  private async emitResumeRun(item: DispatchItem): Promise<LeasedWorkResult> {
    if (!item.targetSessionId) {
      return {
        kind: 'unworkable',
        disposition: async () => {
          await this.setScheduleError(
            item.schemaName,
            item.scheduleId,
            'Resume schedule has no target session.',
          );
          return true;
        },
      };
    }

    const pausedStepId = await this.getPausedStepExecution(item.tenantId, item.targetSessionId);
    if (!pausedStepId) {
      return {
        kind: 'unworkable',
        disposition: async () => {
          await this.setScheduleError(
            item.schemaName,
            item.scheduleId,
            `Target run ${item.targetSessionId!} is not in PAUSED state`,
          );
          return true;
        },
      };
    }

    const claim = await claimControlDispatchIdempotency(
      this.redis,
      item.idempotencyKey,
      item.targetSessionId,
    );
    if (!claim.claimed) {
      return { kind: 'completed' };
    }

    try {
      await addControlMessage(this.redis, {
        messageVersion: 1,
        type: 'resume_run',
        tenantId: item.tenantId as TenantId,
        runId: item.targetSessionId as SessionId,
        stepExecutionId: (item.targetStepExecutionId ?? pausedStepId) as StepExecutionId,
        inputRef: encodeInput(item.resolvedInput),
        traceId: `sched-resume-${item.scheduleId.slice(0, 8)}` as TraceId,
        idempotencyKey: item.idempotencyKey as IdempotencyKey,
        requestedAtMs: Date.now(),
        // Whoever started the conversation is not here for what the schedule
        // wakes, and an agent can schedule its own resume.
        activatedByPerson: false,
      });
    } catch (err) {
      await releaseControlDispatchIdempotency(
        this.redis,
        item.idempotencyKey,
        item.targetSessionId,
      );
      throw err;
    }

    getOrchestratorLogger().debug(
      `[ScheduleEvaluator] Fired resume schedule "${item.scheduleName}" → run ${item.targetSessionId}`,
    );
    return { kind: 'completed' };
  }

  // ============================================================================
  // on_completion — driven by the durable terminal record, same outbox
  // ============================================================================

  /**
   * Record matching `on_completion` schedules for a run whose terminal state has
   * just become durable, then drain immediately.
   *
   * The occurrences and the mark that says they were created commit together, so
   * the transition that owes a firing is itself the re-drivable record: a blip
   * anywhere in here rolls the whole thing back, the mark stays null, and the
   * caller — which cannot acknowledge work it did not finish — comes back to a
   * row that recomputes the identical occurrence keys. A durable outbox is not
   * enough on its own; a firing recorded best-effort off the terminal write is
   * lost to one blip with no record anywhere that it was owed.
   *
   * `completion_schedules_fired_at` is the exactly-once token rather than the
   * presence of a pending row: the occurrences are retired by the dispatcher, so
   * anything deleted on the way out cannot also be what says the run has fired.
   */
  async recordForTerminalRun(run: TerminalRunFacts): Promise<number> {
    // Gated on the recorder's OWN task, not due-time discovery's: discovery is
    // safe to disable (cron firings just wait), while refusing to record parks
    // every terminal projection candidate armed and re-flushed each cycle — a
    // consequence only this task's break-glass switch may carry. Thrown, not
    // returned as success — the caller acknowledges the terminal candidate on
    // success while completion_schedules_fired_at is still null, and nothing
    // ever re-arms a terminal run, so returning would turn "suspended while
    // disabled" into "silently lost". The throw keeps the candidate armed, off
    // the eviction budget, until re-enable.
    if (this.recorderMode() !== 'enabled') {
      throw new Error(
        `completion recording is ${this.recorderMode()}; on_completion for run ${run.runId} is suspended`,
      );
    }
    const schemaName = schemaFor(run.tenantId);
    const sourceMatch =
      run.target.kind === 'platform-role'
        ? { column: 'source_system_role', value: run.target.systemRole, kind: 'platform-role' }
        : { column: 'source_agent_id', value: run.target.agentId, kind: 'custom-agent' };
    // A cancellation is neither a success nor a failure, and lowering it to one
    // would fire every "on failure" schedule the moment a user stops a run. It
    // matches `any_terminal` and nothing else.
    const sourceStatus = run.status.toLowerCase();
    const sourceRun: SourceRunContext = {
      runId: run.runId,
      status: sourceStatus,
      ...(run.outputRef !== undefined ? { output: run.outputRef } : {}),
    };

    const recorded = await this.sqlClient.begin(async (tx) => {
      // Guarded on the row still holding the terminal status this call fires
      // for: the terminal upsert and this claim are separate transactions, and
      // a projection lease expiring between them lets a peer project a retried
      // run's live status — and clear the mark — in the gap. A stale claim
      // landing after that would set the mark against a live row and swallow
      // the next terminal transition's firing. A transition superseded before
      // it fires is skipped instead, like one erased before it projects.
      const claimed = await tx.unsafe<Array<{ session_id: string }>>(
        `UPDATE "${schemaName}".sessions
            SET completion_schedules_fired_at = NOW()
          WHERE session_id = $1::uuid
            AND completion_schedules_fired_at IS NULL
            AND status = $2
        RETURNING session_id::text AS session_id`,
        [run.runId, run.status],
      );
      if (claimed.length === 0) return 0;

      const rows = await tx.unsafe<DueScheduleRow[]>(
        `SELECT ${SCHEDULE_COLUMNS}
           FROM "${schemaName}".agent_schedules
          WHERE status = 'active'
            AND kind = 'on_completion'
            AND source_kind = $1
            AND ${sourceMatch.column}::text = $2
            AND (source_status = $3 OR source_status = 'any_terminal')
            AND space_id = $4::uuid`,
        [sourceMatch.kind, sourceMatch.value, sourceStatus, run.spaceId],
      );

      // Resolution first, writes after: a template that throws must not abort
      // the transaction the other schedules' occurrences are being written in.
      const resolved: Array<{ schedule: DueScheduleRow; input: Record<string, unknown> }> = [];
      const unresolvable: Array<{ scheduleId: string; message: string }> = [];
      for (const raw of rows) {
        const schedule: DueScheduleRow = {
          ...raw,
          tenant_schema: schemaName,
          tenant_id: run.tenantId,
        };
        try {
          const ctx: InputResolutionContext = { sourceRun, now: new Date() };
          resolved.push({
            schedule,
            input: await resolveInputTemplate(schedule.input_template, ctx),
          });
        } catch (err) {
          unresolvable.push({
            scheduleId: schedule.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      let count = 0;
      for (const { schedule, input } of resolved) {
        const { nextFireAt, status } = nextFireState(schedule, schedule.firing_count + 1);
        // No guard on the count: two source runs completing at once read the
        // same one and must both fire, so the increment is minted inside the
        // statement. Their occurrences are distinct because the counts are.
        const firedCount = await advanceScheduleInTx(tx, schedule, { nextFireAt, status });
        if (firedCount === null) continue;
        const key = occurrenceKey(schedule.id, firedCount);
        await insertScheduleDispatch(tx, {
          idempotencyKey: key,
          tenantId: schedule.tenant_id,
          scheduleId: schedule.id,
          dispatch: buildDispatchItem(schedule, firedCount, key, input),
        });
        count++;
      }

      for (const failure of unresolvable) {
        logOrchestratorError(
          `[ScheduleEvaluator] on_completion input resolution failed for ${failure.scheduleId}:`,
          new Error(failure.message),
          { scheduleId: failure.scheduleId, tenantId: run.tenantId, sourceRunId: run.runId },
        );
        await tx.unsafe(
          `UPDATE "${schemaName}".agent_schedules
              SET last_error = $1, updated_at = NOW()
            WHERE id = $2::uuid`,
          [`Input resolution failed: ${failure.message}`, failure.scheduleId],
        );
      }

      return count;
    });

    if (recorded > 0) {
      // A nudge, not a wait. The occurrences are already durable and the drain
      // has its own cadence, so this only trims latency — and awaiting it here
      // would couple applying one run's terminal state to draining the whole
      // fleet's outbox, for up to the drain's full cycle budget, inside the
      // projection worker's own cycle.
      void this.dispatch.runOnce().catch((err: unknown) => {
        logOrchestratorError(
          '[ScheduleEvaluator] immediate drain after on_completion failed',
          err,
          {
            tenantId: run.tenantId,
            sourceRunId: run.runId,
          },
        );
      });
    }
    return recorded;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private async isSpaceArchived(item: DispatchItem): Promise<boolean> {
    try {
      const rows = await this.sqlClient.unsafe<Array<{ archived_at: Date | string | null }>>(
        `SELECT archived_at FROM "${item.schemaName}".spaces WHERE id = $1::uuid`,
        [item.spaceId],
      );
      return Boolean(rows[0]?.archived_at);
    } catch (err) {
      // Lookup failed — proceed. The downstream preHandler 410s any further work
      // the session tries to do, so the failure mode is bounded.
      getOrchestratorLogger().warn(
        `[ScheduleEvaluator] Archive-state lookup failed for space ${item.spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private async getPausedStepExecution(tenantId: string, runId: string): Promise<string | null> {
    try {
      const runState = await getSessionState(this.redis, tenantId, runId);
      if (runState?.status === 'PAUSED' && runState.currentStepExecutionId) {
        return runState.currentStepExecutionId;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async recordLastSession(
    schemaName: string,
    scheduleId: string,
    runId: string,
  ): Promise<void> {
    try {
      await this.sqlClient.unsafe(
        `UPDATE "${schemaName}".agent_schedules
            SET last_session_id = $1::uuid, last_error = NULL, updated_at = NOW()
          WHERE id = $2::uuid`,
        [runId, scheduleId],
      );
    } catch (err) {
      logOrchestratorError('[ScheduleEvaluator] Failed to record last session', err, {
        scheduleId,
        schemaName,
      });
    }
  }

  private async setScheduleError(
    schemaName: string,
    scheduleId: string,
    errorMsg: string,
  ): Promise<void> {
    try {
      await this.sqlClient.unsafe(
        `UPDATE "${schemaName}".agent_schedules
            SET last_error = $1, updated_at = NOW()
          WHERE id = $2::uuid`,
        [errorMsg, scheduleId],
      );
    } catch (err) {
      logOrchestratorError(
        `[ScheduleEvaluator] Failed to set error on schedule ${scheduleId}:`,
        err,
        { scheduleId, schemaName },
      );
    }
  }
}

function schemaFor(tenantId: string): string {
  const schemaName = `t_${tenantId.replace(/-/g, '')}`;
  if (!/^t_[0-9a-f]{32}$/.test(schemaName)) {
    throw new Error(`Refusing to build schedule SQL for invalid tenant: ${tenantId}`);
  }
  return schemaName;
}

function encodeInput(resolvedInput: Record<string, unknown>): PayloadRef {
  if (Object.keys(resolvedInput).length === 0) return 'inline:e30=' as PayloadRef;
  return `inline:${Buffer.from(JSON.stringify(resolvedInput)).toString('base64')}`;
}

function resolveDispatchTarget(item: DispatchItem): PersistentAgentTarget | null {
  if (item.targetKind === 'platform-role' && item.targetSystemRole) {
    return { kind: 'platform-role', systemRole: item.targetSystemRole as SystemRole };
  }
  if (item.targetKind === 'custom-agent' && item.targetAgentId) {
    return { kind: 'custom-agent', agentId: item.targetAgentId as AgentId };
  }
  return null;
}

function buildDispatchItem(
  schedule: DueScheduleRow,
  firingCount: number,
  idempotencyKey: string,
  resolvedInput: Record<string, unknown>,
): DispatchItem {
  return {
    tenantId: schedule.tenant_id,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    schemaName: schedule.tenant_schema,
    spaceId: schedule.space_id,
    action: schedule.action,
    targetKind: schedule.target_kind,
    targetSystemRole: schedule.target_system_role,
    targetAgentId: schedule.target_agent_id,
    agentVersion: schedule.agent_version,
    targetSessionId: schedule.target_session_id,
    targetStepExecutionId: schedule.target_step_execution_id,
    resolvedInput,
    firingCount,
    idempotencyKey,
    creatorUserId: schedule.creator_user_id,
    creatorTenantRole: schedule.creator_tenant_role,
    creatorSpaceRole: schedule.creator_space_role,
  };
}

/**
 * The run id for one occurrence, derived from the occurrence itself.
 *
 * A retry after an ambiguous emit must present the same id or it cannot be
 * deduplicated: `addControlMessage` is a single XADD, and a failover that drops
 * the reply after the server applied it looks exactly like a failure. Minting a
 * fresh id per attempt turns that ambiguity into two runs for one occurrence —
 * `startRun` deduplicates on the run id and has nothing else to go on.
 */
function occurrenceRunId(idempotencyKey: string): SessionId {
  const h = createHash('sha1').update(SCHEDULE_RUN_NAMESPACE).update(idempotencyKey).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as SessionId;
}

const SCHEDULE_RUN_NAMESPACE = 'aflow:schedule-occurrence';

/** Names one firing of one schedule. The count comes from the advance itself. */
function occurrenceKey(scheduleId: string, firedCount: number): string {
  return `schedule:${scheduleId}:${String(firedCount)}`;
}

/** The row state a due-driven advance was computed from. */
function dueGuard(schedule: DueScheduleRow): {
  firingCount: number;
  status: string;
  nextFireAtText: string | null;
} {
  return {
    firingCount: schedule.firing_count,
    status: schedule.status,
    nextFireAtText: schedule.next_fire_at_text,
  };
}

/**
 * Advance the schedule past one occurrence, returning the count that names it.
 *
 * `expect` guards the row against the state the caller read. `firing_count` is
 * the version: it is only ever written as `+ 1` by this statement, is never
 * reset, and is what names the occurrence — so the guard and the occurrence
 * identity are the same fact, and a second instance working from the same read
 * loses instead of minting a second occurrence for one due time. `status` and
 * `next_fire_at` are in the predicate for the operator: a pause or a reschedule
 * landing between the read and the advance must win, not be overwritten.
 *
 * Returns null when the row moved, which is not an error — the occurrence
 * belongs to whoever moved it.
 *
 * Callers that fire from an event rather than a due time pass no `expect`: two
 * of them legitimately read the same count and must both fire, which is why the
 * increment is computed inside the statement rather than by the caller.
 */
export async function advanceScheduleInTx(
  tx: postgres.TransactionSql,
  schedule: DueScheduleRow,
  args: { nextFireAt: string | null; status: string; errorMsg?: string },
  expect?: { firingCount: number; status: string; nextFireAtText: string | null },
): Promise<number | null> {
  // Without an expected count — the on_completion case, where two source runs
  // legitimately read the same one and must both fire — the row still has to be
  // eligible. The caller's status is computed from a read that may be minutes
  // old, so an operator pausing in that window would otherwise be overwritten
  // back to active, and a `max_firings` reached concurrently would be passed.
  const guard = expect
    ? ` AND firing_count = $5::int
        AND status = $6
        AND next_fire_at IS NOT DISTINCT FROM $7::timestamptz`
    : ` AND status = 'active'
        AND (max_firings IS NULL OR firing_count < max_firings)`;
  // The terminal flip is derived from the post-increment count inside the
  // statement, never taken from the caller: two concurrent advances both pass
  // the guard one increment apart, and the later writer's caller-computed
  // status is stale — writing its 'active' back would leave an exhausted
  // schedule eligible forever.
  const rows = await tx.unsafe<Array<{ firing_count: number }>>(
    `UPDATE "${schedule.tenant_schema}".agent_schedules
        SET firing_count = firing_count + 1,
            last_fired_at = NOW(),
            next_fire_at = CASE
              WHEN max_firings IS NOT NULL AND firing_count + 1 >= max_firings THEN NULL
              ELSE $1::timestamptz END,
            status = CASE
              WHEN max_firings IS NOT NULL AND firing_count + 1 >= max_firings THEN 'expired'
              ELSE $2 END,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $4::uuid${guard}
    RETURNING firing_count`,
    expect
      ? [
          args.nextFireAt,
          args.status,
          args.errorMsg ?? null,
          schedule.id,
          expect.firingCount,
          expect.status,
          expect.nextFireAtText,
        ]
      : [args.nextFireAt, args.status, args.errorMsg ?? null, schedule.id],
  );
  const next = rows[0]?.firing_count;
  if (next === undefined) {
    if (!expect) {
      // A miss here is a concurrent change — an operator pause, a delete, or a
      // sibling advance that exhausted the count — none of which makes this
      // occurrence fireable, and none of which may fail the caller: its
      // transaction also carries the completion marker and every sibling
      // schedule's occurrence. The one state that cannot resolve itself is a
      // row a stale writer left exhausted but still active; retire it so it
      // stops being selected.
      await tx.unsafe(
        `UPDATE "${schedule.tenant_schema}".agent_schedules
            SET status = 'expired', next_fire_at = NULL, updated_at = NOW()
          WHERE id = $1::uuid AND status = 'active'
            AND max_firings IS NOT NULL AND firing_count >= max_firings`,
        [schedule.id],
      );
    }
    return null;
  }
  return next;
}

/**
 * Build an ActorContext from the schedule's captured creator fields. The
 * orchestrator's startRun uses this to compile the RunAccessGrant.
 */
function buildActorContext(creatorCtx: {
  tenantId: string;
  spaceId: string;
  creatorUserId: string;
  creatorTenantRole: string | null;
  creatorSpaceRole: string | null;
}): ActorContext {
  return {
    userId: creatorCtx.creatorUserId,
    kind: 'system' as const,
    authMethod: 'system' as const,
    tenantId: creatorCtx.tenantId,
    tenantRole: creatorCtx.creatorTenantRole ?? 'member',
    spaceId: creatorCtx.spaceId,
    spaceRole: creatorCtx.creatorSpaceRole ?? 'viewer',
    displayName: 'Schedule Evaluator',
    capturedAt: new Date().toISOString(),
  };
}
