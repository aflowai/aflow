import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SessionHotState } from '@aflow/redis';
import { getRunAccessGrant, serializeRunAccessGrant } from '@aflow/redis';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { attendedAsActingRun } from '../../SessionOrchestrator/handlers/inlineOps/actingRun.js';
import { readDurableSessionCreatedBy } from './helpers.js';

/**
 * Whose authority a workflow task runs under. A task's worker session has no
 * parent session to inherit from, so everything that would normally cascade
 * down a delegation chain is resolved once from the run's anchor session and
 * handed to whatever the task spawns.
 */
export interface WorkflowTaskAuthority {
  /** Whose BYOK credentials the work resolves models against. */
  credentialOwnerId?: string;
  /** Operator identity a RunAccessGrant compiles from. */
  actorContextJson?: string;
  /**
   * Set only for eval trials, where the anchor carries a trial grant minted at
   * launch and there is no operator actorContext to compile from. Compiling
   * from the space profile instead would hand a frozen trial the home space's
   * write posture.
   */
  grantJson?: string;
  /** The anchor acts for every task it dispatches, so this is the anchor's as it is now. */
  activatedByPerson: boolean;
}

export async function resolveWorkflowTaskAuthority(
  redis: Redis,
  db: PostgresJsDatabase,
  tenantId: string,
  anchorSessionId: string,
  anchorState: SessionHotState | null | undefined,
  spawnedSessionId: string,
): Promise<WorkflowTaskAuthority> {
  // Hot state is a cache with a TTL, and scheduled work outlives it: a
  // workflow that fires against a session parked for days finds nothing in
  // Redis. Whose credentials the work runs under is durable, so read it from
  // the session row rather than dispatching a task that cannot resolve a model.
  const credentialOwnerId =
    anchorState?.createdBy ?? (await readDurableSessionCreatedBy(db, tenantId, anchorSessionId));

  let grantJson: string | undefined;
  if (anchorState?.trigger === 'eval') {
    const anchorGrant = await getRunAccessGrant(redis, tenantId, anchorSessionId);
    if (anchorGrant) {
      grantJson = serializeRunAccessGrant(anchorGrant);
    } else {
      getOrchestratorLogger().warn(
        `[resolveWorkflowTaskAuthority] eval anchor ${anchorSessionId} has no trial grant — ${spawnedSessionId} will be denied fail-closed at its first gated step`,
      );
    }
  }

  return {
    ...(credentialOwnerId !== undefined ? { credentialOwnerId } : {}),
    ...(anchorState?.actorContextJson ? { actorContextJson: anchorState.actorContextJson } : {}),
    ...(grantJson !== undefined ? { grantJson } : {}),
    activatedByPerson: attendedAsActingRun(anchorState),
  };
}
