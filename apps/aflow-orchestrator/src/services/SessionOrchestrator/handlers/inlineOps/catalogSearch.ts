import type { Redis } from 'ioredis';
import type {
  StepExecutionId,
  OperationId,
  StepType,
  StepDefinition,
  IdempotencyKey,
  ApiEndpoint,
  IntegrationToolDescriptor,
  PersistentAgentTarget,
  SystemRole,
  AgentId,
} from '@aflow/schemas';
import {
  searchCatalog,
  getAvailableGroups,
  getOperation,
  buildGroupId,
  computeSegmentCoverage,
  isOperationComposed,
  isStepTypeComposed,
  processEditionDescriptor,
  tokenizeIdentifier,
} from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { encodeInlineOpOutputRef } from './helpers.js';
import type { FlowExecutionContext } from '../../types.js';
import type { DiscoveryScope } from '../../helpers/agentTurn.js';
import { DISCOVERY_SCOPE_VAR } from '../../helpers/agentTurn.js';
import { readIntegrations } from '../../helpers/integrationReader.js';
import { buildIntegrationScopeFilter } from '../../helpers/integrationScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import { requireSpaceId } from './spaceScope.js';

// ============================================================================

/** Tokenize text for BM25-style scoring: split on non-alphanumeric, lowercase, filter short tokens */
function tokenizeForSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// `API_FIELD_WEIGHTS` was the per-field weight table for the legacy API-only
// scorer. Unified scoring lives in `INTEGRATION_FIELD_WEIGHTS` below.

interface ApiEndpointSearchResult {
  apiId: string;
  apiName: string;
  endpoint: ApiEndpoint;
  toolId: string;
  callName: string;
  description: string;
  matchReason: string;
  score: number;
  type: 'api';
}

// `scoreApiEndpoints` was the pre-Plan-155 API-only scorer. Replaced by the
// unified `scoreIntegrationTools` below. `ApiEndpointSearchResult` is kept
// as the result-merge shape until the merge code is unified.

// ============================================================================

const INTEGRATION_FIELD_WEIGHTS: Record<string, number> = {
  integrationName: 2.0,
  toolName: 1.5,
  toolDescription: 1.5,
  paramNames: 0.8,
};

export interface IntegrationToolSearchResult {
  type: 'api' | 'mcp';
  sourceKind: 'api' | 'mcp';
  integrationId: string;
  integrationName: string;
  bindingId: string;
  toolName: string;
  toolId: string;
  callName: string;
  description: string;
  matchReason: string;
  score: number;
  opTaskOnly?: boolean;
}

/**
 * Score `IntegrationToolDescriptor`s against a query.
 *
 * The reader has already enforced scope (allowlist binding/tool narrowing,
 * source-kind filter, readiness). All we do here is rank by relevance and
 * apply a per-source-kind quota so a noisy server can't crowd out APIs.
 */
