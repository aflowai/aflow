/**
 * Fail a run — update Redis state, append FlowRunFailed event, mark dirty.
 */
import type { Redis } from 'ioredis';
import type { AflowError } from '@aflow/schemas';
import { toFailedRunDisplay, toFailedRunDisplayFromUnknown } from '@aflow/schemas';
import type { SessionEvent } from '@aflow/redis';
import { buildRunStatusChangedRecoveryEvent } from '../helpers/recoveryEmitter.js';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { getClearedDelegationStatePatch } from '../helpers/delegationState.js';

const DELEGATION_FIELDS_CLEARED_BY_FAIL = [
  'delegationPauseSource',
  'delegationWaitMode',
  'pauseType',
  'pausedChildSessionId',
  'childPausedStepExecutionId',
  'pauseReason',
  'requestedInputRef',
  'waitingForChildSessionIds',
] as const;
import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
} from './enqueueDelegationCompletion.js';

export async function failRun(
  redis: Redis,
  tenantId: string,
  runId: string,
  errorCode: string,
  errorMessage: string,
  classification?: AflowError['classification'],
): Promise<void> {
  const { updateSessionState, appendSessionEvent, markSessionDirty, markRunInactive } =
    await import('@aflow/redis');

  const recoveryEvents = await buildRunStatusChangedRecoveryEvent(
    redis,
    tenantId,
    runId,
    'RUNNING',
    'FAILED',
    { clearedRunStateFields: DELEGATION_FIELDS_CLEARED_BY_FAIL },
  );

  await updateSessionState(
    redis,
    tenantId,
    runId,
    {
      status: 'FAILED',
      endedAt: Date.now(),
      ...getClearedDelegationStatePatch(),
    },
    recoveryEvents,
  );

  // Released here rather than at each caller. A run that reaches FAILED has
  // released its capacity by definition, and leaving that to six separate call
  // sites is how four of them came to omit it — an over-count that admission
  // control turns into a 429 against real traffic.
  await markRunInactive(redis, tenantId, runId).catch(() => {});

  const aflowError = classification
    ? {
        code: errorCode,
        message: errorMessage,
        classification,
        retryable: false,
        timestamp: new Date().toISOString(),
      }
    : undefined;
  const display = aflowError
    ? toFailedRunDisplay(aflowError, { runId, includeDebug: true })
    : toFailedRunDisplayFromUnknown(new Error(errorMessage), { runId, includeDebug: true });

  logOrchestratorError(`[failRun] Run ${runId} failed [${errorCode}]`, aflowError ?? errorMessage, {
    tenantId,
    runId,
    ...(classification ? { errorClassification: classification } : {}),
  });

  const failEvent: SessionEvent = {
    eventId: crypto.randomUUID(),
    eventType: 'SessionFailed',
    timestamp: Date.now(),
    sessionId: runId,
    metadata: {
      errorCode,
      errorMessage: display.errorMessage,
      ...(classification ? { errorClassification: classification } : {}),
      ...(display.userError ? { userError: display.userError } : {}),
    },
  };
  await appendSessionEvent(redis, tenantId, runId, failEvent);
  await markSessionDirty(redis, tenantId, runId);

  try {
    const { forwardEventToParent } = await import('./forwardChildEvent.js');
    await forwardEventToParent(redis, tenantId, runId, failEvent);
  } catch {
    // Best-effort forwarding
  }

  // If this run is a subflow with a waiting parent, resume the parent.
  try {
    await enqueuePendingAndReconcile({
      redis,
      tenantId,
      childRunId: runId,
      reason: 'failRun',
      childError: {
        code: errorCode,
        message: errorMessage,
        classification: classification ?? 'internal',
      },
    });
  } catch (resumeErr) {
    if (isDelegationUpsertFailure(resumeErr)) throw resumeErr;
    logOrchestratorError(
      `[failRun] Failed to resume parent after child ${runId} failed:`,
      resumeErr,
      {
        tenantId,
        runId,
      },
    );
  }
}
