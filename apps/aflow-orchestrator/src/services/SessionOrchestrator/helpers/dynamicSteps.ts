import type { Redis } from 'ioredis';
import type { SessionId, StepDefinition, TenantId } from '@aflow/schemas';
import { getSessionState, updateSessionState } from '@aflow/redis';

/**
 * Persist a synthesized virtual-tool step to dynamicSteps in Redis so it
 * survives across orchestrator iterations. Without this, when the executor
 * completes and the orchestrator re-reads the flow from DB, the synthetic
 * step is lost and routing fails (session ends prematurely instead of
 * routing back to the agent). Best-effort by design: a failed persist may
 * cost the route-back, never the write that produced it.
 */
export async function persistDynamicStep(
  redis: Redis,
  tenantId: TenantId,
  sessionId: SessionId,
  step: StepDefinition,
): Promise<void> {
  try {
    const existingState = await getSessionState(redis, tenantId, sessionId);
    const existingDynamic: StepDefinition[] = existingState?.dynamicSteps
      ? (JSON.parse(existingState.dynamicSteps) as StepDefinition[])
      : [];
    existingDynamic.push(step);
    await updateSessionState(redis, tenantId, sessionId, {
      dynamicSteps: JSON.stringify(existingDynamic),
    });
  } catch {
    /* best-effort */
  }
}
