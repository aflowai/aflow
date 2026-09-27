/**
 * Resolves every tool source a single agent turn may draw on.
 *
 * Six sources land on one surface and their order and precedence are
 * load-bearing: grant-based specs displace the coreApis specs they collide
 * with, and the discovered-tool cap applies only after every source has
 * contributed. Keeping them in one pass — rather than one resolver per source
 * — is what makes those two rules expressible.
 *
 * Cached spec variables are read and rewritten here: a fresh entry skips the
 * definition fetch entirely, which is the difference between a turn that costs
 * a database round trip per integration and one that costs none.
 */
import type { AgentToolSpec, ApiEndpoint, CatalogConfig } from '@aflow/schemas';
import {
  mapApiEndpointToToolSpec,
  mapMcpToolToToolSpec,
  MCP_TOOLS_STALE_AFTER_MS,
} from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { type ParsedApiGrant, type ParsedMcpGrant } from './capabilityGrantsToCatalog.js';
import type { PinnedConnection } from './capabilityShedding.js';

export interface CoreAgentMeta {
  agentId: string;
  name: string;
  description: string;
}

export interface TurnToolSurface {
  coreAgentMetas: CoreAgentMeta[] | undefined;
  mergedApiToolSpecs: AgentToolSpec[] | undefined;
  discoveredApiToolSpecs: AgentToolSpec[] | undefined;
  mergedMcpToolSpecs: AgentToolSpec[] | undefined;
  discoveredMcpToolSpecs: AgentToolSpec[] | undefined;
  appletToolSpecs: AgentToolSpec[] | undefined;
  connectionToolSpecs: AgentToolSpec[];
}

export interface TurnToolSurfaceParams {
  catalogConfig: CatalogConfig | undefined;
  runtimeState: NonNullable<SessionHotState['runtimeState']>;
  parsedApiGrants: ParsedApiGrant[] | undefined;
  parsedMcpGrants: ParsedMcpGrant[] | undefined;
  tenantId: string;
  runId: string;
  spaceId: string | undefined;
  pinnedConnections: PinnedConnection[] | undefined;
}

