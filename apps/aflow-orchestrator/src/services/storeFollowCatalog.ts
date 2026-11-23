import { followStoreCatalog, type FollowCatalogParams } from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';

/**
 * Follow the Store catalog where the space does (Plan 345 B3), before a turn
 * or a run uses the space, and never fail the caller: the run or turn goes on
 * whatever the update did, and a failed update is tried on the next use.
 */
export async function followStoreCatalogBeforeUse(params: FollowCatalogParams): Promise<void> {
  try {
    await followStoreCatalog(params);
  } catch (err) {
    getOrchestratorLogger().warn(
      `[storeFollowCatalog] space ${params.spaceId} could not follow the catalog: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
