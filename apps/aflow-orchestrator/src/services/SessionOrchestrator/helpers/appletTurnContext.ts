/**
 * Per-turn applet context — the session's current instance resolved at
 * assembly and its actions lowered as typed tools. Deliberately nothing
 * else: per-action state must never ride the prompt prefix (it would bust
 * the conversation cache every move) — the fresh situation is what
 * ui.applet.get returns at the conversation tail. Best-effort by design: a
 * failure costs this turn's applet affordances, never the turn.
 */
import type { AgentToolSpec } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';

export interface AppletTurnContext {
  toolSpecs: AgentToolSpec[] | undefined;
}

export async function resolveAppletTurnContext(params: {
  tenantId: string;
  runId: string;
  spaceId: string | undefined;
}): Promise<AppletTurnContext> {
  const { tenantId, runId, spaceId } = params;
  let toolSpecs: AgentToolSpec[] | undefined;
  if (!spaceId) return { toolSpecs };
  try {
    const { resolveCurrentAppletInstance, mapAppletActionsToToolSpecs } =
      await import('./appletToolMapper.js');
    const { getRedisConnection, getAppletFocus } = await import('@aflow/redis');
    const { getDatabase, createTenantContext, createAppletPersistence } =
      await import('@aflow/database');
    const redis = getRedisConnection();
    type TenantIdType = Parameters<typeof createTenantContext>[0];
    const persistence = createAppletPersistence(
      getDatabase(),
      createTenantContext(tenantId as TenantIdType),
    );
    const resolved = await resolveCurrentAppletInstance(spaceId, {
      getFocus: () => getAppletFocus(redis, tenantId, runId),
      loadInstance: (instanceId) =>
        persistence.transact((tx) => tx.loadInstanceForUpdate(instanceId)),
      listActiveInstances: () =>
        persistence.transact((tx) =>
          tx.listInstances({ spaceId, status: 'active', limit: 2, offset: 0 }),
        ),
    });
    if (resolved) {
      toolSpecs = mapAppletActionsToToolSpecs(resolved);
      getOrchestratorLogger().info(
        `[agentTurn] §4.14: Lowering ${String(toolSpecs.length)} action(s) of applet ` +
          `instance ${resolved.instance.instanceId} (${resolved.definition.appletKey}) as virtual tools`,
      );
    }
  } catch (fetchErr) {
    logOrchestratorError(
      '[agentTurn] Failed to resolve applet focus for action lowering',
      fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr)),
      { tenantId, runId },
    );
  }
  return { toolSpecs };
}