export async function resolveTurnToolSurface(
  params: TurnToolSurfaceParams,
): Promise<TurnToolSurface> {
  const {
    catalogConfig,
    runtimeState,
    parsedApiGrants,
    parsedMcpGrants,
    tenantId,
    runId,
    spaceId,
    pinnedConnections,
  } = params;
  let coreAgentMetas: CoreAgentMeta[] | undefined;
  if (catalogConfig?.coreAgents && catalogConfig.coreAgents.length > 0) {
    const cachedVar = runtimeState.variables['ai.agent._coreAgentMetas'] as
      { ref?: { kind: string; value?: unknown } } | undefined;
    if (
      cachedVar?.ref?.kind === 'inline' &&
      Array.isArray(cachedVar.ref.value) &&
      cachedVar.ref.value.length > 0
    ) {
      coreAgentMetas = cachedVar.ref.value as CoreAgentMeta[];
      getOrchestratorLogger().debug(
        `[agentTurn] coreAgents cache hit: ${String(coreAgentMetas.length)} agent(s)`,
      );
    } else {
      getOrchestratorLogger().info(
        `[agentTurn] coreAgents found: ${JSON.stringify(catalogConfig.coreAgents)} — fetching metadata`,
      );
      try {
        const { getPlatformAgentBySystemRole } = await import('@aflow/platform-artifacts');
        coreAgentMetas = [];
        for (const coreAgentId of catalogConfig.coreAgents) {
          const entry = getPlatformAgentBySystemRole(coreAgentId);
          if (entry) {
            const def = entry.definition as unknown as Record<string, unknown>;
            const meta = (def['metadata'] ?? {}) as Record<string, unknown>;
            coreAgentMetas.push({
              agentId: entry.systemRole,
              name: (meta['name'] as string | undefined) ?? entry.systemRole,
              description: (meta['description'] as string | undefined) ?? '',
            });
          } else {
            logOrchestratorError(
              `[agentTurn] coreAgent "${coreAgentId}" is not a known platform role; custom-agent lookup by slug is not yet wired here`,
              new Error('UNKNOWN_CORE_AGENT'),
              { tenantId: tenantId, runId: runId },
            );
          }
        }
        // Cache in runtime state for subsequent turns
        runtimeState.variables['ai.agent._coreAgentMetas'] = {
          ref: { kind: 'inline', value: coreAgentMetas },
        };
      } catch (fetchErr) {
        logOrchestratorError(
          '[agentTurn] Failed to fetch coreAgents metadata',
          fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr)),
          { tenantId: tenantId, runId: runId },
        );
      }
    }
  }

  if (coreAgentMetas && coreAgentMetas.length > 0) {
    getOrchestratorLogger().info(
      `[agentTurn] Promoting ${String(coreAgentMetas.length)} agent(s) as virtual tools: ${coreAgentMetas.map((m) => m.agentId).join(', ')}`,
    );
  }

  const API_TOOL_CACHE_TTL_MS = 60_000; // 60 seconds
  let apiToolSpecs: AgentToolSpec[] | undefined;
  if (catalogConfig?.coreApis && catalogConfig.coreApis.length > 0) {
    const cachedApiToolsVar = runtimeState.variables['ai.agent._coreApiToolSpecs'] as
      { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
    const isCacheFresh =
      cachedApiToolsVar?.cachedAtMs != null &&
      Date.now() - cachedApiToolsVar.cachedAtMs < API_TOOL_CACHE_TTL_MS;
    if (
      isCacheFresh &&
      cachedApiToolsVar.ref?.kind === 'inline' &&
      Array.isArray(cachedApiToolsVar.ref.value)
    ) {
      // Cache is fresh — use it even if empty (empty means APIs were deleted/disabled on last fetch)
      apiToolSpecs =
        cachedApiToolsVar.ref.value.length > 0
          ? (cachedApiToolsVar.ref.value as AgentToolSpec[])
          : undefined;
      getOrchestratorLogger().debug(
        `[agentTurn] coreApis cache hit: ${String(cachedApiToolsVar.ref.value.length)} endpoint tool(s), age ${String(Date.now() - cachedApiToolsVar.cachedAtMs!)}ms`,
      );
    } else {
      if (cachedApiToolsVar?.cachedAtMs != null && !isCacheFresh) {
        getOrchestratorLogger().info(
          `[agentTurn] coreApis cache expired (age ${String(Date.now() - cachedApiToolsVar.cachedAtMs)}ms) — re-fetching API definitions`,
        );
      }
      getOrchestratorLogger().info(
        `[agentTurn] coreApis found: ${JSON.stringify(catalogConfig.coreApis)} — fetching API definitions`,
      );
      try {
        if (!spaceId) {
          getOrchestratorLogger().warn(
            '[agentTurn] coreApis configured but no spaceId available — cannot fetch API definitions',
          );
        } else {
          const { getDatabase, withTenantSchema, createTenantContext, apiDefinitions } =
            await import('@aflow/database');
          const { inArray } = await import('drizzle-orm');
          const { eq, and } = await import('drizzle-orm');
          const db = getDatabase();
          type TenantIdType = Parameters<typeof createTenantContext>[0];
          const tenantCtx = createTenantContext(tenantId as TenantIdType);
          const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({
                apiId: apiDefinitions.apiId,
                name: apiDefinitions.name,
                definitionJson: apiDefinitions.definitionJson,
                enabled: apiDefinitions.enabled,
              })
              .from(apiDefinitions)
              .where(
                and(
                  inArray(apiDefinitions.apiId, catalogConfig.coreApis!),
                  eq(apiDefinitions.spaceId, spaceId),
                  eq(apiDefinitions.enabled, 1),
                ),
              );
          });

          // Endpoint-level filter from runner_capability_grants (104n).
          // When a task's grant is `{ apiId: 'X', endpoints: [...] }` (the
          // explicit-endpoint form, allEndpoints !== true), only promote
          // those specific endpoints. The grant is the authority on which
          // endpoints the runner is allowed to call; promoting the full
          // surface widens blast radius beyond what compose-skill
          // intended. coreApis declared without a grant (or with
          // allEndpoints: true) keeps the legacy "promote all" behaviour.
          const grantsByApiId = new Map<string, ParsedApiGrant>();
          if (parsedApiGrants) {
            for (const g of parsedApiGrants) grantsByApiId.set(g.apiId, g);
          }

          apiToolSpecs = [];
          for (const row of rows) {
            const defJson = row.definitionJson as Record<string, unknown>;
            const endpoints = defJson['endpoints'] as Array<Record<string, unknown>> | undefined;
            if (!endpoints || !Array.isArray(endpoints)) continue;

            const grant = grantsByApiId.get(row.apiId);
            const allowedEndpointIds: Set<string> | null =
              grant && !grant.allEndpoints
                ? new Set(grant.endpoints.map((e) => e.endpointId))
                : null;

            for (const ep of endpoints) {
              const epId = ep['endpointId'];
              if (allowedEndpointIds && typeof epId === 'string' && !allowedEndpointIds.has(epId)) {
                continue; // grant scopes us to a subset
              }
              try {
                const toolSpec = mapApiEndpointToToolSpec(row.apiId, row.name, ep as ApiEndpoint);
                apiToolSpecs.push(toolSpec);
              } catch (mapErr) {
                getOrchestratorLogger().warn(
                  `[agentTurn] Failed to map endpoint ${String(ep['endpointId'])} from API ${row.apiId}: ${String(mapErr)}`,
                );
              }
            }
          }

          // Warn about missing API definitions
          const foundApiIds = new Set(rows.map((r) => r.apiId));
          for (const requestedId of catalogConfig.coreApis ?? []) {
            if (!foundApiIds.has(requestedId)) {
              getOrchestratorLogger().warn(
                `[agentTurn] coreApis: API definition "${requestedId}" not found in space ${spaceId} (or disabled)`,
              );
            }
          }

          // Cache in runtime state for subsequent turns (with TTL timestamp for Phase 2 invalidation)
          runtimeState.variables['ai.agent._coreApiToolSpecs'] = {
            ref: { kind: 'inline', value: apiToolSpecs.length > 0 ? apiToolSpecs : [] },
            cachedAtMs: Date.now(),
          };
        }
      } catch (fetchErr) {
        logOrchestratorError(
          '[agentTurn] Failed to fetch coreApis definitions',
          fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr)),
          { tenantId: tenantId, runId: runId },
        );
      }
    }

    if (apiToolSpecs && apiToolSpecs.length > 0) {
      getOrchestratorLogger().info(
        `[agentTurn] Promoting ${String(apiToolSpecs.length)} API endpoint(s) as virtual tools: ${apiToolSpecs
          .map((t) => t.toolId)
          .slice(0, 10)
          .join(
            ',',
          )}${apiToolSpecs.length > 10 ? `,... (+${String(apiToolSpecs.length - 10)} more)` : ''}`,
      );
    } else if (catalogConfig.coreApis.length > 0) {
      // coreApis was set but produced ZERO tool specs — this is the
      // user-observed "API granted but not callable" symptom. Surface
      // diagnostics so the cause is visible (definition not found,
      // endpoint filter excluded everything, etc.).
      getOrchestratorLogger().warn(
        `[agentTurn] coreApis=${JSON.stringify(catalogConfig.coreApis)} but produced 0 promoted tools — ` +
          'check the previous log lines for "API definition not found" / "Failed to map endpoint" / endpoint-filter mismatches.',
      );
    }
  }

  // 104n: Endpoint-filtered, binding-aware API tool promotion from capability grants.
  // Runs AFTER the coreApis fetch. Grant-based specs take precedence on toolId collision.
  let grantApiToolSpecs: AgentToolSpec[] | undefined;
  if (parsedApiGrants && parsedApiGrants.length > 0) {
    const GRANT_API_CACHE_TTL_MS = 60_000;
    const cachedGrantVar = runtimeState.variables['ai.agent._grantApiToolSpecs'] as
      { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
    const isGrantCacheFresh =
      cachedGrantVar?.cachedAtMs != null &&
      Date.now() - cachedGrantVar.cachedAtMs < GRANT_API_CACHE_TTL_MS;

    if (
      isGrantCacheFresh &&
      cachedGrantVar.ref?.kind === 'inline' &&
      Array.isArray(cachedGrantVar.ref.value)
    ) {
      grantApiToolSpecs =
        cachedGrantVar.ref.value.length > 0
          ? (cachedGrantVar.ref.value as AgentToolSpec[])
          : undefined;
    } else {
      try {
        if (spaceId) {
          const { mapGrantedEndpointsToToolSpecs } = await import('./apiToolMapper.js');
          const { getDatabase, withTenantSchema, createTenantContext, apiDefinitions } =
            await import('@aflow/database');
          const { inArray, eq, and } = await import('drizzle-orm');
          const db = getDatabase();
          type TenantIdType = Parameters<typeof createTenantContext>[0];
          const tenantCtx = createTenantContext(tenantId as TenantIdType);

          // Collect unique apiIds from grants
          const grantApiIds = [...new Set(parsedApiGrants.map((g) => g.apiId))];

          // Detect multi-binding: multiple grants for the same apiId
          const apiIdBindingCount = new Map<string, number>();
          for (const g of parsedApiGrants) {
            apiIdBindingCount.set(g.apiId, (apiIdBindingCount.get(g.apiId) ?? 0) + 1);
          }

          // Fetch API definitions
          const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({
                apiId: apiDefinitions.apiId,
                name: apiDefinitions.name,
                definitionJson: apiDefinitions.definitionJson,
              })
              .from(apiDefinitions)
              .where(
                and(
                  inArray(apiDefinitions.apiId, grantApiIds),
                  eq(apiDefinitions.spaceId, spaceId),
                  eq(apiDefinitions.enabled, 1),
                ),
              );
          });

          const defByApiId = new Map(rows.map((r) => [r.apiId, r]));

          // 104n: Verify binding readiness before promoting tools.
          // Only promote endpoints for bindings that exist, are enabled, and in scope.
          const { apiBindings } = await import('@aflow/database');
          const grantBindingIds = [...new Set(parsedApiGrants.map((g) => g.bindingId))];
          const bindingRows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({
                bindingId: apiBindings.bindingId,
                apiId: apiBindings.apiId,
                enabled: apiBindings.enabled,
                scopeJson: apiBindings.scopeJson,
              })
              .from(apiBindings)
              .where(inArray(apiBindings.bindingId, grantBindingIds));
          });
          // Check binding scope: spaceId match or tenant-wide.
          // flowId-scoped bindings are rare and checked at executor time.
          const readyBindings = new Set(
            bindingRows
              .filter((b) => {
                if (b.enabled !== 1) return false;
                const scope = b.scopeJson as Record<string, unknown> | null;
                const scopeFlow = scope?.['flowId'] as string | undefined;
                const scopeSpace = scope?.['spaceId'] as string | undefined;
                // flowId-scoped bindings: checked at executor time (we don't
                // have the resolved flowId here). Allow if no space scope conflict.
                if (scopeFlow) return true; // let executor do the precise check
                if (scopeSpace && spaceId && scopeSpace === spaceId) return true;
                if (!scopeSpace && !scopeFlow) return true; // tenant-wide
                return false;
              })
              .map((b) => b.bindingId),
          );

          grantApiToolSpecs = [];

          for (const grant of parsedApiGrants) {
            // Skip grants for missing/disabled/out-of-scope bindings
            if (!readyBindings.has(grant.bindingId)) {
              getOrchestratorLogger().warn(
                `[agentTurn] Grant binding "${grant.bindingId}" (api=${grant.apiId}) not ready — skipping tool promotion`,
              );
              continue;
            }

            const def = defByApiId.get(grant.apiId);
            if (!def) {
              getOrchestratorLogger().warn(
                `[agentTurn] Grant references API "${grant.apiId}" (binding=${grant.bindingId}) not found in space`,
              );
              continue;
            }

            const defJson = def.definitionJson as Record<string, unknown>;
            const allEndpoints = defJson['endpoints'] as Array<Record<string, unknown>> | undefined;
            if (!allEndpoints || !Array.isArray(allEndpoints)) continue;

            const grantCtx = {
              capabilityId: grant.capabilityId,
              bindingId: grant.bindingId,
              apiId: grant.apiId,
              grantedEndpointIds: new Set(grant.endpoints.map((e) => e.endpointId)),
              allEndpoints: grant.allEndpoints,
              useQualifiedName: (apiIdBindingCount.get(grant.apiId) ?? 0) > 1,
            };

            const specs = mapGrantedEndpointsToToolSpecs(
              def.name,
              allEndpoints as ApiEndpoint[],
              grantCtx,
            );
            grantApiToolSpecs.push(...specs);
          }

          // Cache for subsequent turns
          runtimeState.variables['ai.agent._grantApiToolSpecs'] = {
            ref: { kind: 'inline', value: grantApiToolSpecs.length > 0 ? grantApiToolSpecs : [] },
            cachedAtMs: Date.now(),
          };

          if (grantApiToolSpecs.length > 0) {
            getOrchestratorLogger().info(
              `[agentTurn] 104n: Promoting ${String(grantApiToolSpecs.length)} grant-filtered API endpoint(s) as binding-aware virtual tools`,
            );
          }
        }
      } catch (fetchErr) {
        logOrchestratorError(
          '[agentTurn] Failed to fetch grant-based API definitions',
          fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr)),
          { tenantId: tenantId, runId: runId },
        );
      }
    }

    // Grant-based specs take precedence over coreApis specs on toolId collision
    if (grantApiToolSpecs && grantApiToolSpecs.length > 0 && apiToolSpecs) {
      const grantToolIds = new Set(grantApiToolSpecs.map((s) => s.toolId));
      apiToolSpecs = apiToolSpecs.filter((s) => !grantToolIds.has(s.toolId));
    }
  }

  const MCP_TOOL_CACHE_TTL_MS = 60_000;
  let coreMcpToolSpecs: AgentToolSpec[] | undefined;
  if (catalogConfig?.coreMcpServers && catalogConfig.coreMcpServers.length > 0) {
    const cachedMcpToolsVar = runtimeState.variables['ai.agent._coreMcpToolSpecs'] as
      { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
    const isMcpCacheFresh =
      cachedMcpToolsVar?.cachedAtMs != null &&
      Date.now() - cachedMcpToolsVar.cachedAtMs < MCP_TOOL_CACHE_TTL_MS;
    if (
      isMcpCacheFresh &&
      cachedMcpToolsVar.ref?.kind === 'inline' &&
      Array.isArray(cachedMcpToolsVar.ref.value)
    ) {
      coreMcpToolSpecs =
        cachedMcpToolsVar.ref.value.length > 0
          ? (cachedMcpToolsVar.ref.value as AgentToolSpec[])
          : undefined;
    } else {
      if (!spaceId) {
        throw new Error(
          `core_mcp_no_space: coreMcpServers=${JSON.stringify(catalogConfig.coreMcpServers)} ` +
            'requires a spaceId on the run context.',
        );
      }

      const {
        getDatabase,
        withTenantSchema,
        createTenantContext,
        mcpServerDefinitions,
        mcpServerBindings,
      } = await import('@aflow/database');
      const { inArray, eq, and } = await import('drizzle-orm');
      const { applyToolFilter } = await import('@aflow/schemas');
      const { resolveBindingByScope } = await import('@aflow/lib');
      const db = getDatabase();
      type TenantIdType = Parameters<typeof createTenantContext>[0];
      const tenantCtx = createTenantContext(tenantId as TenantIdType);

      const { defRows, bindingRows } = await withTenantSchema(db, tenantCtx, async (tx) => {
        const defRows = await tx
          .select({
            serverId: mcpServerDefinitions.serverId,
            name: mcpServerDefinitions.name,
            definitionJson: mcpServerDefinitions.definitionJson,
            enabled: mcpServerDefinitions.enabled,
          })
          .from(mcpServerDefinitions)
          .where(
            and(
              inArray(mcpServerDefinitions.serverId, catalogConfig.coreMcpServers!),
              eq(mcpServerDefinitions.spaceId, spaceId),
            ),
          );
        const bindingRows = await tx
          .select({
            bindingId: mcpServerBindings.bindingId,
            serverId: mcpServerBindings.serverId,
            spaceId: mcpServerBindings.spaceId,
            scopeJson: mcpServerBindings.scopeJson,
            authJson: mcpServerBindings.authJson,
            cachedTools: mcpServerBindings.cachedTools,
            cachedToolsAt: mcpServerBindings.cachedToolsAt,
            subscribeListChanged: mcpServerBindings.subscribeListChanged,
            enabled: mcpServerBindings.enabled,
          })
          .from(mcpServerBindings)
          .where(inArray(mcpServerBindings.serverId, catalogConfig.coreMcpServers!));
        return { defRows, bindingRows };
      });

      const defByServer = new Map(defRows.map((r) => [r.serverId, r]));
      const bindingsByServer = new Map<string, typeof bindingRows>();
      for (const b of bindingRows) {
        const list = bindingsByServer.get(b.serverId) ?? [];
        list.push(b);
        bindingsByServer.set(b.serverId, list);
      }

      coreMcpToolSpecs = [];
      for (const serverId of catalogConfig.coreMcpServers) {
        const def = defByServer.get(serverId);
        if (!def) {
          throw new Error(
            `core_mcp_definition_unavailable: MCP server "${serverId}" not found in space "${spaceId}". ` +
              'Install the bundle or create the definition before listing it in coreMcpServers.',
          );
        }
        if (((def.enabled as number | undefined) ?? 1) !== 1) {
          throw new Error(
            `core_mcp_definition_unavailable: MCP server "${serverId}" is disabled in space "${spaceId}".`,
          );
        }

        interface McpBindingCandidate {
          bindingId: string;
          serverId: string;
          spaceId: string;
          authJson: unknown;
          cachedTools: unknown;
          cachedToolsAt: Date | null;
          subscribeListChanged: boolean;
          enabled: boolean;
          scope: { tenantId: string; spaceId?: string; flowId?: string };
        }
        const candidates: McpBindingCandidate[] = (bindingsByServer.get(serverId) ?? [])
          .map((b): McpBindingCandidate => {
            const scope = (b.scopeJson ?? {}) as Record<string, unknown>;
            const flowId = typeof scope['flowId'] === 'string' ? scope['flowId'] : undefined;
            return {
              bindingId: b.bindingId,
              serverId: b.serverId,
              spaceId: b.spaceId,
              authJson: b.authJson,
              cachedTools: b.cachedTools,
              cachedToolsAt: b.cachedToolsAt ?? null,
              subscribeListChanged: ((b.subscribeListChanged as number | undefined) ?? 1) === 1,
              enabled: ((b.enabled as number | undefined) ?? 1) === 1,
              scope: {
                tenantId: (scope['tenantId'] as string | undefined) ?? tenantId,
                spaceId: b.spaceId,
                ...(flowId ? { flowId } : {}),
              },
            };
          })
          .filter((b) => b.scope.tenantId === tenantId);

        const resolved = resolveBindingByScope<McpBindingCandidate>(candidates, {
          tenantId: tenantId,
          spaceId,
        });
        if (!resolved) {
          throw new Error(
            `core_mcp_binding_unavailable: no MCP binding for server "${serverId}" matches the current scope (tenant=${tenantId}, space=${spaceId}).`,
          );
        }
        if (!resolved.enabled) {
          throw new Error(
            `core_mcp_binding_disabled: MCP binding "${resolved.bindingId}" for server "${serverId}" is disabled. Run mcp.binding.test, then enable it.`,
          );
        }

        const cachedTools = Array.isArray(resolved.cachedTools)
          ? (resolved.cachedTools as Array<{
              name: string;
              description?: string;
              inputSchema?: Record<string, unknown>;
            }>)
          : null;
        if (!cachedTools || cachedTools.length === 0) {
          throw new Error(
            `core_mcp_cache_unpopulated: binding "${resolved.bindingId}" for server "${serverId}" has no cached tools. Run mcp.binding.test to populate.`,
          );
        }

        if (
          resolved.cachedToolsAt &&
          Date.now() - resolved.cachedToolsAt.getTime() > MCP_TOOLS_STALE_AFTER_MS
        ) {
          const ageHours = Math.floor(
            (Date.now() - resolved.cachedToolsAt.getTime()) / (60 * 60 * 1000),
          );
          getOrchestratorLogger().warn(
            `[agentTurn] coreMcpServers "${serverId}" binding "${resolved.bindingId}" ` +
              `has stale cachedTools (last refreshed ${String(ageHours)}h ago, subscribeListChanged=${String(resolved.subscribeListChanged)}). ` +
              `Run mcp.server.refresh_tools to refresh, or verify the server supports notifications/tools/list_changed.`,
          );
        }

        const defJson = (def.definitionJson ?? {}) as Record<string, unknown>;
        const toolFilter = defJson['toolFilter'] as
          { include?: string[]; exclude?: string[]; opTaskOnly?: string[] } | undefined;

        const filtered = applyToolFilter(cachedTools, toolFilter);

        if (filtered.length === 0) {
          getOrchestratorLogger().warn(
            `[agentTurn] coreMcpServers "${serverId}" has ${String(cachedTools.length)} cached tools, ` +
              `but definition.toolFilter leaves none exposed.`,
          );
          continue;
        }
        if (filtered.length > 15) {
          getOrchestratorLogger().warn(
            `[agentTurn] coreMcpServers "${serverId}" exposes ${String(filtered.length)} tools (>15). ` +
              'Consider narrowing definition.toolFilter.include to keep the hot set focused.',
          );
        }

        const opTaskOnlySet = new Set(toolFilter?.opTaskOnly ?? []);
        for (const tool of filtered) {
          coreMcpToolSpecs.push(
            mapMcpToolToToolSpec(serverId, def.name, tool, opTaskOnlySet.has(tool.name)),
          );
        }
      }

      runtimeState.variables['ai.agent._coreMcpToolSpecs'] = {
        ref: { kind: 'inline', value: coreMcpToolSpecs.length > 0 ? coreMcpToolSpecs : [] },
        cachedAtMs: Date.now(),
      };
    }

    if (coreMcpToolSpecs && coreMcpToolSpecs.length > 0) {
      getOrchestratorLogger().info(
        `[agentTurn] Promoting ${String(coreMcpToolSpecs.length)} MCP tool(s) from coreMcpServers: ${coreMcpToolSpecs
          .map((t) => t.toolId)
          .slice(0, 10)
          .join(
            ',',
          )}${coreMcpToolSpecs.length > 10 ? `,... (+${String(coreMcpToolSpecs.length - 10)} more)` : ''}`,
      );
    }
  }

  let grantMcpToolSpecs: AgentToolSpec[] | undefined;
  if (parsedMcpGrants && parsedMcpGrants.length > 0) {
    const GRANT_MCP_CACHE_TTL_MS = 60_000;
    const cachedGrantMcpVar = runtimeState.variables['ai.agent._grantMcpToolSpecs'] as
      { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
    const isGrantMcpCacheFresh =
      cachedGrantMcpVar?.cachedAtMs != null &&
      Date.now() - cachedGrantMcpVar.cachedAtMs < GRANT_MCP_CACHE_TTL_MS;

    if (
      isGrantMcpCacheFresh &&
      cachedGrantMcpVar.ref?.kind === 'inline' &&
      Array.isArray(cachedGrantMcpVar.ref.value)
    ) {
      grantMcpToolSpecs =
        cachedGrantMcpVar.ref.value.length > 0
          ? (cachedGrantMcpVar.ref.value as AgentToolSpec[])
          : undefined;
    } else {
      if (spaceId) {
        try {
          const { mapGrantedMcpToolsToToolSpecs } = await import('./mcpToolMapper.js');
          const {
            getDatabase,
            withTenantSchema,
            createTenantContext,
            mcpServerDefinitions,
            mcpServerBindings,
          } = await import('@aflow/database');
          const { inArray, eq, and } = await import('drizzle-orm');
          const { applyToolFilter } = await import('@aflow/schemas');
          const db = getDatabase();
          type TenantIdType = Parameters<typeof createTenantContext>[0];
          const tenantCtx = createTenantContext(tenantId as TenantIdType);

          const grantServerIds = [...new Set(parsedMcpGrants.map((g) => g.serverId))];
          const grantBindingIds = [...new Set(parsedMcpGrants.map((g) => g.bindingId))];

          // Detect multi-binding per server (multiple grants for same serverId).
          const serverBindingCount = new Map<string, number>();
          for (const g of parsedMcpGrants) {
            serverBindingCount.set(g.serverId, (serverBindingCount.get(g.serverId) ?? 0) + 1);
          }

          const { defRows, bindingRows } = await withTenantSchema(db, tenantCtx, async (tx) => {
            const defRows = await tx
              .select({
                serverId: mcpServerDefinitions.serverId,
                name: mcpServerDefinitions.name,
                definitionJson: mcpServerDefinitions.definitionJson,
              })
              .from(mcpServerDefinitions)
              .where(
                and(
                  inArray(mcpServerDefinitions.serverId, grantServerIds),
                  eq(mcpServerDefinitions.spaceId, spaceId),
                  eq(mcpServerDefinitions.enabled, 1),
                ),
              );
            const bindingRows = await tx
              .select({
                bindingId: mcpServerBindings.bindingId,
                serverId: mcpServerBindings.serverId,
                spaceId: mcpServerBindings.spaceId,
                authJson: mcpServerBindings.authJson,
                cachedTools: mcpServerBindings.cachedTools,
                enabled: mcpServerBindings.enabled,
                pinnedOrigin: mcpServerBindings.pinnedOrigin,
              })
              .from(mcpServerBindings)
              .where(inArray(mcpServerBindings.bindingId, grantBindingIds));
            return { defRows, bindingRows };
          });

          const defByServer = new Map(defRows.map((r) => [r.serverId, r]));
          // 104n-style binding readiness check: each grant must reference a
          // binding that exists in THIS space (post-migration 84 composite PK),
          // is enabled, and — for credentialed auth — has pinnedOrigin set.
          const readyBindings = new Map<string, (typeof bindingRows)[number]>();
          for (const b of bindingRows) {
            if (b.spaceId !== spaceId) continue;
            if (((b.enabled as number | undefined) ?? 1) !== 1) continue;
            const auth = (b.authJson ?? {}) as Record<string, unknown>;
            const authType = auth['type'] as string | undefined;
            if (authType && authType !== 'none' && !b.pinnedOrigin) continue;
            readyBindings.set(b.bindingId, b);
          }

          grantMcpToolSpecs = [];
          for (const grant of parsedMcpGrants) {
            const binding = readyBindings.get(grant.bindingId);
            if (!binding) {
              getOrchestratorLogger().warn(
                `[agentTurn] MCP grant binding "${grant.bindingId}" (server=${grant.serverId}) ` +
                  'not ready (missing / disabled / unpinned credentialed binding) — skipping tool promotion',
              );
              continue;
            }
            const def = defByServer.get(grant.serverId);
            if (!def) {
              getOrchestratorLogger().warn(
                `[agentTurn] MCP grant references server "${grant.serverId}" (binding=${grant.bindingId}) ` +
                  `not found in space "${spaceId}"`,
              );
              continue;
            }

            const cachedTools = Array.isArray(binding.cachedTools)
              ? (binding.cachedTools as Array<{
                  name: string;
                  description?: string;
                  inputSchema?: Record<string, unknown>;
                }>)
              : [];
            if (cachedTools.length === 0) {
              getOrchestratorLogger().warn(
                `[agentTurn] MCP grant binding "${grant.bindingId}" has no cachedTools — run mcp.binding.test first.`,
              );
              continue;
            }

            const defJson = (def.definitionJson ?? {}) as Record<string, unknown>;
            const toolFilter = defJson['toolFilter'] as
              { include?: string[]; exclude?: string[]; opTaskOnly?: string[] } | undefined;

            const filtered = applyToolFilter(cachedTools, toolFilter);

            const grantCtx = {
              capabilityId: grant.capabilityId,
              bindingId: grant.bindingId,
              serverId: grant.serverId,
              grantedToolNames: new Set(grant.tools.map((t) => t.toolName)),
              allTools: grant.allTools,
              useQualifiedName: (serverBindingCount.get(grant.serverId) ?? 0) > 1,
              opTaskOnlyToolNames: new Set(toolFilter?.opTaskOnly ?? []),
            };

            const specs = mapGrantedMcpToolsToToolSpecs(def.name, filtered, grantCtx);
            grantMcpToolSpecs.push(...specs);
          }

          runtimeState.variables['ai.agent._grantMcpToolSpecs'] = {
            ref: {
              kind: 'inline',
              value: grantMcpToolSpecs.length > 0 ? grantMcpToolSpecs : [],
            },
            cachedAtMs: Date.now(),
          };

          if (grantMcpToolSpecs.length > 0) {
            getOrchestratorLogger().info(
              `[agentTurn] §3.2: Promoting ${String(grantMcpToolSpecs.length)} grant-filtered MCP tool(s) as binding-aware virtual tools`,
            );
          }
        } catch (fetchErr) {
          logOrchestratorError(
            '[agentTurn] Failed to fetch grant-based MCP definitions',
            fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr)),
            { tenantId: tenantId, runId: runId },
          );
        }
      }
    }
  }

  // Plan 264 §4.13 tier 3: resolve the session's current applet instance and
  // lower its actions as typed tools for this turn. Re-resolved every turn —
  // never cached — so appletMeta.baseVersion is the freshest assembly-time
  // read and a focus change takes effect on the next turn.
  const { resolveAppletTurnContext } = await import('./appletTurnContext.js');
  const { APPLET_TOOL_SPECS_VAR } = await import('./appletToolMapper.js');
  const appletContext = await resolveAppletTurnContext({
    tenantId: tenantId,
    runId: runId,
    spaceId: spaceId,
  });
  const appletToolSpecs = appletContext.toolSpecs;
  // Written even when empty: dispatch admits an applet lowering only for a
  // spec recorded here THIS turn, so a stale entry must be cleared.
  runtimeState.variables[APPLET_TOOL_SPECS_VAR] = {
    ref: { kind: 'inline', value: appletToolSpecs ?? [] },
  };

  let discoveredApiToolSpecs: AgentToolSpec[] | undefined;
  const discoveredApiCache = runtimeState.variables['ai.agent._discoveredApiToolSpecs'] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  if (
    discoveredApiCache?.ref?.kind === 'inline' &&
    Array.isArray(discoveredApiCache.ref.value) &&
    discoveredApiCache.ref.value.length > 0
  ) {
    discoveredApiToolSpecs = discoveredApiCache.ref.value as AgentToolSpec[];
  }

  let discoveredMcpToolSpecs: AgentToolSpec[] | undefined;
  const discoveredMcpCache = runtimeState.variables['ai.agent._discoveredMcpToolSpecs'] as
    { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
  if (
    discoveredMcpCache?.ref?.kind === 'inline' &&
    Array.isArray(discoveredMcpCache.ref.value) &&
    discoveredMcpCache.ref.value.length > 0
  ) {
    discoveredMcpToolSpecs = discoveredMcpCache.ref.value as AgentToolSpec[];
  }

  // 104n: Merge grant-based API tool specs into the apiToolSpecs array.
  // Grant specs take precedence (collision already removed above).
  const mergedApiToolSpecs =
    grantApiToolSpecs && grantApiToolSpecs.length > 0
      ? [...(apiToolSpecs ?? []), ...grantApiToolSpecs]
      : apiToolSpecs;

  // MCP servers on the operator's own machine.
  //
  // The tool list comes from the connected folder rather than from a cache this
  // process refreshed, because nothing here can reach that machine to ask. The
  // machine recorded what each server said when the folder was connected, which
  // makes this a snapshot — and the right one, since a server that is not
  // reachable from here cannot be polled from here either.
  const localMcpToolSpecs = await resolveLocalMcpToolSpecs(tenantId, spaceId, runtimeState);

  const mergedMcpToolSpecs = [
    ...(coreMcpToolSpecs ?? []),
    ...(grantMcpToolSpecs ?? []),
    ...localMcpToolSpecs,
  ];

  const { resolvePinnedConnectionToolSpecs } = await import('./pinnedConnectionTools.js');
  const connectionToolSpecs = await resolvePinnedConnectionToolSpecs({
    tenantId: tenantId,
    spaceId: spaceId,
    connections: pinnedConnections ?? [],
    runtimeState,
  });
  return {
    coreAgentMetas,
    mergedApiToolSpecs,
    discoveredApiToolSpecs,
    mergedMcpToolSpecs: mergedMcpToolSpecs.length > 0 ? mergedMcpToolSpecs : undefined,
    discoveredMcpToolSpecs,
    appletToolSpecs,
    connectionToolSpecs,
  };
}

