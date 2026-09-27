/**
 * SessionOrchestrator - The orchestrator/execution core.
 *
 * ARCHITECTURE: Redis-first for hot execution state.
 * This module is the factory and wiring layer. Business logic lives in
 * lifecycle/* and scheduling/* modules.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import type { AflowError } from '@aflow/schemas';
import { markRunInactive } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { HarnessDeps } from '../cybernetic/WorkflowRunHarness.js';
import { failRun } from './handlers/failRun.js';
import { createForceCompleteInFlightStep } from './lifecycle/forceCompleteInFlightStep.js';
import { createInterruptRun } from './lifecycle/interruptRun.js';
import { createCancelRun } from './lifecycle/cancelRun.js';
import { createRetryRun } from './lifecycle/retryRun.js';
import { createStartRun } from './lifecycle/startRun.js';
import { createResumeRun } from './lifecycle/resumeRun.js';
import type { SessionOrchestratorBindings } from './lifecycle/context.js';
import { createRecoverOrphanedSessions } from './scheduling/recovery.js';
import { createScheduleStep } from './scheduling/scheduleStep.js';
import { createApplyResult } from './scheduling/applyResult.js';
import { createProcessDueTimers } from './scheduling/timers.js';
import type { GuardrailGate } from '../GuardrailGate/index.js';
import type { ManifestService } from '../ManifestService.js';
import type { SnapshotService } from '../SnapshotService.js';
import type { ShardManager } from '../ShardManager.js';

export type {
  SessionStatus,
  StepExecutionStatus,
  FlowExecutionContext,
  ToolResultSummary,
  ScheduleStepParams,
  ApplyResultParams,
  SessionOrchestrator,
} from './types.js';
import type { SessionOrchestrator } from './types.js';

export function createSessionOrchestrator(deps: {
  db: PostgresJsDatabase;
  sqlClient: postgres.Sql;
  redis: Redis;
  payloadStore: PayloadStore;
  consumerName: string;
  guardrailGate?: GuardrailGate;
  manifestService?: ManifestService;
  snapshotService?: SnapshotService;
  shardManager?: ShardManager;
}): SessionOrchestrator {
  const { db, redis, payloadStore, guardrailGate, manifestService, snapshotService, shardManager } =
    deps;

  const harnessDeps: HarnessDeps = { db, redis, payloadStore };

  const factoryDeps: SessionOrchestratorBindings['deps'] = {
    db,
    redis,
    payloadStore,
    consumerName: deps.consumerName,
    ...(manifestService ? { manifestService } : {}),
    ...(snapshotService ? { snapshotService } : {}),
    ...(shardManager ? { shardManager } : {}),
    ...(guardrailGate ? { guardrailGate } : {}),
  };
  const stallWatchdog: SessionOrchestratorBindings['stallWatchdog'] = {
    lastStepStallScanMs: 0,
  };
  const relayActivity: SessionOrchestratorBindings['relayActivity'] = {
    throttle: new Map(),
  };

  const forceCompleteInFlightStep = createForceCompleteInFlightStep(factoryDeps);

  async function failRunWithCleanup(
    tenantId: string,
    runId: string,
    errorCode: string,
    errorMessage: string,
    classification?: AflowError['classification'],
  ): Promise<void> {
    guardrailGate?.cleanupRun(tenantId, runId);
    await failRun(redis, tenantId, runId, errorCode, errorMessage, classification);
    await markRunInactive(redis, tenantId, runId).catch(() => {});
    manifestService?.updateStatus(runId, tenantId, 'FAILED');
  }

  const orchestratorBindings: SessionOrchestratorBindings = {
    deps: factoryDeps,
    harnessDeps,
    stallWatchdog,
    relayActivity,
    scheduleStep: () => {
      throw new Error('scheduleStep not wired');
    },
    applyResult: () => {
      throw new Error('applyResult not wired');
    },
    forceCompleteInFlightStep,
    failRunWithCleanup,
    cancelRun: () => {
      throw new Error('cancelRun not wired');
    },
  };

  const scheduleStep = createScheduleStep(orchestratorBindings);
  const applyResult = createApplyResult(orchestratorBindings);
  orchestratorBindings.scheduleStep = scheduleStep;
  orchestratorBindings.applyResult = applyResult;

  const lifecycleBindings = orchestratorBindings;
  const interruptRun = createInterruptRun(lifecycleBindings);
  const cancelRun = createCancelRun(lifecycleBindings);
  const retryRun = createRetryRun(lifecycleBindings);
  orchestratorBindings.cancelRun = cancelRun;

  const startRun = createStartRun(orchestratorBindings);
  const resumeRun = createResumeRun(orchestratorBindings);
  const processDueTimers = createProcessDueTimers(orchestratorBindings);
  const recoverOrphanedSessions = createRecoverOrphanedSessions(orchestratorBindings);

  return {
    startRun,
    scheduleStep,
    applyResult,
    resumeRun,
    cancelRun,
    interruptRun,
    retryRun,
    processDueTimers,
    recoverOrphanedSessions,
  };
}
