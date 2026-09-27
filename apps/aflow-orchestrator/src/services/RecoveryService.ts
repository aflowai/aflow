import type { Redis } from 'ioredis';
import {
  SessionHotStateSchema,
  StepHotStateSchema,
  type SessionHotState,
  type StepHotState,
  setSessionState,
  setStepState,
  readRecoveryEvents,
  getSessionStateSafe,
} from '@aflow/redis';
import type { AflowError, RecoveryEventEnvelope, RunSnapshot, SystemRole } from '@aflow/schemas';
import { errorContext } from '@aflow/schemas';
import type { RecoverableRunsRepository } from '@aflow/database';
import type { SnapshotService } from './SnapshotService.js';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';

// ============================================================================
// Recovery Event Replay (Pure Function)
// ============================================================================

/**
 * Apply a single recovery event to run/step state.
 * Pure function — no side effects, fully testable.
 */
export function applyRecoveryEvent(
  runState: SessionHotState,
  stepStates: Map<string, StepHotState>,
  event: RecoveryEventEnvelope,
): { runState: SessionHotState; stepStates: Map<string, StepHotState> } {
  const data = event.data;

  switch (event.type) {
    case 'run.created': {
      // Full state replacement — this is the initial state
      const runHotState = data['runHotState'] as Record<string, unknown> | undefined;
      const stepHotState = data['stepHotState'] as Record<string, unknown> | undefined;

      if (runHotState) {
        const parsed = SessionHotStateSchema.safeParse(runHotState);
        if (parsed.success) {
          runState = parsed.data;
        }
      }
      if (stepHotState) {
        const parsed = StepHotStateSchema.safeParse(stepHotState);
        if (parsed.success) {
          stepStates.set(parsed.data.stepExecutionId, parsed.data);
        }
      }
      break;
    }

    case 'run.status_changed':
    case 'run.completed': {
      const toStatus = data['toStatus'] as string | undefined;
      const runStatePatch = data['runStatePatch'] as Record<string, unknown> | undefined;
      const clearedFields = data['clearedRunStateFields'] as readonly string[] | undefined;

      const next: Record<string, unknown> = { ...runState };
      if (toStatus) next['status'] = toStatus;
      if (runStatePatch) {
        for (const [k, v] of Object.entries(runStatePatch)) {
          next[k] = v;
        }
      }
      if (clearedFields) {
        for (const f of clearedFields) {
          delete next[f];
        }
      }
      runState = next as SessionHotState;
      break;
    }

    case 'step.scheduled': {
      const stepHotState = data['stepHotState'] as Record<string, unknown> | undefined;
      if (stepHotState) {
        const parsed = StepHotStateSchema.safeParse(stepHotState);
        if (parsed.success) {
          stepStates.set(parsed.data.stepExecutionId, parsed.data);
          runState = {
            ...runState,
            currentStepId: parsed.data.stepId,
            currentStepExecutionId: parsed.data.stepExecutionId,
          };
        }
      }
      break;
    }

    case 'step.claimed': {
      if (event.stepExecutionId) {
        const existing = stepStates.get(event.stepExecutionId);
        if (existing) {
          stepStates.set(event.stepExecutionId, {
            ...existing,
            status: 'STARTED',
            startedAt: event.timestamp,
          });
        }
      }
      break;
    }

    case 'step.succeeded': {
      if (event.stepExecutionId) {
        const existing = stepStates.get(event.stepExecutionId);
        if (existing) {
          stepStates.set(event.stepExecutionId, {
            ...existing,
            status: 'SUCCEEDED',
            endedAt: event.timestamp,
            outputRef: (data['outputRef'] as string) ?? existing.outputRef,
          });
        }
      }
      break;
    }

    case 'step.failed': {
      if (event.stepExecutionId) {
        const existing = stepStates.get(event.stepExecutionId);
        if (existing) {
          stepStates.set(event.stepExecutionId, {
            ...existing,
            status: 'FAILED',
            endedAt: event.timestamp,
            errorRef: (data['errorRef'] as string) ?? existing.errorRef,
          });
        }
      }
      break;
    }

    case 'step.paused': {
      if (event.stepExecutionId) {
        const existing = stepStates.get(event.stepExecutionId);
        if (existing) {
          stepStates.set(event.stepExecutionId, {
            ...existing,
            status: 'PAUSED',
            endedAt: event.timestamp,
          });
        }
      }
      const pauseReason = data['pauseReason'] as string | undefined;
      const requestedInputRef = data['requestedInputRef'] as string | undefined;
      runState = {
        ...runState,
        status: 'PAUSED',
        ...(pauseReason !== undefined ? { pauseReason } : {}),
        ...(requestedInputRef !== undefined ? { requestedInputRef } : {}),
      };
      break;
    }

    case 'step.cancelled': {
      if (event.stepExecutionId) {
        const existing = stepStates.get(event.stepExecutionId);
        if (existing) {
          stepStates.set(event.stepExecutionId, {
            ...existing,
            status: 'FAILED',
            endedAt: event.timestamp,
          });
        }
      }
      break;
    }

    case 'state.variable_patch': {
      const variables = data['variables'] as Record<string, unknown> | undefined;
      const version = data['version'] as number | undefined;
      if (variables && version !== undefined) {
        const currentState = runState.runtimeState ?? {
          schemaVersion: 1 as const,
          variables: {},
          version: 0,
          updatedAtMs: event.timestamp,
        };
        runState = {
          ...runState,
          runtimeState: {
            ...currentState,
            variables: { ...currentState.variables, ...variables },
            version,
            updatedAtMs: event.timestamp,
          },
        };
      }
      break;
    }

    case 'state.agent_decision': {
      // Agent decisions affect step scheduling, which is captured by step.scheduled events.
      // The decision data is primarily for debugging/traceability.
      break;
    }

    case 'state.timer_set':
    case 'state.timer_fired': {
      // Timer events are for traceability — the actual timer state is in the Redis ZSET.
      // On recovery, timers would need to be re-evaluated, not replayed.
      break;
    }
  }

  return { runState, stepStates };
}

