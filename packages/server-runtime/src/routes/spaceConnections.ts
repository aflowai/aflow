/**
 * The bound connections a space's agent can carry, each with the per-turn token
 * cost of pinning it.
 *
 * The cost is computed here rather than in the client because it is the cost of
 * the EMITTED tool specs — the same ones the turn assembler pins — and a client
 * estimate would drift from what actually goes on the wire, which is the one
 * number this control exists to show.
 *
 * The list is per BINDING, because that is what
 * `directives.capabilityDiscovery.connections` addresses: an entry grants reach
 * to a binding, and writing the directive at all narrows the agent to exactly
 * the bindings listed. Pinning is per binding for the same reason — a pinned
 * tool carries its binding to the executor — so two bindings of one integration
 * cost two tool sets, not one.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SpaceConnectionSchema, type SpaceConnection } from '@aflow/schemas';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiBindings,
  apiDefinitions,
  mcpServerBindings,
  mcpServerDefinitions,
} from '@aflow/database';
import {
  applyToolFilter,
  estimatePinnedToolTokens,
  estimatePinnedToolTokensFor,
  pinnedToolNameOf,
  mapApiEndpointToToolSpec,
  mapMcpToolToToolSpec,
  type AgentToolSpec,
  type ApiEndpoint,
  type McpCachedTool,
  type McpToolFilter,
} from '@aflow/schemas';

/**
 * One row per tool the connection would pin, priced individually so the
 * composer can total a subset without a second round trip. A spec with no
 * pinnable name is skipped rather than shown: it could never be selected, and
 * an unselectable row reads as a broken control.
 */
function describeTools(
  specs: readonly AgentToolSpec[],
): Array<{ name: string; label: string; tokens: number }> {
  const rows: Array<{ name: string; label: string; tokens: number }> = [];
  for (const spec of specs) {
    const name = pinnedToolNameOf(spec);
    if (name === undefined) continue;
    rows.push({ name, label: spec.name || name, tokens: estimatePinnedToolTokensFor(spec) });
  }
  return rows;
}

interface ApiBindingRowLite {
  bindingId: string;
  apiId: string;
  name: string;
  enabled: number;
}
interface ApiDefinitionRowLite {
  apiId: string;
  name: string;
  definitionJson: unknown;
  enabled: number;
}
interface McpBindingRowLite {
  bindingId: string;
  serverId: string;
  name: string;
  cachedTools: unknown;
  enabled: number;
}
interface McpDefinitionRowLite {
  serverId: string;
  name: string;
  definitionJson: unknown;
  enabled: number;
}

/**
 * Every endpoint of the definition, mapped exactly as the pinned tier maps them.
 * An endpoint the mapper rejects is skipped rather than counted, mirroring the
 * assembler — a definition it cannot map contributes no tool there either.
 */
function apiConnectionSpecs(def: ApiDefinitionRowLite): AgentToolSpec[] {
  const endpoints = (def.definitionJson as { endpoints?: unknown } | null)?.endpoints;
  if (!Array.isArray(endpoints)) return [];
  const specs: AgentToolSpec[] = [];
  for (const endpoint of endpoints) {
    try {
      specs.push(mapApiEndpointToToolSpec(def.apiId, def.name, endpoint as ApiEndpoint));
    } catch {
      continue;
    }
  }
  return specs;
}

function mcpConnectionSpecs(
  def: McpDefinitionRowLite,
  cachedTools: McpCachedTool[],
): AgentToolSpec[] {
  const toolFilter = (def.definitionJson as { toolFilter?: McpToolFilter } | null)?.toolFilter;
  const opTaskOnly = new Set(toolFilter?.opTaskOnly ?? []);
  return applyToolFilter(cachedTools, toolFilter).map((tool) =>
    mapMcpToolToToolSpec(def.serverId, def.name, tool, opTaskOnly.has(tool.name)),
  );
}

/**
 * The space's bound connections, each priced as the pinned tier would emit it.
 *
 * Shared with the directive write guard rather than left inside the route: the
 * guard refuses an always-on list that would breach the tool cap, and the only
 * honest count of what a connection pins is this one.
 */
