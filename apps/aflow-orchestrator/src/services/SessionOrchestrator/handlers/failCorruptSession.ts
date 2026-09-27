import type { Redis } from 'ioredis';
import {
  clearQuarantineMark,
  isSessionCorrupt,
  salvageCorruptStateFields,
  setSessionState,
  type SessionHotState,
  type SalvagedCorruptFields,
} from '@aflow/redis';
import type { TenantId, SessionAgentTarget, SystemRole, AgentId } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { failRun } from './failRun.js';

const PLACEHOLDER_TARGET: SessionAgentTarget = {
  kind: 'platform-role',
  systemRole: 'unknown' as SystemRole,
};

/**
 * Coerce a salvaged target (raw strings from quarantine hash) into a
 * branded {@link SessionAgentTarget}. The branded casts are unchecked
 * because by the time we're salvaging a corrupt session the run is
 * already failing — over-validating here would just lose what little
 * context we have.
 */
function brandSalvagedTarget(t: NonNullable<SalvagedCorruptFields['target']>): SessionAgentTarget {
  switch (t.kind) {
    case 'platform-role':
      return { kind: 'platform-role', systemRole: t.systemRole as SystemRole };
    case 'custom-agent':
      return { kind: 'custom-agent', agentId: t.agentId as AgentId };
    case 'inline-agent':
      return { kind: 'inline-agent', definitionRef: t.definitionRef };
  }
}
const PLACEHOLDER_AGENT_VERSION = '1';

export async function failCorruptSessionAndCascade(
  redis: Redis,
  tenantId: string,
  runId: string,
  parseErrorSummary?: string,
): Promise<void> {
  const logger = getOrchestratorLogger();

  // Idempotency check: if not corrupt, nothing to do. Either already failed
  // by a racing caller, or never corrupt to begin with.
  if (!(await isSessionCorrupt(redis, tenantId, runId))) {
    logger.debug(
      `[failCorruptSession] session ${runId} not marked corrupt — skipping (already handled or never corrupt)`,
    );
    return;
  }

  const salvaged = await salvageCorruptStateFields(redis, tenantId, runId);
  if (!salvaged) {
    // Quarantine data was missing — can't cascade properly. Best we can
    // do is clear the marker so the session stops being a sink, log the
    // anomaly, and bail. Without parent fields we cannot resume the parent.
    logger.error(
      `[failCorruptSession] session ${runId} marked corrupt but no quarantined data available; ` +
        'parent (if any) cannot be cascaded. Clearing marker as a last resort.',
    );
    await clearQuarantineMark(redis, tenantId, runId);
    return;
  }

  // 1. Restore a minimal valid hot state in RUNNING status. failRun will
  //    transition it to FAILED via the standard flow. The salvaged fields
  //    are exactly what the cascade needs (parent IDs, agent identity, etc.).
  const salvagedTarget = salvaged.target
    ? brandSalvagedTarget(salvaged.target)
    : PLACEHOLDER_TARGET;
  const minimalState: SessionHotState = {
    sessionId: runId,
    tenantId: tenantId as TenantId,
    target: salvagedTarget,
    agentVersion: salvaged.agentVersion ?? PLACEHOLDER_AGENT_VERSION,
    status: 'RUNNING',
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
    ...(salvaged.parentSessionId
      ? { parentSessionId: salvaged.parentSessionId as SessionHotState['parentSessionId'] }
      : {}),
    ...(salvaged.parentStepExecutionId
      ? {
          parentStepExecutionId:
            salvaged.parentStepExecutionId as SessionHotState['parentStepExecutionId'],
        }
      : {}),
    ...(salvaged.spaceId ? { spaceId: salvaged.spaceId as SessionHotState['spaceId'] } : {}),
    ...(salvaged.traceId ? { traceId: salvaged.traceId as SessionHotState['traceId'] } : {}),
    ...(salvaged.createdBy
      ? { createdBy: salvaged.createdBy as SessionHotState['createdBy'] }
      : {}),
  };
  await setSessionState(redis, minimalState);

  // 2. Clear the corrupt marker BEFORE cascading. Subsequent reads see a
  //    valid RUNNING state (about to become FAILED), not a corrupt sink.
  //    Quarantined hash is preserved for inspection (caller passes
  //    `deleteQuarantined: false` by default).
  await clearQuarantineMark(redis, tenantId, runId);

  // 3. Cascade via the standard failRun path. failRun:
  //      - transitions hot state to FAILED + emits SessionFailed event
  //      - forwards SessionFailed to parent
  //      - calls reconcileParentDelegationForChild → resumeParentOnChildComplete
  //        → emits a synthetic FAILED step result on the parent's delegate step
  //      - parent's onFailure routing fires; agent sees the failure cleanly.
  const errorMessage = parseErrorSummary
    ? `Hot state failed schema validation: ${parseErrorSummary}. Run quarantined as corrupt; cascading as FAILED to parent.`
    : 'Hot state failed schema validation. Run quarantined as corrupt; cascading as FAILED to parent.';

  const { agentTargetKey } = await import('@aflow/schemas');
  const salvagedTargetKey = agentTargetKey(salvagedTarget);
  logger.warn(
    `[failCorruptSession] cascading corrupt run ${runId} as FAILED ` +
      `(parent=${salvaged.parentSessionId ?? '<none>'}, parentStep=${salvaged.parentStepExecutionId ?? '<none>'}, target=${salvagedTargetKey})`,
  );

  await failRun(redis, tenantId, runId, 'SESSION_STATE_CORRUPT', errorMessage, 'internal');
}
