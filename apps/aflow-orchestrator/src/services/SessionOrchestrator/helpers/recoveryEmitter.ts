import type { Redis } from 'ioredis';
import type { RecoveryEventEnvelope, RecoveryEventType } from '@aflow/schemas';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import { allocateRecoverySeqBatch, buildRecoveryEvent } from '@aflow/redis';

/**
 * Whether recovery events are enabled.
 * Controlled via env var for safe rollout — can be toggled per-instance.
 */
export function isRecoveryEnabled(): boolean {
  return process.env['RECOVERY_EVENTS_ENABLED'] !== 'false';
}

/**
 * Build recovery events for a run creation.
 * Emits: run.created + step.scheduled
 */
export async function buildRunCreatedRecoveryEvents(
  redis: Redis,
  run: SessionHotState,
  step: StepHotState,
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, run.tenantId, run.sessionId, 2);
  const seq0 = seqs[0];
  const seq1 = seqs[1];
  if (seq0 === undefined || seq1 === undefined) return [];

  return [
    buildRecoveryEvent(seq0, run.tenantId, run.sessionId, 'run.created', {
      runHotState: run,
      stepHotState: step,
    }),
    buildRecoveryEvent(
      seq1,
      run.tenantId,
      run.sessionId,
      'step.scheduled',
      {
        stepHotState: step,
      },
      step.stepExecutionId,
    ),
  ];
}

export async function buildStepCompletedRecoveryEvents(
  redis: Redis,
  tenantId: string,
  runId: string,
  stepExecutionId: string,
  status: 'SUCCEEDED' | 'FAILED' | 'PAUSED',
  data: Record<string, unknown>,
  runStatusChanged?: {
    from: string;
    to: string;
    runStatePatch?: Record<string, unknown>;
    clearedRunStateFields?: readonly string[];
  },
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const eventCount = runStatusChanged ? 2 : 1;
  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, eventCount);

  const typeMap: Record<string, RecoveryEventType> = {
    SUCCEEDED: 'step.succeeded',
    FAILED: 'step.failed',
    PAUSED: 'step.paused',
  };

  const events: RecoveryEventEnvelope[] = [];

  const seq0 = seqs[0];
  if (seq0 === undefined) return [];
  events.push(
    buildRecoveryEvent(
      seq0,
      tenantId,
      runId,
      typeMap[status] ?? 'step.succeeded',
      data,
      stepExecutionId,
    ),
  );

  if (runStatusChanged) {
    const seq1 = seqs[1];
    if (seq1 === undefined) return events;
    const isTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(runStatusChanged.to);
    const statusData: Record<string, unknown> = {
      fromStatus: runStatusChanged.from,
      toStatus: runStatusChanged.to,
    };
    if (runStatusChanged.runStatePatch && Object.keys(runStatusChanged.runStatePatch).length > 0) {
      statusData['runStatePatch'] = runStatusChanged.runStatePatch;
    }
    if (
      runStatusChanged.clearedRunStateFields &&
      runStatusChanged.clearedRunStateFields.length > 0
    ) {
      statusData['clearedRunStateFields'] = [...runStatusChanged.clearedRunStateFields];
    }
    events.push(
      buildRecoveryEvent(
        seq1,
        tenantId,
        runId,
        isTerminal ? 'run.completed' : 'run.status_changed',
        statusData,
      ),
    );
  }

  return events;
}

/**
 * Build recovery event for a step being scheduled.
 */
export async function buildStepScheduledRecoveryEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  step: StepHotState,
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, 1);
  const seq = seqs[0];
  if (seq === undefined) return [];

  return [
    buildRecoveryEvent(
      seq,
      tenantId,
      runId,
      'step.scheduled',
      { stepHotState: step },
      step.stepExecutionId,
    ),
  ];
}

/**
 * Build recovery event for a runtime variable patch.
 */
export async function buildVariablePatchRecoveryEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  variables: Record<string, unknown>,
  version: number,
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, 1);
  const seq = seqs[0];
  if (seq === undefined) return [];

  return [buildRecoveryEvent(seq, tenantId, runId, 'state.variable_patch', { variables, version })];
}

export async function buildRunStatusChangedRecoveryEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  fromStatus: string,
  toStatus: string,
  opts?: {
    runStatePatch?: Record<string, unknown>;
    clearedRunStateFields?: readonly string[];
  },
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, 1);
  const seq = seqs[0];
  if (seq === undefined) return [];

  const isTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(toStatus);
  const data: Record<string, unknown> = { fromStatus, toStatus };
  if (opts?.runStatePatch && Object.keys(opts.runStatePatch).length > 0) {
    data['runStatePatch'] = opts.runStatePatch;
  }
  if (opts?.clearedRunStateFields && opts.clearedRunStateFields.length > 0) {
    data['clearedRunStateFields'] = [...opts.clearedRunStateFields];
  }

  return [
    buildRecoveryEvent(
      seq,
      tenantId,
      runId,
      isTerminal ? 'run.completed' : 'run.status_changed',
      data,
    ),
  ];
}

export async function buildRunPausedAfterStepSucceededRecoveryEvents(
  redis: Redis,
  tenantId: string,
  runId: string,
  stepExecutionId: string,
  stepData: { outputRef?: string },
  runStatePatch: Record<string, unknown>,
  clearedRunStateFields?: readonly string[],
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, 2);
  const seq0 = seqs[0];
  const seq1 = seqs[1];
  if (seq0 === undefined || seq1 === undefined) return [];

  const stepDataObj: Record<string, unknown> = {};
  if (stepData.outputRef !== undefined) stepDataObj['outputRef'] = stepData.outputRef;

  const statusData: Record<string, unknown> = {
    fromStatus: 'RUNNING',
    toStatus: 'PAUSED',
  };
  if (Object.keys(runStatePatch).length > 0) {
    statusData['runStatePatch'] = { ...runStatePatch };
    if (statusData['runStatePatch'] && typeof statusData['runStatePatch'] === 'object') {
      (statusData['runStatePatch'] as Record<string, unknown>)['status'] = 'PAUSED';
    }
  } else {
    statusData['runStatePatch'] = { status: 'PAUSED' };
  }
  if (clearedRunStateFields && clearedRunStateFields.length > 0) {
    statusData['clearedRunStateFields'] = [...clearedRunStateFields];
  }

  return [
    buildRecoveryEvent(seq0, tenantId, runId, 'step.succeeded', stepDataObj, stepExecutionId),
    buildRecoveryEvent(seq1, tenantId, runId, 'run.status_changed', statusData),
  ];
}

/**
 * Build recovery event for an agent decision.
 */
export async function buildAgentDecisionRecoveryEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  stepExecutionId: string,
  decision: Record<string, unknown>,
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, 1);
  const seq = seqs[0];
  if (seq === undefined) return [];

  return [
    buildRecoveryEvent(seq, tenantId, runId, 'state.agent_decision', { decision }, stepExecutionId),
  ];
}

/**
 * Build recovery event for a timer being set.
 */
export async function buildTimerSetRecoveryEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  timerData: Record<string, unknown>,
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, 1);
  const seq = seqs[0];
  if (seq === undefined) return [];

  return [buildRecoveryEvent(seq, tenantId, runId, 'state.timer_set', timerData)];
}

/**
 * Build recovery event for a timer firing.
 */
export async function buildTimerFiredRecoveryEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  timerData: Record<string, unknown>,
): Promise<RecoveryEventEnvelope[]> {
  if (!isRecoveryEnabled()) return [];

  const seqs = await allocateRecoverySeqBatch(redis, tenantId, runId, 1);
  const seq = seqs[0];
  if (seq === undefined) return [];

  return [buildRecoveryEvent(seq, tenantId, runId, 'state.timer_fired', timerData)];
}
