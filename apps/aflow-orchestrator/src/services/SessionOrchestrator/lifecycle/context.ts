import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import type { AflowError, StepExecutionId } from '@aflow/schemas';
import type { ManifestService } from '../../ManifestService.js';
import type { SnapshotService } from '../../SnapshotService.js';
import type { ShardManager } from '../../ShardManager.js';
import type { GuardrailGate } from '../../GuardrailGate/index.js';
import type { HarnessDeps } from '../../cybernetic/WorkflowRunHarness.js';
import type { ApplyResultParams, ScheduleStepParams, SessionOrchestrator } from '../types.js';

/** Factory-injected dependencies shared by lifecycle/scheduling modules. */
export interface SessionOrchestratorFactoryDeps {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
  consumerName: string;
  manifestService?: ManifestService;
  snapshotService?: SnapshotService;
  shardManager?: ShardManager;
  guardrailGate?: GuardrailGate;
}

/** Mutable state for the step-stall watchdog (owned by the factory). */
export interface StallWatchdogState {
  lastStepStallScanMs: number;
}

export interface RelayActivityThrottleEntry {
  lastEmitAtMs: number;
  lastOp: string;
  sequence: number;
}

export interface RelayActivityState {
  throttle: Map<string, RelayActivityThrottleEntry>;
}

/** Cross-module bindings wired after inner helpers are created. */
export interface SessionOrchestratorBindings {
  deps: SessionOrchestratorFactoryDeps;
  harnessDeps: HarnessDeps;
  stallWatchdog: StallWatchdogState;
  relayActivity: RelayActivityState;
  scheduleStep: (params: ScheduleStepParams) => Promise<StepExecutionId>;
  applyResult: (params: ApplyResultParams) => Promise<void>;
  forceCompleteInFlightStep: (
    tenantId: string,
    runId: string,
    reason: 'interrupted' | 'cancelled',
  ) => Promise<boolean>;
  failRunWithCleanup: (
    tenantId: string,
    runId: string,
    errorCode: string,
    errorMessage: string,
    classification?: AflowError['classification'],
  ) => Promise<void>;
  cancelRun: (
    params: Parameters<SessionOrchestrator['cancelRun']>[0],
  ) => ReturnType<SessionOrchestrator['cancelRun']>;
}