// ============================================================================
// Full Recovery Algorithm
// ============================================================================

/**
 * Recover a run from snapshot + tail replay.
 * Writes recovered state back to Redis.
 *
 * @returns The recovered SessionHotState, or null if recovery data is insufficient.
 */
export async function recoverRun(
  redis: Redis,
  tenantId: string,
  runId: string,
  snapshot?: RunSnapshot | null,
): Promise<SessionHotState | null> {
  // 0. If the run already has valid hot state in Redis, skip replay.
  //    The hash (written by atomicCompleteStep) is authoritative and contains
  //    the full runtimeState. Replaying recovery events would overwrite it
  //    with an incomplete state (patches only, not full variables).
  //    This covers the common case: orchestrator restart while Redis is up.
  const existing = await getSessionStateSafe(redis, tenantId, runId);
  if (existing.ok) {
    getOrchestratorLogger().debug(
      `Run ${runId} already has valid hot state (status=${existing.state.status}) — skipping replay`,
    );
    return existing.state;
  }

  // 1. Determine replay start point
  const replayFromSeq = snapshot ? snapshot.seq : -1;

  // 2. Read recovery events after snapshot
  const events = await readRecoveryEvents(redis, tenantId, runId, { afterSeq: replayFromSeq });

  // 3. If no snapshot and no events, nothing to recover
  if (!snapshot && events.length === 0) {
    return null;
  }

  // 4. Initialize state from snapshot or empty
  let runState: SessionHotState;
  let stepStates: Map<string, StepHotState>;

  if (snapshot) {
    // Validate snapshot checksum
    const snapshotRunState = SessionHotStateSchema.safeParse(snapshot.sessionHotState);
    if (!snapshotRunState.success) {
      const ae: AflowError = {
        code: 'RECOVERY_SNAPSHOT_RUN_STATE_INVALID',
        message: 'Snapshot SessionHotState failed schema validation',
        classification: 'internal',
        retryable: false,
        timestamp: new Date().toISOString(),
      };
      getOrchestratorLogger()
        .child({ component: 'recovery-replay' })
        .error(
          `Snapshot has invalid SessionHotState for run ${runId}`,
          undefined,
          errorContext(ae, { tenantId, runId }),
        );
      return null;
    }
    runState = snapshotRunState.data;
    stepStates = new Map();

    for (const [stepExecId, stepData] of Object.entries(snapshot.stepHotStates)) {
      const parsed = StepHotStateSchema.safeParse(stepData);
      if (parsed.success) {
        stepStates.set(stepExecId, parsed.data);
      }
    }
  } else {
    // No snapshot — replay from genesis. run.created event must be first.
    const firstEvent = events[0];
    if (firstEvent?.type !== 'run.created') {
      const ae: AflowError = {
        code: 'RECOVERY_REPLAY_MISSING_RUN_CREATED',
        message: 'No snapshot and first recovery event is not run.created',
        classification: 'internal',
        retryable: false,
        timestamp: new Date().toISOString(),
      };
      getOrchestratorLogger()
        .child({ component: 'recovery-replay' })
        .error(
          `No snapshot and first event is not run.created for run ${runId}`,
          undefined,
          errorContext(ae, { tenantId, runId }),
        );
      return null;
    }
    // Initialize with empty-shaped state — `run.created` (the first event)
    //    populates the real target/agentVersion. Use a synthetic
    //    platform-role 'pending-replay' placeholder until then; it's
    //    overwritten before validation at step 6.
    runState = {
      sessionId: runId,
      tenantId,
      target: { kind: 'platform-role', systemRole: 'pending-replay' as SystemRole },
      agentVersion: '',
      status: 'QUEUED',
      createdAt: firstEvent.timestamp,
      lastUpdatedAt: firstEvent.timestamp,
    };
    stepStates = new Map();
  }

  // 5. Replay events
  for (const event of events) {
    ({ runState, stepStates } = applyRecoveryEvent(runState, stepStates, event));
  }

  // 6. Validate recovered state
  const validateResult = SessionHotStateSchema.safeParse(runState);
  if (!validateResult.success) {
    const ae: AflowError = {
      code: 'RECOVERY_REPLAY_OUTPUT_INVALID',
      message: validateResult.error.message,
      classification: 'internal',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
    getOrchestratorLogger()
      .child({ component: 'recovery-replay' })
      .error(
        `Recovery produced invalid state for run ${runId}`,
        undefined,
        errorContext(ae, { tenantId, runId }),
      );
    return null;
  }

  // 7. Write recovered state back to Redis
  await setSessionState(redis, runState);

  // Determine which step the run currently references (needed for resume)
  const currentStepExecId = runState.currentStepExecutionId;

  let restoredStepCount = 0;
  for (const [stepExecId, stepState] of stepStates) {
    // Restore steps that are: (a) actively in-flight, or (b) referenced by a
    // paused/resumable run. Without (b), resumeRun() fails because it calls
    // getStepState() for currentStepExecutionId.
    const isActive = stepState.status === 'SCHEDULED' || stepState.status === 'STARTED';
    const isCurrentStep = stepExecId === currentStepExecId;
    if (isActive || isCurrentStep) {
      await setStepState(redis, stepState);
      restoredStepCount++;
    }
  }

  getOrchestratorLogger().debug(
    `Recovered run ${runId}: status=${runState.status}, ` +
      `events_replayed=${String(events.length)}, restored_steps=${String(restoredStepCount)}`,
  );

  return runState;
}

// ============================================================================
// Shard Recovery (Package 3 — Recovery Integration)
// ============================================================================

export interface RecoverShardRunsDeps {
  redis: Redis;
  manifestRepo: RecoverableRunsRepository;
  snapshotService: SnapshotService;
}

export interface RecoverShardRunsResult {
  /** Number of runs successfully recovered */
  recovered: number;
  /** Number of runs that failed recovery (quarantined) */
  quarantined: number;
  /** Total elapsed time in ms */
  elapsedMs: number;
}

/**
 * Recover all non-terminal runs for a set of shards.
 * Called on orchestrator startup or shard acquisition.
 *
 * Algorithm:
 * 1. Query Postgres manifest (`getByShards`) for owned shards
 * 2. For each run: load latest snapshot via SnapshotService
 * 3. Call `recoverRun()` with snapshot + tail replay
 * 4. Track recovered/quarantined counts for observability
 *
 * Quarantine: runs whose recovery fails (invalid snapshot, replay errors)
 * are logged but left unrecovered. They remain in the manifest for
 * manual inspection or future retry. No data is deleted.
 */
export async function recoverShardRuns(
  deps: RecoverShardRunsDeps,
  shardIds: number[],
): Promise<RecoverShardRunsResult> {
  const { redis, manifestRepo, snapshotService } = deps;
  const log = getOrchestratorLogger().child({ component: 'recovery-service' });
  const start = Date.now();

  if (shardIds.length === 0) {
    return { recovered: 0, quarantined: 0, elapsedMs: 0 };
  }

  // 1. Discover runs from Postgres manifest
  const recoverableRows = await manifestRepo.getByShards(shardIds);

  if (recoverableRows.length === 0) {
    return { recovered: 0, quarantined: 0, elapsedMs: Date.now() - start };
  }

  log.info(
    `Recovering ${String(recoverableRows.length)} runs across ${String(shardIds.length)} shards`,
  );

  let recovered = 0;
  let quarantined = 0;
  /** Runs where recoverRun returned null (no Redis tail / invalid replay path) */
  let quarantinedNoData = 0;
  const noDataBreakdown = new Map<string, number>();
  const noDataSampleRunIds: string[] = [];
  let quarantinedError = 0;
  const errorSamples: Array<{ runId: string; message: string }> = [];

  // 2. Recover each run sequentially (avoid thundering herd on Redis)
  for (const row of recoverableRows) {
    try {
      // 3. Load snapshot (returns null if none exists or Redis lost it)
      const snapshot = await snapshotService.loadSnapshot(row.tenantId, row.runId);

      // 4. Run recovery: snapshot + tail replay → write state to Redis
      const result = await recoverRun(redis, row.tenantId, row.runId, snapshot);

      if (result) {
        recovered++;
        // If the recovered run is actually resting (e.g., manifest said RUNNING but
        // replay shows it transitioned to PAUSED/WAITING_ON_CHILD), remove it from
        // the manifest. Resting runs are rehydrated on-demand, not eagerly recovered.
        if (result.status === 'PAUSED' || result.status === 'WAITING_ON_CHILD') {
          await manifestRepo.remove(row.runId);
        }
      } else {
        quarantined++;
        quarantinedNoData++;
        const key = `snapshot=${snapshot ? 'yes' : 'no'},manifest_status=${row.status}`;
        noDataBreakdown.set(key, (noDataBreakdown.get(key) ?? 0) + 1);
        if (noDataSampleRunIds.length < 5) {
          noDataSampleRunIds.push(row.runId);
        }
      }
    } catch (err) {
      quarantined++;
      quarantinedError++;
      const message = err instanceof Error ? err.message : String(err);
      if (errorSamples.length < 5) {
        errorSamples.push({ runId: row.runId, message });
      }
    }
  }

  const elapsedMs = Date.now() - start;
  log.info(
    `Shard recovery complete: recovered=${String(recovered)}, quarantined=${String(quarantined)}, elapsed=${String(elapsedMs)}ms`,
  );

  if (quarantinedNoData > 0) {
    log.warn(
      'Quarantined runs (no recoverable Redis snapshot + replay tail — manifest row may outlive Redis TTL or predate recovery pipeline)',
      {
        count: quarantinedNoData,
        breakdown: Object.fromEntries(noDataBreakdown),
        sampleRunIds: noDataSampleRunIds,
      },
    );
  }

  if (quarantinedError > 0) {
    const ae: AflowError = {
      code: 'RECOVERY_SHARD_ITERATION_FAILED',
      message: 'Recovery threw while replaying one or more runs',
      classification: 'internal',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
    log.error(`Quarantined ${String(quarantinedError)} run(s): recovery threw`, undefined, {
      ...errorContext(ae, {}),
      samples: errorSamples,
      quarantinedErrorCount: quarantinedError,
    });
  }

  return { recovered, quarantined, elapsedMs };
}