export function scoreIntegrationTools(
  tools: readonly IntegrationToolDescriptor[],
  integrationNameByKey: ReadonlyMap<string, string>,
  queryTokens: readonly string[],
  maxResultsPerSource: number,
): IntegrationToolSearchResult[] {
  const scored: IntegrationToolSearchResult[] = [];
  for (const t of tools) {
    const integKey = `${t.sourceKind}:${t.integrationId}`;
    const integrationName = integrationNameByKey.get(integKey) ?? t.integrationId;
    const props = (t.inputSchema['properties'] as Record<string, unknown> | undefined) ?? {};
    const paramNames = Object.keys(props).join(' ');

    const fields: Record<string, string[]> = {
      integrationName: tokenizeForSearch(integrationName),
      toolName: tokenizeForSearch(`${t.integrationId} ${t.toolName} ${t.name}`),
      toolDescription: tokenizeForSearch(t.description),
      paramNames: tokenizeForSearch(paramNames),
    };

    let totalTokens = 0;
    for (const tokens of Object.values(fields)) totalTokens += tokens.length;
    if (totalTokens === 0) continue;

    let totalScore = 0;
    const matchedFields = new Set<string>();
    for (const queryToken of queryTokens) {
      for (const [fieldName, fieldTokens] of Object.entries(fields)) {
        const tf = fieldTokens.filter((tok) => tok === queryToken).length;
        if (tf === 0) continue;
        matchedFields.add(fieldName);
        const fieldWeight = INTEGRATION_FIELD_WEIGHTS[fieldName] ?? 1.0;
        const normTf = tf / (tf + 1);
        totalScore += normTf * fieldWeight;
      }
    }
    if (totalScore <= 0) continue;

    const allSegments = [...tokenizeIdentifier(t.integrationId), ...tokenizeIdentifier(t.toolName)];
    const { boost: segmentBoost } = computeSegmentCoverage([...queryTokens], allSegments);
    totalScore *= segmentBoost;

    const matchParts: string[] = [];
    if (matchedFields.has('integrationName')) {
      matchParts.push(
        t.sourceKind === 'mcp' ? `server "${integrationName}"` : `API "${integrationName}"`,
      );
    }
    if (matchedFields.has('toolName')) matchParts.push('matches tool name');
    if (matchedFields.has('toolDescription')) matchParts.push('matches description');
    if (matchedFields.has('paramNames')) matchParts.push('matches parameters');

    scored.push({
      type: t.sourceKind,
      sourceKind: t.sourceKind,
      integrationId: t.integrationId,
      integrationName,
      bindingId: t.bindingId,
      toolName: t.toolName,
      toolId: t.toolId,
      callName: t.callName,
      description: t.description,
      matchReason: matchParts.length > 0 ? matchParts.join('; ') : 'general match',
      score: totalScore,
      ...(t.opTaskOnly ? { opTaskOnly: true } : {}),
    });
  }

  // Per-source-kind quota: top N for each of `api` and `mcp`.
  scored.sort((a, b) => b.score - a.score);
  const out: IntegrationToolSearchResult[] = [];
  const perKindCount = { api: 0, mcp: 0 } as Record<'api' | 'mcp', number>;
  for (const r of scored) {
    if (perKindCount[r.sourceKind] >= maxResultsPerSource) continue;
    perKindCount[r.sourceKind]++;
    out.push(r);
  }
  return out;
}

