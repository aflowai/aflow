import type { AgentToolSpec, ApiEndpoint, McpCachedTool, McpToolFilter } from '@aflow/schemas';
import { applyToolFilter } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import type { PinnedConnection } from './capabilityShedding.js';
import { mapGrantedEndpointsToToolSpecs } from './apiToolMapper.js';
import { mapGrantedMcpToolsToToolSpecs } from './mcpToolMapper.js';

/**
 * Materializing the connections an operator pinned into a turn's tool specs.
 *
 * Separate from the authored `coreApis` / `coreMcpServers` paths because the
 * input is stored operator config, which reaches states platform config never
 * does: a binding gets disabled, a definition is deleted, a tool cache is
 * cleared. Those paths THROW on each of them — correct when the config is the
 * platform's own and a broken one is a bug — but here it would mean a
 * connection someone switched on last week silently takes down every turn in
 * the space. Every failure below therefore drops the connection's tools with a
 * warning and leaves the turn intact.
 *
 * The specs are binding-pinned (the grant mappers, not the integration-keyed
 * ones), so the executor calls the account the operator named rather than
 * re-resolving one by scope.
 *
 * A connection may pin a SUBSET of its tools (`toolNames`). That narrows the
 * pinned tier only: an unpinned tool stays as reachable as it ever was, found
 * through search and promote. The grant mappers already express this, so the
 * subset costs one argument rather than a second selection path.
 */

/**
 * Where this turn's pinned connection specs are cached. Exported because the
 * decision lowering resolves a called tool's binding out of the spec caches: a
 * tool whose spec it cannot find loses its `bindingId` and gets its account
 * re-resolved by scope, which is the reach these specs exist to pin down.
 */
export const PINNED_CONNECTION_TOOLS_VAR = 'ai.agent._pinnedConnectionToolSpecs';
const PINNED_CONNECTION_CACHE_TTL_MS = 60_000;

interface RuntimeStateLike {
  variables: Record<string, unknown>;
}

interface CachedSpecsVar {
  ref?: { kind: string; value?: unknown };
  cachedAtMs?: number;
}

function readCache(runtimeState: RuntimeStateLike): AgentToolSpec[] | undefined {
  const cached = runtimeState.variables[PINNED_CONNECTION_TOOLS_VAR] as CachedSpecsVar | undefined;
  if (cached?.cachedAtMs == null) return undefined;
  if (Date.now() - cached.cachedAtMs >= PINNED_CONNECTION_CACHE_TTL_MS) return undefined;
  if (cached.ref?.kind !== 'inline' || !Array.isArray(cached.ref.value)) return undefined;
  return cached.ref.value as AgentToolSpec[];
}

/**
 * A binding named by more than one pinned entry of the same integration needs
 * its call names qualified, or two accounts of one API collide on one name.
 */
function qualifiedIntegrationIds(connections: readonly PinnedConnection[]): Set<string> {
  const bindingsPer = new Map<string, Set<string>>();
  for (const c of connections) {
    const key = `${c.sourceKind}:${c.integrationId}`;
    const bindings = bindingsPer.get(key) ?? new Set<string>();
    bindings.add(c.bindingId);
    bindingsPer.set(key, bindings);
  }
  return new Set([...bindingsPer].filter(([, b]) => b.size > 1).map(([key]) => key));
}

