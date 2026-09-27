/**
 * Run-level orphan reconciler.
 *
 * The completion-pending sweeper ({@link reconcileStaleRunForTenant}) only
 * sees runs that already have a `workflow_run_completion_pending` row — i.e.
 * runs that claimed at least one task. A run that dies BEFORE its first task
 * claim (orchestrator restart in the window between `recordRunStart` and the
 * first `claimAndSchedule`, or hot state lost to TTL after a restart) has a
 * durable `workflow_runs` row stuck at `running` with no pending tracking, no
 * tasks, and no live work. Nothing advances it, its parked waiters (the
 * parent Helmsman) never wake, and it keeps pinning the per-workflow
 * concurrency slot.
 *
 * This pass closes that gap. It is strictly additive: runs that DO have a
 * completion-pending row are owned by the completion-pending sweeper and are
 * skipped here (which also means we never re-dispatch a run that already
 * claimed work, so recovery can't duplicate side effects).
 */
import {
  findStalledRunsAcrossSpaces,
  runRecoveryPass,
  stampSchedulerDeadline,
  deriveRunLiveness,
  listCompletionPendingForRun,
  DEFAULT_STALLED_AFTER_MS,
} from '@aflow/cybernetic-runtime';
import type { TenantId } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { dispatchNextOrTerminate } from './dispatch.js';
import { completeRun } from './pauseResume.js';
import { isTerminalRunStatus, loadRunByRunIdAcrossSpaces } from './helpers.js';
import type { HarnessDeps } from './types.js';

const RECONCILE_DEFAULT_BATCH = 100;

export interface ReconcileOrphanedRunsResult {
  /** Stalled-candidate runs examined this pass. */
  scanned: number;
  /** Runs re-dispatched or correctly terminated (recovered, no zombie). */
  recovered: number;
  /** Runs failed because they could not make progress — parked waiters released. */
  failed: number;
  /** Runs left to another owner (completion-pending sweeper) or not actually stalled. */
  skipped: number;
  /** Runs that threw during reconciliation. */
  errors: number;
}

export async function reconcileOrphanedRunsForTenant(
  deps: HarnessDeps,
  tenantId: TenantId,
  opts: { limit?: number; now?: Date; staleThresholdMs?: number } = {},
): Promise<ReconcileOrphanedRunsResult> {
  const tenantIdStr = tenantId as string;
  const limit = opts.limit ?? RECONCILE_DEFAULT_BATCH;
  // Match the supervision grace stamped at run creation: a run with no
  // tracked work that has been alive past the grace is orphaned. Healthy
  // runs claim their first task (and a completion-pending row) within
  // seconds, so they are filtered by the pending-row guard below long
  // before this threshold matters.
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALLED_AFTER_MS;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:reconcileOrphanedRuns',
    tenantId: tenantIdStr,
  });
  const result: ReconcileOrphanedRunsResult = {
    scanned: 0,
    recovered: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
  };

  const candidates = await findStalledRunsAcrossSpaces(deps.db, tenantIdStr, { limit });
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  const livenessOpts = {
    staleThresholdMs,
    ...(opts.now ? { now: opts.now } : {}),
  };

  for (const runId of candidates) {
    try {
      const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
      // Status moved on between selection and load (terminated, or paused —
      // a paused run is intentionally waiting and is never an orphan here).
      if (run?.status !== 'running') {
        result.skipped += 1;
        continue;
      }

      const liveness = deriveRunLiveness(run, livenessOpts);
      if (liveness.liveness !== 'stalled') {
        // Selected because the deadline expired, but the run has live or
        // waiting work — its scheduling pass simply failed to re-stamp.
        // Re-arm the clock so we stop re-selecting it. (For an 'idle' run
        // still aging toward the threshold, leave the deadline expired so
        // it ages and is re-examined next tick.)
        if (liveness.liveness === 'executing' || liveness.liveness === 'waiting_for_input') {
          await stampSchedulerDeadline(deps.db, tenantIdStr, runId);
        }
        result.skipped += 1;
        continue;
      }

      // Additive guard: a completion-pending row means the completion-pending
      // sweeper owns this run's recovery/escalation. Re-arm our clock so we
      // stop re-selecting it and let that sweeper work it on its own due_at.
      const pending = await listCompletionPendingForRun(deps.db, tenantIdStr, runId);
      if (pending.length > 0) {
        await stampSchedulerDeadline(deps.db, tenantIdStr, runId);
        result.skipped += 1;
        continue;
      }

      // True orphan: running, stalled, no claimed work. Recover-then-fail.
      // Release any stranded scheduled claim rows, then let
      // dispatchNextOrTerminate do the right thing — dispatch the ready
      // wave, terminate as completed/failed if all required tasks are
      // already terminal, or hold if work is genuinely in flight.
      await runRecoveryPass(deps.db, tenantIdStr, runId);
      try {
        await dispatchNextOrTerminate(deps, tenantId, runId);
      } catch (dispatchErr) {
        log.warn(
          `[reconcileOrphanedRuns] dispatch recovery threw for run=${runId}: ` +
            `${dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)} — ` +
            `failing run to release waiters`,
        );
        const failedNow = await completeRun(deps, tenantId, runId, 'failed', {
          reason: 'workflow_run_orphaned',
          detail: liveness.reason,
        });
        if (failedNow) result.failed += 1;
        else result.skipped += 1;
        continue;
      }

      const after = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
      if (!after || isTerminalRunStatus(after.status)) {
        // Dispatch terminated the run (all required tasks already terminal).
        result.recovered += 1;
        continue;
      }

      // Re-derive liveness after dispatch. It may have put work in flight, or
      // PAUSED the run — a human first task claims a paused row with no
      // completion-pending row (dispatchHumanWorkflowTask), and a paused run is
      // legitimately waiting, not wedged. Only fail a run that is STILL a true
      // stall; never fail a paused or live run (completeRun's CAS would
      // otherwise flip paused → failed).
      const pendingAfter = await listCompletionPendingForRun(deps.db, tenantIdStr, runId);
      if (
        pendingAfter.length > 0 ||
        deriveRunLiveness(after, livenessOpts).liveness !== 'stalled'
      ) {
        await stampSchedulerDeadline(deps.db, tenantIdStr, runId);
        result.recovered += 1;
        continue;
      }

      // Dispatch produced no tracked work and did not terminate — the graph
      // is wedged (no ready successors, required tasks not all terminal).
      // Fail so the parked waiters are released rather than spinning forever.
      const failedNow = await completeRun(deps, tenantId, runId, 'failed', {
        reason: 'workflow_run_orphaned',
        detail: liveness.reason,
      });
      if (failedNow) result.failed += 1;
      else result.skipped += 1;
    } catch (err) {
      logOrchestratorError(`[reconcileOrphanedRuns] entry failed: run=${runId}`, err, {
        tenantId: tenantIdStr,
        runId,
      });
      result.errors += 1;
    }
  }

  if (result.scanned > 0) {
    log.debug(
      `[reconcileOrphanedRuns] tenant=${tenantIdStr} scanned=${String(result.scanned)} ` +
        `recovered=${String(result.recovered)} failed=${String(result.failed)} ` +
        `skipped=${String(result.skipped)} errors=${String(result.errors)}`,
    );
  }
  return result;
}