export async function loadSpaceConnections(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<SpaceConnection[]> {
  const tenantCtx = createTenantContext(tenantId as Parameters<typeof createTenantContext>[0]);

  const { apiBindingRows, apiDefRows, mcpBindingRows, mcpDefRows } = await withTenantSchema(
    db,
    tenantCtx,
    async (tx) => ({
      apiBindingRows: (await tx
        .select({
          bindingId: apiBindings.bindingId,
          apiId: apiBindings.apiId,
          name: apiBindings.name,
          enabled: apiBindings.enabled,
        })
        .from(apiBindings)
        .where(eq(apiBindings.spaceId, spaceId))) as ApiBindingRowLite[],
      apiDefRows: (await tx
        .select({
          apiId: apiDefinitions.apiId,
          name: apiDefinitions.name,
          definitionJson: apiDefinitions.definitionJson,
          enabled: apiDefinitions.enabled,
        })
        .from(apiDefinitions)
        .where(eq(apiDefinitions.spaceId, spaceId))) as ApiDefinitionRowLite[],
      mcpBindingRows: (await tx
        .select({
          bindingId: mcpServerBindings.bindingId,
          serverId: mcpServerBindings.serverId,
          name: mcpServerBindings.name,
          cachedTools: mcpServerBindings.cachedTools,
          enabled: mcpServerBindings.enabled,
        })
        .from(mcpServerBindings)
        .where(eq(mcpServerBindings.spaceId, spaceId))) as McpBindingRowLite[],
      mcpDefRows: (await tx
        .select({
          serverId: mcpServerDefinitions.serverId,
          name: mcpServerDefinitions.name,
          definitionJson: mcpServerDefinitions.definitionJson,
          enabled: mcpServerDefinitions.enabled,
        })
        .from(mcpServerDefinitions)
        .where(eq(mcpServerDefinitions.spaceId, spaceId))) as McpDefinitionRowLite[],
    }),
  );

  const apiDefById = new Map(apiDefRows.map((r) => [r.apiId, r]));
  const mcpDefByServer = new Map(mcpDefRows.map((r) => [r.serverId, r]));
  const connections: SpaceConnection[] = [];

  for (const binding of apiBindingRows) {
    const def = apiDefById.get(binding.apiId);
    const specs = def?.enabled === 1 ? apiConnectionSpecs(def) : [];
    const blockedReason = !def
      ? `No API definition "${binding.apiId}" in this space.`
      : def.enabled !== 1
        ? 'This API is disabled.'
        : binding.enabled !== 1
          ? 'This binding is disabled.'
          : specs.length === 0
            ? 'This API exposes no callable endpoints.'
            : undefined;
    connections.push({
      sourceKind: 'api',
      integrationId: binding.apiId,
      bindingId: binding.bindingId,
      label: def?.name ?? binding.name,
      toolCount: specs.length,
      alwaysOnTokens: estimatePinnedToolTokens(specs),
      tools: describeTools(specs),
      pinnable: blockedReason === undefined,
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    });
  }

  for (const binding of mcpBindingRows) {
    const def = mcpDefByServer.get(binding.serverId);
    const cachedTools = Array.isArray(binding.cachedTools)
      ? (binding.cachedTools as McpCachedTool[])
      : [];
    const specs = def?.enabled === 1 ? mcpConnectionSpecs(def, cachedTools) : [];
    const blockedReason = !def
      ? `No MCP server definition "${binding.serverId}" in this space.`
      : def.enabled !== 1
        ? 'This MCP server is disabled.'
        : binding.enabled !== 1
          ? 'This binding is disabled.'
          : cachedTools.length === 0
            ? 'No cached tools yet — test the binding to populate them.'
            : specs.length === 0
              ? "This server's tool filter exposes no tools."
              : undefined;
    connections.push({
      sourceKind: 'mcp',
      integrationId: binding.serverId,
      bindingId: binding.bindingId,
      label: def?.name ?? binding.name,
      toolCount: specs.length,
      alwaysOnTokens: estimatePinnedToolTokens(specs),
      tools: describeTools(specs),
      pinnable: blockedReason === undefined,
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    });
  }

  connections.sort(
    (a, b) =>
      a.sourceKind.localeCompare(b.sourceKind) ||
      a.label.localeCompare(b.label) ||
      a.bindingId.localeCompare(b.bindingId),
  );
  return connections;
}

export const spaceConnectionsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/connections',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'param' } },
      schema: {
        tags: ['Spaces'],
        summary: 'Connections this space has bound, with the cost of pinning each',
        description:
          'Every API and MCP binding in the space, with the tools and per-turn tokens it pins when placed always_on via directives.capabilityDiscovery.connections.',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: z.object({ connections: z.array(SpaceConnectionSchema) }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase | undefined;
      if (!db) {
        reply.send({ connections: [] });
        return;
      }
      reply.send({
        connections: await loadSpaceConnections(db, tenant.tenantId, request.params.spaceId),
      });
    },
  );
};