async function resolveApiSpecs(
  tenantId: string,
  spaceId: string,
  connections: readonly PinnedConnection[],
  qualified: ReadonlySet<string>,
): Promise<AgentToolSpec[]> {
  const { getDatabase, withTenantSchema, createTenantContext, apiDefinitions, apiBindings } =
    await import('@aflow/database');
  const { inArray, eq, and } = await import('drizzle-orm');
  const db = getDatabase();
  type TenantIdType = Parameters<typeof createTenantContext>[0];
  const tenantCtx = createTenantContext(tenantId as TenantIdType);

  const apiIds = [...new Set(connections.map((c) => c.integrationId))];
  const bindingIds = [...new Set(connections.map((c) => c.bindingId))];

  const { defRows, bindingRows } = await withTenantSchema(db, tenantCtx, async (tx) => ({
    defRows: await tx
      .select({
        apiId: apiDefinitions.apiId,
        name: apiDefinitions.name,
        definitionJson: apiDefinitions.definitionJson,
      })
      .from(apiDefinitions)
      .where(
        and(
          inArray(apiDefinitions.apiId, apiIds),
          eq(apiDefinitions.spaceId, spaceId),
          eq(apiDefinitions.enabled, 1),
        ),
      ),
    bindingRows: await tx
      .select({
        bindingId: apiBindings.bindingId,
        apiId: apiBindings.apiId,
        spaceId: apiBindings.spaceId,
        enabled: apiBindings.enabled,
      })
      .from(apiBindings)
      .where(inArray(apiBindings.bindingId, bindingIds)),
  }));

  const defByApiId = new Map(defRows.map((r) => [r.apiId, r]));
  const readyBindings = new Set(
    bindingRows.filter((b) => b.spaceId === spaceId && b.enabled === 1).map((b) => b.bindingId),
  );

  const specs: AgentToolSpec[] = [];
  for (const connection of connections) {
    if (!readyBindings.has(connection.bindingId)) {
      getOrchestratorLogger().warn(
        `[pinnedConnectionTools] API binding "${connection.bindingId}" (api=${connection.integrationId}) ` +
          'is missing, disabled or out of space — its pinned tools are dropped for this turn.',
      );
      continue;
    }
    const def = defByApiId.get(connection.integrationId);
    if (!def) {
      getOrchestratorLogger().warn(
        `[pinnedConnectionTools] API definition "${connection.integrationId}" is missing or disabled ` +
          `in space ${spaceId} — binding "${connection.bindingId}" pins nothing this turn.`,
      );
      continue;
    }
    const endpoints = (def.definitionJson as { endpoints?: unknown } | null)?.endpoints;
    if (!Array.isArray(endpoints)) continue;
    specs.push(
      ...mapGrantedEndpointsToToolSpecs(def.name, endpoints as ApiEndpoint[], {
        capabilityId: connection.bindingId,
        bindingId: connection.bindingId,
        apiId: connection.integrationId,
        grantedEndpointIds: new Set(connection.toolNames ?? []),
        allEndpoints: connection.toolNames === undefined,
        useQualifiedName: qualified.has(`api:${connection.integrationId}`),
      }),
    );
  }
  return specs;
}

