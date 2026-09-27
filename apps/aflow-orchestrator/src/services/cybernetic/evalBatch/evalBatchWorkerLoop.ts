/**
 * The eval-batch engine's scheduler — candidates come from the cross-tenant due
 * pointer, so the cycle asks for the tenants that already have batch work rather
 * than asking every tenant whether it has any. A claim leases the tenant and the
 * settle recomputes its next due time from the tenant tables, which stay
 * authoritative: the pointer nominates, it never decides.
 *
 * The per-tenant claim is also the engine's exclusion. Trial leases exist to
 * survive worker death, not to arbitrate live contention, and `SKIP LOCKED` plus
 * the claim lease is what keeps two instances off one tenant's batches.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  claimDueEvalBatchTenants,
  releaseEvalBatchTenantClaim,
  settleEvalBatchTenantDue,
} from '@aflow/database';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane, type BackgroundTaskMode, type TenantId } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { HarnessDeps } from '../harness/types.js';
import { EvalBatchEngine } from './EvalBatchEngine.js';

const TASK_ID = 'orchestrator.eval_batch_engine';

export interface EvalBatchWorkerDeps {
  sqlClient: postgres.Sql;
  harnessDeps: HarnessDeps;
}

export interface EvalBatchWorkerConfig {
  intervalMs?: number;
  maxBatch?: number;
  maxCycleMs?: number;
  /** Trial-lease owner passed through to the engine. */
  instanceId?: string;
  fixtureSpaceTtlMs?: number;
  /** Override the registry's mode, for tests. Production resolves it. */
  mode?: BackgroundTaskMode;
}

export function createEvalBatchWorker(
  deps: EvalBatchWorkerDeps,
  config: EvalBatchWorkerConfig = {},
): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(TASK_ID);
  const intervalMs = config.intervalMs ?? runtime.intervalMs ?? 10_000;
  const maxBatch = config.maxBatch ?? runtime.maxBatch;
  const maxCycleMs = config.maxCycleMs ?? runtime.maxCycleMs;
  const mode = config.mode ?? runtime.mode;
  const log = getOrchestratorLogger().child({ component: 'eval-batch-worker' });

  const engine = new EvalBatchEngine({
    sqlClient: deps.sqlClient,
    harnessDeps: deps.harnessDeps,
    ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
    ...(config.fixtureSpaceTtlMs !== undefined
      ? { fixtureSpaceTtlMs: config.fixtureSpaceTtlMs }
      : {}),
  });

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
      // The lease outlives at most one cycle, so a claimant killed mid-batch
      // hands its tenants back within the budget it was allowed to hold them.
      const claimToken = randomUUID();
      const claimed = await claimDueEvalBatchTenants(deps.sqlClient, {
        limit: ctx.maxBatch,
        leaseMs: maxCycleMs,
        claimToken,
      });
      if (claimed.length === 0) return { candidates: 0 };
      if (ctx.mode === 'observe') {
        // Holding a lease is itself a side effect: it keeps the tenant away
        // from whatever else is advancing its batches while this one only
        // watches.
        for (const claim of claimed) {
          await releaseEvalBatchTenantClaim(deps.sqlClient, claim.tenantId, claimToken);
        }
        return { candidates: claimed.length };
      }

      let processed = 0;
      let failed = 0;
      for (const claim of claimed) {
        if (ctx.budgetExhausted()) {
          await releaseEvalBatchTenantClaim(deps.sqlClient, claim.tenantId, claimToken);
          continue;
        }
        let clean = true;
        try {
          const pass = await engine.processTenant(claim.tenantId as TenantId, {
            signal: ctx.signal,
          });
          if (pass.errors > 0) clean = false;
        } catch (err) {
          // One tenant's failure must not cost the rest of the batch their
          // cycle. The pointer keeps its due time either way, so the work
          // comes back.
          logOrchestratorError('[eval-batch-worker] tenant pass failed', err, {
            tenantId: claim.tenantId,
          });
          clean = false;
        }
        if (clean) processed++;
        else failed++;
        try {
          await settleEvalBatchTenantDue(deps.sqlClient, claim, claimToken);
        } catch (err) {
          logOrchestratorError('[eval-batch-worker] settle failed', err, {
            tenantId: claim.tenantId,
          });
        }
      }

      if (backgroundWorkVerboseLogsEnabled()) {
        log.info('[background-work] eval-batch-worker cycle', {
          trigger: 'candidate',
          claimed: claimed.length,
          processed,
          failed,
        });
      }

      // No `hasMore`: a tenant whose batch is still running stays due by
      // design, because observing its trials IS the work. Reporting more work
      // would re-arm the cycle at zero delay and turn the cadence — which is
      // this engine's observation interval — into a spin.
      return { candidates: claimed.length, processed, failed };
    },
  );
}
