/**
 * Workflow-run reconciler — converges runs whose tasks are done but whose run
 * never finalized, and runs that died before claiming any task at all.
 *
 * Candidates come from the cross-tenant due pointer, so the cycle asks for the
 * tenants that already have work rather than asking every tenant whether it
 * has any. A claim leases the tenant and the settle recomputes its next due
 * time from the tenant tables, which stay authoritative: the pointer nominates,
 * it never decides.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  claimDueWorkflowRunTenants,
  releaseWorkflowRunTenantClaim,
  settleWorkflowRunTenantDue,
} from '@aflow/database';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane, type BackgroundTaskMode, type TenantId } from '@aflow/schemas';
import {
  reconcileStaleRunForTenant,
  reconcileOrphanedRunsForTenant,
  type HarnessDeps,
} from './WorkflowRunHarness.js';
import { backfillMissingEvaluationEnvelopes } from './evaluationEnvelopeBackfill.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../lib/orchestratorLogger.js';
import type { WakeHold } from '../wakeHold.js';

const TASK_ID = 'orchestrator.workflow_run_reconcile';

export interface WorkflowRunSweeperDeps {
  sqlClient: postgres.Sql;
  harnessDeps: HarnessDeps;
  /** An operation task is escalated on its in-flight record, which a sleep lapses. */
  wakeHold: WakeHold;
}

export interface WorkflowRunSweeperConfig {
  intervalMs?: number;
  maxBatch?: number;
  maxCycleMs?: number;
  /** Override the registry's mode, for tests. Production resolves it. */
  mode?: BackgroundTaskMode;
}

export function createWorkflowRunSweeper(
  deps: WorkflowRunSweeperDeps,
  config: WorkflowRunSweeperConfig = {},
): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(TASK_ID);
  const intervalMs = config.intervalMs ?? runtime.intervalMs ?? 10_000;
  const maxBatch = config.maxBatch ?? runtime.maxBatch;
  const maxCycleMs = config.maxCycleMs ?? runtime.maxCycleMs;
  const mode = config.mode ?? runtime.mode;
  const log = getOrchestratorLogger().child({ component: 'workflow-run-sweeper' });

  async function reconcileTenant(tenantId: TenantId): Promise<boolean> {
    let clean = true;
    try {
      const stale = await reconcileStaleRunForTenant(deps.harnessDeps, tenantId);
      if (stale.errors > 0) clean = false;
      const orphaned = await reconcileOrphanedRunsForTenant(deps.harnessDeps, tenantId);
      if (orphaned.errors > 0) clean = false;
      // A worker that died between a run's terminal CAS and its post-run hook
      // leaves the evaluation envelope unwritten, and nothing else revisits a
      // terminal run. The terminal write nominates the tenant for that repair
      // through the same pointer, so it belongs on this claim.
      const envelopes = await backfillMissingEvaluationEnvelopes(deps.harnessDeps, tenantId);
      if (envelopes.errors > 0) clean = false;
    } catch (err) {
      // One tenant's failure must not cost the rest of the batch their cycle.
      // The pointer keeps its due time either way, so the work comes back.
      logOrchestratorError('[workflow-run-sweeper] tenant reconcile failed', err, { tenantId });
      clean = false;
    }
    return clean;
  }

  return createBackgroundTaskRunner(
    {
      taskId: TASK_ID,
      scope: runtime.scope,
      intervalMs,
      maxBatch,
      maxCycleMs,
      mode,
      logger: {
        debug: (message, data) => {
          log.debug(message, data);
        },
        info: (message, data) => {
          log.info(message, data);
        },
        warn: (message, data) => {
          log.warn(message, data);
        },
        error: (message, error, data) => {
          logOrchestratorError(message, error, data);
        },
      },
    },
    async (ctx): Promise<BackgroundTaskCycleResult> => {
      if (deps.wakeHold.remainingMs() > 0) return { candidates: 0 };
      // The lease outlives at most one cycle, so a claimant killed mid-batch
      // hands its tenants back within the budget it was allowed to hold them.
      const claimToken = randomUUID();
      const claimed = await claimDueWorkflowRunTenants(deps.sqlClient, {
        limit: ctx.maxBatch,
        leaseMs: maxCycleMs,
        claimToken,
      });
      if (claimed.length === 0) return { candidates: 0 };
      if (ctx.mode === 'observe') {
        // Holding a lease is itself a side effect: it keeps the tenant away
        // from whatever else is reconciling while this one only watches.
        for (const claim of claimed) {
          await releaseWorkflowRunTenantClaim(deps.sqlClient, claim.tenantId, claimToken);
        }
        return { candidates: claimed.length };
      }

      let processed = 0;
      let failed = 0;
      for (const claim of claimed) {
        if (ctx.budgetExhausted()) {
          await releaseWorkflowRunTenantClaim(deps.sqlClient, claim.tenantId, claimToken);
          continue;
        }
        const clean = await reconcileTenant(claim.tenantId as TenantId);
        if (clean) processed++;
        else failed++;
        try {
          await settleWorkflowRunTenantDue(deps.sqlClient, claim, claimToken);
        } catch (err) {
          logOrchestratorError('[workflow-run-sweeper] settle failed', err, {
            tenantId: claim.tenantId,
          });
        }
      }

      if (backgroundWorkVerboseLogsEnabled()) {
        log.info('[background-work] workflow-run-sweeper cycle', {
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
        hasMore: claimed.length === ctx.maxBatch,
      };
    },
  );
}