export async function handleCatalogSearchInline(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  stepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  _scheduledAtMs: number,
  parentStepExecutionId?: StepExecutionId,
): Promise<void> {
  const startTime = Date.now();
  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    // Parse sources filter: which tool sources to include (default: all)
    const rawSources = input['sources'] as string[] | undefined;
    const sourcesSet = rawSources && rawSources.length > 0 ? new Set(rawSources) : null;
    const includePlatform = !sourcesSet || sourcesSet.has('platform');
    const includeAgents = !sourcesSet || sourcesSet.has('agent');
    const includeApis = !sourcesSet || sourcesSet.has('api');
    const includeMcp = !sourcesSet || sourcesSet.has('mcp');

    const hasFilters =
      input['query'] || input['stepTypes'] || input['groupIds'] || input['operationIds'];

    let outputData: Record<string, unknown>;

    // What this deployment composes an executor for. A step type whose lane the
    // edition does not carry is not a capability to be discovered and promoted;
    // listing it spends a turn on a tool that can only fail at dispatch.
    const composedLanes = processEditionDescriptor();

    if (!hasFilters) {
      // Directory mode: return step types + groups overview
      const groups = getAvailableGroups().filter((g) =>
        isStepTypeComposed(g.stepType, composedLanes),
      );
      const stepTypeMap = new Map<
        string,
        { count: number; groups: Array<{ groupId: string; count: number }> }
      >();
      for (const g of groups) {
        const existing = stepTypeMap.get(g.stepType);
        if (existing) {
          existing.count += g.operationCount;
          existing.groups.push({ groupId: g.groupId, count: g.operationCount });
        } else {
          stepTypeMap.set(g.stepType, {
            count: g.operationCount,
            groups: [{ groupId: g.groupId, count: g.operationCount }],
          });
        }
      }

      const directory = [...stepTypeMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stepType, info]) => ({
          stepType,
          operationCount: info.count,
          groups: info.groups,
        }));

      outputData = {
        mode: 'directory',
        guidance:
          'This is an overview of available step types. ' +
          'Search by intent with catalog.tool.search (e.g., { query: "test api binding" }) ' +
          'or browse a category with catalog.tool.list { stepTypes: ["api"] }. ' +
          'Discovery is read-only — pass the toolIds you want from the result to catalog.tool.promote ' +
          'to add them to your toolbox.',
        stepTypes: directory,
        totalOperations: directory.reduce((sum, d) => sum + d.operationCount, 0),
      };
    } else {
      // Search mode: BM25 ranked results
      const searchInput: Record<string, unknown> = {};
      if (input['query']) searchInput['query'] = input['query'];
      if (input['stepTypes']) searchInput['stepTypes'] = input['stepTypes'];
      if (input['groupIds']) searchInput['groupIds'] = input['groupIds'];
      if (input['operationIds']) searchInput['operationIds'] = input['operationIds'];
      if (input['maxResults']) searchInput['maxResults'] = input['maxResults'];

      // Platform operations search (gated by sources filter)
      const rawResults = includePlatform
        ? searchCatalog(searchInput as Parameters<typeof searchCatalog>[0]).filter((r) =>
            isOperationComposed(r.operationId, composedLanes),
          )
        : [];

      let discoveryScope: DiscoveryScope | undefined;
      {
        const { getSessionState: getSessionStateForScope } = await import('@aflow/redis');
        const scopeSession = await getSessionStateForScope(redis, context.tenantId, context.runId);
        const scopeState = scopeSession?.runtimeState;
        if (scopeState) {
          const scopeEntry = scopeState.variables[DISCOVERY_SCOPE_VAR] as
            { ref?: { kind: string; value?: unknown } } | undefined;
          if (
            scopeEntry?.ref?.kind === 'inline' &&
            typeof scopeEntry.ref.value === 'object' &&
            scopeEntry.ref.value !== null
          ) {
            discoveryScope = scopeEntry.ref.value as DiscoveryScope;
          } else {
            getOrchestratorLogger().warn(
              `[catalogSearch] No _discoveryScope found in runtime state — failing closed (no platform-op or agent results)`,
            );
          }
        }
      }

      // Clamp operation results against the agent's discovery scope. Absent
      // scope fails closed (mirrors checkPlatformOpScope): search must never
      // surface what promotion would reject.
      let results = rawResults;
      if (discoveryScope) {
        // Present (even empty) op-level list = sole authority: `[]` (discovery
        // off) surfaces nothing, matching the promote gate; it must not fall
        // through to allowedStepTypes.
        const scopeOpIds = discoveryScope.allowedOperationIds
          ? new Set(discoveryScope.allowedOperationIds)
          : undefined;
        const allowedStepTypes = new Set(discoveryScope.allowedStepTypes);
        const excludeOpIds = discoveryScope.excludeOperationIds
          ? new Set(discoveryScope.excludeOperationIds)
          : undefined;
        const excludeGrpIds = discoveryScope.excludeGroupIds
          ? new Set(discoveryScope.excludeGroupIds)
          : undefined;

        const beforeCount = results.length;
        results = results.filter((r) => {
          const op = getOperation(r.operationId);
          if (!op) return false;
          // Op-level scope is the sole authority when present (see
          // checkPlatformOpScope — the promote gate applies the same rule).
          if (scopeOpIds) {
            if (!scopeOpIds.has(r.operationId)) return false;
          } else if (!allowedStepTypes.has(op.stepType)) {
            return false;
          }
          if (excludeOpIds?.has(r.operationId)) return false;
          if (excludeGrpIds) {
            const grpId = buildGroupId(op.stepType, op.group);
            if (excludeGrpIds.has(grpId)) return false;
          }
          return true;
        });

        if (results.length < beforeCount) {
          getOrchestratorLogger().info(
            `[catalogSearch] Discovery scope clamping: ${String(beforeCount)} → ${String(results.length)} results`,
          );
        }
      } else {
        results = [];
      }

      let agentResults: Array<{
        target: PersistentAgentTarget;
        name: string;
        description: string;
        matchReason: string;
        type: 'agent';
      }> = [];
      const queryStr = input['query'] as string | undefined;
      // Absent scope fails closed — same contract as ops and integrations.
      const agentDiscoveryAllowed =
        includeAgents && discoveryScope !== undefined && discoveryScope.allowedAgents !== false;
      if (queryStr && agentDiscoveryAllowed) {
        try {
          const { getDatabase, listCustomAgentsInSpace, listPlatformRoles } =
            await import('@aflow/database');
          const db = getDatabase();
          const spaceId = requireSpaceId(context);

          const [platformRoles, customRows] = await Promise.all([
            Promise.resolve(listPlatformRoles()),
            listCustomAgentsInSpace(db, context.tenantId, spaceId),
          ]);

          const lower = queryStr.toLowerCase();

          // Pre-shape into a uniform list with the tagged target.
          const candidates: Array<{
            target: PersistentAgentTarget;
            displayKey: string;
            name: string;
            description: string;
            isSystem: boolean;
          }> = [];
          for (const entry of platformRoles) {
            const def = entry.definition as unknown as Record<string, unknown>;
            const meta = (def['metadata'] ?? {}) as Record<string, unknown>;
            const nameRaw = meta['name'];
            const descRaw = meta['description'];
            candidates.push({
              target: { kind: 'platform-role', systemRole: entry.systemRole as SystemRole },
              displayKey: entry.systemRole,
              name: typeof nameRaw === 'string' && nameRaw.length > 0 ? nameRaw : entry.systemRole,
              description: typeof descRaw === 'string' ? descRaw : '',
              isSystem: true,
            });
          }
          for (const row of customRows) {
            candidates.push({
              target: { kind: 'custom-agent', agentId: row.id as AgentId },
              displayKey: row.slug,
              name: row.name,
              description: row.description ?? '',
              isSystem: false,
            });
          }

          for (const c of candidates) {
            const matchParts: string[] = [];
            if (c.displayKey.toLowerCase().includes(lower)) matchParts.push('matches handle');
            if (c.name.toLowerCase().includes(lower)) matchParts.push('matches name');
            if (c.description.toLowerCase().includes(lower)) matchParts.push('matches description');
            if (matchParts.length === 0) {
              const tokens = lower.split(/\s+/).filter((t) => t.length > 1);
              for (const token of tokens) {
                if (
                  c.name.toLowerCase().includes(token) ||
                  c.description.toLowerCase().includes(token) ||
                  c.displayKey.toLowerCase().includes(token)
                ) {
                  matchParts.push('matches query terms');
                  break;
                }
              }
            }
            if (matchParts.length > 0) {
              agentResults.push({
                target: c.target,
                name: c.name,
                description: c.description,
                matchReason: matchParts.join('; '),
                type: 'agent',
              });
            }
          }
          // Limit agent results
          agentResults = agentResults.slice(0, 3);
        } catch {
          // Best-effort — agent search failure doesn't block operation search
        }
      }

      let integrationResults: IntegrationToolSearchResult[] = [];
      if (queryStr && (includeApis || includeMcp)) {
        try {
          const spaceId = requireSpaceId(context);
          const integrationScopeFilter = buildIntegrationScopeFilter(
            discoveryScope,
            includeApis,
            includeMcp,
          );
          const { tools, descriptors } = await readIntegrations(
            context.tenantId,
            spaceId,
            integrationScopeFilter,
          );
          const integrationNameByKey = new Map(
            descriptors.map((d) => [`${d.sourceKind}:${d.integrationId}`, d.name]),
          );
          const queryTokens = tokenizeForSearch(queryStr);
          const epIdTokens = queryStr.toLowerCase().split('.');
          const allQueryTokens = [
            ...new Set([...queryTokens, ...epIdTokens.filter((t) => t.length > 1)]),
          ];
          // Reviewer P2 — honor the discovery scope's
          // `integrations.maxResultsPerSource` when set; otherwise default
          // to 3. Scoped agents that intentionally narrow their integration
          // surface (cost / noise / policy) must actually get the cap they
          // configured — the prior hard-coded 3 ignored the runtime contract.
          const maxResultsPerSource = discoveryScope?.integrations?.maxResultsPerSource ?? 3;
          integrationResults = scoreIntegrationTools(
            tools,
            integrationNameByKey,
            allQueryTokens,
            maxResultsPerSource,
          );
          if (integrationResults.length > 0) {
            const apiCount = integrationResults.filter((r) => r.sourceKind === 'api').length;
            const mcpCount = integrationResults.filter((r) => r.sourceKind === 'mcp').length;
            const hitBindings = [
              ...new Set(
                integrationResults
                  .map(
                    (r) =>
                      `${r.sourceKind}:${r.integrationId}:${(r.bindingId as string | undefined) ?? '_'}`,
                  )
                  .slice(0, 25),
              ),
            ];
            getOrchestratorLogger().info('[catalogSearch] integration search', {
              tenantId: context.tenantId,
              runId: context.runId,
              event: 'catalog.tool.search.integration',
              query: queryStr.slice(0, 64),
              total: integrationResults.length,
              apiCount,
              mcpCount,
              hitBindings,
              scopeMode: discoveryScope?.integrations?.mode ?? null,
              maxResultsPerSource,
            });
          }
        } catch (integrationSearchErr) {
          getOrchestratorLogger().warn('[catalogSearch] integration search failed', {
            tenantId: context.tenantId,
            runId: context.runId,
            event: 'catalog.tool.search.integration.failed',
            error:
              integrationSearchErr instanceof Error
                ? integrationSearchErr.message
                : String(integrationSearchErr),
          });
        }
      }

      // Legacy variables kept until the merge code below is updated to read
      // from `integrationResults` directly. They mirror the prior shapes so
      // the existing merge + output code can stay in place.
      const apiEndpointResults: ApiEndpointSearchResult[] = integrationResults
        .filter((r) => r.sourceKind === 'api')
        .map((r) => ({
          apiId: r.integrationId,
          apiName: r.integrationName,
          // Endpoint detail isn't required downstream (merge code uses
          // toolId/callName/description), so synthesise a minimal shape.
          endpoint: {
            endpointId: r.toolName,
            name: r.toolName,
            method: 'GET',
            pathTemplate: '',
            params: [],
            tags: [],
          } as unknown as ApiEndpoint,
          toolId: r.toolId,
          callName: r.callName,
          description: r.description,
          matchReason: r.matchReason,
          score: r.score,
          type: 'api' as const,
        }));
      const mcpToolResults = integrationResults
        .filter((r) => r.sourceKind === 'mcp')
        .map((r) => ({
          serverId: r.integrationId,
          serverName: r.integrationName,
          bindingId: r.bindingId,
          toolName: r.toolName,
          toolDescription: r.description,
          inputSchema: undefined,
          toolId: r.toolId,
          callName: r.callName,
          matchReason: r.matchReason,
          score: r.score,
          type: 'mcp' as const,
          opTaskOnly: r.opTaskOnly === true,
        }));

      // Interleave all results across sources by score.
      // Platform ops and API endpoints use comparable scoring after the
      // verb-only penalty (search.ts) and segment coverage boost (reranking.ts).
      // Agent results have no BM25 score — use a position-based estimate.
      const allDiscovered: Array<{ item: Record<string, unknown>; score: number }> = [];

      for (const r of results) {
        allDiscovered.push({
          item: {
            operationId: r.operationId,
            type: 'platform' as const,
            description: r.description,
            matchReason: r.matchReason,
            ...(r.caution ? { caution: r.caution } : {}),
          },
          score: r.score,
        });
      }

      for (let i = 0; i < agentResults.length; i++) {
        const a = agentResults[i]!;
        allDiscovered.push({
          item: {
            target: a.target,
            type: 'agent' as const,
            name: a.name,
            description: a.description,
            matchReason: a.matchReason,
          },
          // Agent results have no BM25 score — use position-based estimate
          // that interleaves with mid-range platform scores
          score: 5.0 / (i + 1),
        });
      }

      for (const ar of apiEndpointResults) {
        allDiscovered.push({
          item: {
            // Show callName as operationId so agents see a consistent callable name
            // in the result table (avoids "—" in the operationId column).
            operationId: ar.callName,
            toolId: ar.toolId,
            callName: ar.callName,
            type: 'api' as const,
            apiId: ar.apiId,
            description: ar.description,
            matchReason: ar.matchReason,
          },
          score: ar.score,
        });
      }

      for (const mr of mcpToolResults) {
        allDiscovered.push({
          item: {
            operationId: mr.callName,
            toolId: mr.toolId,
            callName: mr.callName,
            type: 'mcp' as const,
            serverId: mr.serverId,
            description: mr.toolDescription,
            matchReason: mr.matchReason,
            ...(mr.opTaskOnly ? { opTaskOnly: true } : {}),
          },
          score: mr.score,
        });
      }

      allDiscovered.sort((a, b) => b.score - a.score);

      // Tail pruning: drop results below 30% of the best score.
      // This removes weak verb-only matches that add noise without value.
      const bestScore = allDiscovered.length > 0 ? allDiscovered[0]!.score : 0;
      const scoreThreshold = bestScore * 0.3;
      const pruned =
        bestScore > 0 ? allDiscovered.filter((d) => d.score >= scoreThreshold) : allDiscovered;

      const prunedCount = pruned.length;

      const promotionToolIds: string[] = [];
      for (const d of pruned) {
        const item = d.item;
        const t = item['type'] as string | undefined;
        if (t === 'platform' && typeof item['operationId'] === 'string') {
          promotionToolIds.push(item['operationId']);
        } else if (t === 'agent' && typeof item['agentId'] === 'string') {
          promotionToolIds.push(`agent:${item['agentId']}`);
        } else if ((t === 'api' || t === 'mcp') && typeof item['toolId'] === 'string') {
          promotionToolIds.push(item['toolId']);
        }
      }

      let promotion: string;
      if (prunedCount === 0) {
        promotion = 'No matching tools found.';
      } else {
        const apiTools = pruned.filter((d) => d.item['type'] === 'api');
        const parts = [
          `${String(prunedCount)} tool(s) found. Discovery is read-only — call catalog.tool.promote with the toolIds in suggestedPromoteCall to add them to your toolbox.`,
        ];
        if (apiTools.length > 0) {
          const example = apiTools[0]!.item as Record<string, string>;
          parts.push(
            `Once promoted, API endpoints are directly callable by name (e.g., ${example['callName']}(...)) — do not use api.http.call as a wrapper.`,
          );
        }
        promotion = parts.join(' ');
      }

      const suggestedPromoteCall =
        promotionToolIds.length > 0
          ? {
              operation: 'catalog.tool.promote',
              input: { toolIds: promotionToolIds },
            }
          : undefined;

      // Absent scope fails closed to zero results — but an empty result set is
      // indistinguishable from "nothing matched your query", so the agent
      // reworards and retries (the token burn Plan 233 exists to stop). Teach
      // the WHY in the result envelope instead of only a server log.
      const noDiscoveryGuidance =
        discoveryScope === undefined
          ? 'Discovery is not enabled for this task — no operations are discoverable or ' +
            'promotable here. Use the tools already available to you; do not retry this search.'
          : undefined;

      outputData = {
        mode: 'search',
        discovered: pruned.map((d) => d.item),
        count: prunedCount,
        ...(input['query'] ? { query: input['query'] } : {}),
        promotion: noDiscoveryGuidance ?? promotion,
        ...(suggestedPromoteCall ? { suggestedPromoteCall } : {}),
      };
    }

    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      outputData,
    );

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: 'catalog' as StepType,
      operationId: 'catalog.tool.search' as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  } catch (err) {
    const errorData = {
      code: 'CATALOG_SEARCH_FAILED',
      message: err instanceof Error ? err.message : String(err),
      classification: 'internal' as const,
      retryable: false,
      timestamp: new Date().toISOString(),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: 'catalog' as StepType,
      operationId: 'catalog.tool.search' as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef,
      error: errorData,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