/** The variable the lowering recovers a local tool's routing from. */
export const LOCAL_MCP_TOOLS_VAR = 'ai.agent._localMcpToolSpecs';

/** Short, because it is read from a row this turn is already entitled to read. */
const LOCAL_MCP_CACHE_TTL_MS = 60_000;

async function resolveLocalMcpToolSpecs(
  tenantId: string,
  spaceId: string | undefined,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
): Promise<AgentToolSpec[]> {
  if (spaceId === undefined) return [];

  const cached = runtimeState.variables[LOCAL_MCP_TOOLS_VAR] as
    { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
  if (
    cached?.cachedAtMs != null &&
    Date.now() - cached.cachedAtMs < LOCAL_MCP_CACHE_TTL_MS &&
    cached.ref?.kind === 'inline' &&
    Array.isArray(cached.ref.value)
  ) {
    return cached.ref.value as AgentToolSpec[];
  }

  const specs: AgentToolSpec[] = [];
  try {
    const { getDatabase, withTenantSchema, createTenantContext, hostBindings } =
      await import('@aflow/database');
    const { eq } = await import('drizzle-orm');
    const db = getDatabase();
    const rows = await withTenantSchema(db, createTenantContext(tenantId as never), async (tx) =>
      tx
        .select({ hostBindingId: hostBindings.hostBindingId, mcpServers: hostBindings.mcpServers })
        .from(hostBindings)
        .where(eq(hostBindings.spaceId, spaceId)),
    );
    for (const row of rows) {
      for (const server of row.mcpServers) {
        for (const tool of server.tools ?? []) {
          specs.push(
            mapMcpToolToToolSpec(
              server.id,
              server.label,
              {
                name: tool.name,
                ...(tool.description !== undefined ? { description: tool.description } : {}),
                ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
              },
              false,
              undefined,
              row.hostBindingId,
            ),
          );
        }
      }
    }
  } catch (err) {
    getOrchestratorLogger().warn(
      `[agentTurn] local MCP tool specs failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  runtimeState.variables[LOCAL_MCP_TOOLS_VAR] = {
    ref: { kind: 'inline', value: specs },
    cachedAtMs: Date.now(),
  };
  return specs;
}