async function resolveMcpSpecs(
  tenantId: string,
  spaceId: string,
  connections: readonly PinnedConnection[],
  qualified: ReadonlySet<string>,
): Promise<AgentToolSpec[]> {
  const {
    getDatabase,
    withTenantSchema,
    createTenantContext,
    mcpServerDefinitions,
    mcpServerBindings,
  } = await import('@aflow/database');
  const { inArray, eq, and } = await import('drizzle-orm');
  const db = getDatabase();
  type TenantIdType = Parameters<typeof createTenantContext>[0];
  const tenantCtx = createTenantContext(tenantId as TenantIdType);

  const serverIds = [...new Set(connections.map((c) => c.integrationId))];
  const bindingIds = [...new Set(connections.map((c) => c.bindingId))];

  const { defRows, bindingRows } = await withTenantSchema(db, tenantCtx, async (tx) => ({
    defRows: await tx
      .select({
        serverId: mcpServerDefinitions.serverId,
        name: mcpServerDefinitions.name,
        definitionJson: mcpServerDefinitions.definitionJson,
      })
      .from(mcpServerDefinitions)
      .where(
        and(
          inArray(mcpServerDefinitions.serverId, serverIds),
          eq(mcpServerDefinitions.spaceId, spaceId),
          eq(mcpServerDefinitions.enabled, 1),
        ),
      ),
    bindingRows: await tx
      .select({
        bindingId: mcpServerBindings.bindingId,
        serverId: mcpServerBindings.serverId,
        spaceId: mcpServerBindings.spaceId,
        cachedTools: mcpServerBindings.cachedTools,
        enabled: mcpServerBindings.enabled,
      })
      .from(mcpServerBindings)
      .where(inArray(mcpServerBindings.bindingId, bindingIds)),
  }));

  const defByServerId = new Map(defRows.map((r) => [r.serverId, r]));
  const readyBindings = new Map(
    bindingRows
      .filter((b) => b.spaceId === spaceId && ((b.enabled as number | undefined) ?? 1) === 1)
      .map((b) => [b.bindingId, b]),
  );

  const specs: AgentToolSpec[] = [];
  for (const connection of connections) {
    const binding = readyBindings.get(connection.bindingId);
    if (!binding) {
      getOrchestratorLogger().warn(
        `[pinnedConnectionTools] MCP binding "${connection.bindingId}" (server=${connection.integrationId}) ` +
          'is missing, disabled or out of space — its pinned tools are dropped for this turn.',
      );
      continue;
    }
    const def = defByServerId.get(connection.integrationId);
    if (!def) {
      getOrchestratorLogger().warn(
        `[pinnedConnectionTools] MCP server "${connection.integrationId}" is missing or disabled ` +
          `in space ${spaceId} — binding "${connection.bindingId}" pins nothing this turn.`,
      );
      continue;
    }
    const cachedTools = Array.isArray(binding.cachedTools)
      ? (binding.cachedTools as McpCachedTool[])
      : [];
    if (cachedTools.length === 0) {
      getOrchestratorLogger().warn(
        `[pinnedConnectionTools] MCP binding "${connection.bindingId}" has no cached tools — ` +
          'run mcp.binding.test to populate them.',
      );
      continue;
    }
    const toolFilter = (def.definitionJson as { toolFilter?: McpToolFilter } | null)?.toolFilter;
    specs.push(
      ...mapGrantedMcpToolsToToolSpecs(def.name, applyToolFilter(cachedTools, toolFilter), {
        capabilityId: connection.bindingId,
        bindingId: connection.bindingId,
        serverId: connection.integrationId,
        grantedToolNames: new Set(connection.toolNames ?? []),
        allTools: connection.toolNames === undefined,
        useQualifiedName: qualified.has(`mcp:${connection.integrationId}`),
        opTaskOnlyToolNames: new Set(toolFilter?.opTaskOnly ?? []),
      }),
    );
  }
  return specs;
}

export async function resolvePinnedConnectionToolSpecs(args: {
  tenantId: string;
  spaceId: string | undefined;
  connections: readonly PinnedConnection[];
  runtimeState: RuntimeStateLike;
}): Promise<AgentToolSpec[]> {
  if (args.connections.length === 0) return [];
  const cached = readCache(args.runtimeState);
  if (cached) return cached;

  if (!args.spaceId) {
    getOrchestratorLogger().warn(
      '[pinnedConnectionTools] always-on connections need a spaceId on the run context — none pinned this turn.',
    );
    return [];
  }

  const qualified = qualifiedIntegrationIds(args.connections);
  const apiConnections = args.connections.filter((c) => c.sourceKind === 'api');
  const mcpConnections = args.connections.filter((c) => c.sourceKind === 'mcp');

  const specs: AgentToolSpec[] = [];
  try {
    if (apiConnections.length > 0) {
      specs.push(
        ...(await resolveApiSpecs(args.tenantId, args.spaceId, apiConnections, qualified)),
      );
    }
    if (mcpConnections.length > 0) {
      specs.push(
        ...(await resolveMcpSpecs(args.tenantId, args.spaceId, mcpConnections, qualified)),
      );
    }
  } catch (err) {
    getOrchestratorLogger().warn(
      `[pinnedConnectionTools] failed to resolve always-on connections: ${String(err)} — none pinned this turn.`,
    );
    return [];
  }

  args.runtimeState.variables[PINNED_CONNECTION_TOOLS_VAR] = {
    ref: { kind: 'inline', value: specs },
    cachedAtMs: Date.now(),
  };
  return specs;
}
