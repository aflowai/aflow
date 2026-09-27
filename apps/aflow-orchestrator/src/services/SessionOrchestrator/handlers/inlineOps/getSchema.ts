import type { Redis } from 'ioredis';
import type {
  StepExecutionId,
  OperationId,
  StepType,
  StepDefinition,
  IdempotencyKey,
  JsonSchemaObject,
  IntegrationToolDescriptor,
} from '@aflow/schemas';
import {
  getOperationCatalog,
  getAvailableGroups,
  getOperation,
  isOperationComposed,
  isStepTypeComposed,
  parseIntegrationToolId,
  processEditionDescriptor,
  pruneSchemaForAgent,
  STEP_TYPE_DESCRIPTIONS,
} from '@aflow/schemas';
import { addStepResult, getSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { encodeInlineOpOutputRef } from './helpers.js';
import type { FlowExecutionContext } from '../../types.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import { readIntegrations } from '../../helpers/integrationReader.js';
import { buildIntegrationScopeFilter } from '../../helpers/integrationScope.js';
import { DISCOVERY_SCOPE_VAR, type DiscoveryScope } from '../../helpers/agentTurn.js';
import { requireSpaceId } from './spaceScope.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract required and optional param names from a JSON Schema object,
 * stripping internal (orchestrator-managed) fields.
 */
function extractParamNames(
  inputSchema: Record<string, unknown>,
  internalFields?: string[],
): { requiredParams: string[]; optionalParams: string[] } {
  const properties = inputSchema['properties'] as Record<string, unknown> | undefined;
  if (!properties) return { requiredParams: [], optionalParams: [] };

  const internalSet = internalFields ? new Set(internalFields) : undefined;
  const requiredSet = new Set((inputSchema['required'] as string[] | undefined) ?? []);

  const requiredParams: string[] = [];
  const optionalParams: string[] = [];

  for (const key of Object.keys(properties)) {
    if (internalSet?.has(key)) continue;
    if (requiredSet.has(key)) {
      requiredParams.push(key);
    } else {
      optionalParams.push(key);
    }
  }

  return { requiredParams, optionalParams };
}

/**
 * Build a caution string from operation risk modifiers and idempotency.
 */
function buildCaution(op: { riskModifiers: string[]; idempotency: string }): string | undefined {
  const cautions: string[] = [];
  if (op.riskModifiers.includes('external_side_effect')) {
    cautions.push('has external side effects');
  }
  if (op.idempotency === 'non_idempotent') {
    cautions.push('not idempotent');
  }
  if (op.riskModifiers.includes('privileged')) {
    cautions.push('privileged operation');
  }
  return cautions.length > 0 ? cautions.join('; ') : undefined;
}

// ============================================================================
// Inline Handler
// ============================================================================

/**
 * Handle catalog.tool.list inline: three-tier progressive disclosure.
 *
 * - Directory (no filters): step types + groups overview
 * - Compact (stepTypes/groupIds, no operationIds): operationId + one-liner + param names
 * - Detail (operationIds): full pruned input schemas + usage hints
 */
export async function handleGetSchemaInline(
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
    // Read the resolved input to get filter params
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input — return directory */
    }

    const filterStepTypes = input['stepTypes'] as string[] | undefined;
    // A lane the edition does not compose is not listed: an operation that can
    // only fail at dispatch is not a capability to discover.
    const composedLanes = processEditionDescriptor();
    const filterGroupIds = input['groupIds'] as string[] | undefined;
    const filterOperationIds = input['operationIds'] as string[] | undefined;
    const filterToolIds = input['toolIds'] as string[] | undefined;
    const filterCallName = input['callName'] as string | undefined;
    const excludeOperationIds = input['excludeOperationIds'] as string[] | undefined;
    const excludeGroupIds = input['excludeGroupIds'] as string[] | undefined;
    const includeOutputSchema = input['includeOutputSchema'] === true;
    const rawSources = input['sources'] as string[] | undefined;
    const sourcesSet = rawSources && rawSources.length > 0 ? new Set(rawSources) : null;
    const includePlatform = !sourcesSet || sourcesSet.has('platform');
    const includeApis = !sourcesSet || sourcesSet.has('api');
    const includeMcp = !sourcesSet || sourcesSet.has('mcp');

    const hasOperationIds = filterOperationIds && filterOperationIds.length > 0;
    const hasIntegrationLookup =
      (filterToolIds && filterToolIds.length > 0) || typeof filterCallName === 'string';
    const hasScopeFilters =
      (filterStepTypes && filterStepTypes.length > 0) ||
      (filterGroupIds && filterGroupIds.length > 0);

    let outputData: Record<string, unknown>;

    const discoveryScope = await loadDiscoveryScope(redis, context);

    if (hasIntegrationLookup) {
      outputData = await buildIntegrationToolDetail(
        context,
        filterToolIds ?? [],
        filterCallName,
        includeApis,
        includeMcp,
        discoveryScope,
      );
    } else if (!includePlatform) {
      // If sources excludes platform AND no integration toolIds were passed,
      // catalog.tool.list can't help — redirect to search.
      outputData = {
        mode: 'directory',
        guidance:
          'catalog.tool.list browses platform operations only. ' +
          'To discover API endpoints or agents, use catalog.tool.search with sources: ' +
          JSON.stringify(rawSources) +
          '.',
        stepTypes: [],
        totalStepTypes: 0,
        totalOperations: 0,
      };
    } else if (!hasScopeFilters && !hasOperationIds) {
      // ── Tier 1: Directory mode ──────────────────────────────────────────
      const groups = getAvailableGroups().filter((g) =>
        isStepTypeComposed(g.stepType, composedLanes),
      );
      const stepTypeMap = new Map<
        string,
        {
          operationCount: number;
          groups: Array<{ groupId: string; group: string | null; count: number }>;
        }
      >();
      for (const g of groups) {
        const existing = stepTypeMap.get(g.stepType);
        if (existing) {
          existing.operationCount += g.operationCount;
          existing.groups.push({ groupId: g.groupId, group: g.group, count: g.operationCount });
        } else {
          stepTypeMap.set(g.stepType, {
            operationCount: g.operationCount,
            groups: [{ groupId: g.groupId, group: g.group, count: g.operationCount }],
          });
        }
      }

      const directory = [...stepTypeMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stepType, info]) => ({
          stepType,
          description: STEP_TYPE_DESCRIPTIONS[stepType] ?? stepType,
          operationCount: info.operationCount,
          groups: info.groups.map((g) => ({
            groupId: g.groupId,
            group: g.group,
            operationCount: g.count,
          })),
        }));

      const totalOps = directory.reduce((sum, d) => sum + d.operationCount, 0);

      const integrationsSummary = await buildIntegrationsDirectorySummary(
        context,
        includeApis,
        includeMcp,
        discoveryScope,
      );

      const hasIntegrations =
        integrationsSummary !== undefined &&
        integrationsSummary.api.bound + integrationsSummary.mcp.bound > 0;
      const guidanceParts = [
        'This is an overview of available step types. To see operations in a category, ' +
          'call catalog.tool.list with stepTypes (e.g. stepTypes: ["ai", "memory"]). ' +
          'To get the full input schema for a specific operation, use operationIds (e.g. operationIds: ["compute.sandbox.exec"]).',
      ];
      if (hasIntegrations) {
        guidanceParts.push(
          'Bound integrations are available — call catalog.tool.search with a query to find their tools, then catalog.tool.promote to add them to your toolbox.',
        );
      }

      outputData = {
        mode: 'directory',
        guidance: guidanceParts.join(' '),
        stepTypes: directory,
        totalStepTypes: directory.length,
        totalOperations: totalOps,
        ...(integrationsSummary ? { integrations: integrationsSummary } : {}),
      };

      getOrchestratorLogger().debug(
        `[SessionOrchestrator] catalog.tool.list directory mode: ${String(directory.length)} step types, ${String(totalOps)} total operations`,
      );
    } else if (hasScopeFilters && !hasOperationIds) {
      // ── Tier 2: Compact mode — summaries with param names ────────────
      const rawCatalog = getOperationCatalog({
        ...(filterStepTypes ? { stepTypes: filterStepTypes } : {}),
        ...(filterGroupIds ? { groupIds: filterGroupIds } : {}),
        includeOutputSchema: false,
        includeUsageHints: false,
      });

      // Apply exclusion filters
      const excludeOpSet =
        excludeOperationIds && excludeOperationIds.length > 0
          ? new Set(excludeOperationIds)
          : undefined;
      const excludeGrpSet =
        excludeGroupIds && excludeGroupIds.length > 0 ? new Set(excludeGroupIds) : undefined;

      const catalog = {
        ...rawCatalog,
        operations: rawCatalog.operations.filter((op) => {
          if (!isOperationComposed(op.operationId, composedLanes)) return false;
          if (excludeOpSet?.has(op.operationId)) return false;
          if (excludeGrpSet?.has(op.groupId)) return false;
          return true;
        }),
      };

      const operations = catalog.operations.map((op) => {
        const { requiredParams, optionalParams } = extractParamNames(
          op.inputSchema as Record<string, unknown>,
          op.internalFields?.input,
        );
        // Get the full descriptor for risk modifiers (not on catalog entry)
        const descriptor = getOperation(op.operationId as OperationId);
        const caution = descriptor
          ? buildCaution({
              riskModifiers: descriptor.riskModifiers,
              idempotency: descriptor.idempotency,
            })
          : undefined;
        return {
          operationId: op.operationId,
          description: op.usage.oneLine || op.semanticDescription,
          requiredParams,
          optionalParams,
          ...(caution ? { caution } : {}),
        };
      });

      outputData = {
        mode: 'compact',
        guidance: `${String(operations.length)} operations in scope. For full input schemas, call with operationIds: [${operations
          .slice(0, 3)
          .map((o) => `"${o.operationId}"`)
          .join(', ')}${operations.length > 3 ? ', ...' : ''}].`,
        operations,
        count: operations.length,
      };

      getOrchestratorLogger().debug(
        `catalog.tool.list compact mode: ${String(operations.length)} operations returned`,
      );
    } else {
      // ── Tier 3: Detail mode — full pruned schemas ───────────────────
      const rawCatalog = getOperationCatalog({
        ...(filterStepTypes ? { stepTypes: filterStepTypes } : {}),
        ...(filterGroupIds ? { groupIds: filterGroupIds } : {}),
        ...(filterOperationIds ? { operationIds: filterOperationIds } : {}),
        includeOutputSchema,
        includeUsageHints: true,
      });

      // Apply exclusion filters
      const excludeOpSet =
        excludeOperationIds && excludeOperationIds.length > 0
          ? new Set(excludeOperationIds)
          : undefined;
      const excludeGrpSet =
        excludeGroupIds && excludeGroupIds.length > 0 ? new Set(excludeGroupIds) : undefined;

      const catalog = {
        ...rawCatalog,
        operations: rawCatalog.operations.filter((op) => {
          if (!isOperationComposed(op.operationId, composedLanes)) return false;
          if (excludeOpSet?.has(op.operationId)) return false;
          if (excludeGrpSet?.has(op.groupId)) return false;
          return true;
        }),
      };

      const operations = catalog.operations.map((op) => {
        let opInputSchema = op.inputSchema as Record<string, unknown>;

        // Strip internal fields (orchestrator-managed, not agent-visible)
        if (op.internalFields?.input) {
          const properties = opInputSchema['properties'] as Record<string, unknown> | undefined;
          if (properties) {
            const filtered = { ...properties };
            for (const internalField of op.internalFields.input) {
              delete filtered[internalField];
            }
            const originalRequired = (opInputSchema['required'] as string[] | undefined) ?? [];
            const filteredRequired = originalRequired.filter(
              (r) => !op.internalFields!.input!.includes(r),
            );
            opInputSchema = {
              ...opInputSchema,
              properties: filtered,
              ...(filteredRequired.length > 0 ? { required: filteredRequired } : {}),
            };
          }
        }

        // Prune schema boilerplate ($schema, additionalProperties, redundant descriptions)
        opInputSchema = pruneSchemaForAgent(opInputSchema as JsonSchemaObject) as Record<
          string,
          unknown
        >;

        // Lean descriptor: operationId + description + pruned schema + usage (no hashes, no redundant fields)
        const { minimalExampleInput: _, ...usageWithoutExample } = op.usage;
        const descriptor: Record<string, unknown> = {
          operationId: op.operationId,
          description: op.semanticDescription,
          inputSchema: opInputSchema,
          usage: usageWithoutExample,
        };
        if (includeOutputSchema && op.outputSchema) {
          descriptor['outputSchema'] = pruneSchemaForAgent(op.outputSchema);
        }
        return descriptor;
      });

      outputData = {
        mode: 'detail',
        operations,
        count: operations.length,
      };

      getOrchestratorLogger().debug(
        `catalog.tool.list detail mode: ${String(operations.length)} operations returned`,
      );
    }

    // Store output as inline payload ref
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
      operationId: 'catalog.tool.list' as OperationId,
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
    // Emit failure result
    const errorData = {
      code: 'GET_SCHEMA_FAILED',
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
      operationId: 'catalog.tool.list' as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef: errorRef,
      error: errorData,
      resolvedInputRef: resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}

// ============================================================================

/**
 * Read the agent's resolved discovery scope from session runtime state.
 * Returns `undefined` when no scope is configured (e.g. system tests) — the
 * caller treats that as "no clamping". Same shape `catalog.tool.search` uses.
 */
async function loadDiscoveryScope(
  redis: Redis,
  context: FlowExecutionContext,
): Promise<DiscoveryScope | undefined> {
  try {
    const sessionState = await getSessionState(redis, context.tenantId, context.runId);
    const runtimeState = sessionState?.runtimeState;
    if (!runtimeState) return undefined;
    const entry = runtimeState.variables[DISCOVERY_SCOPE_VAR] as
      { ref?: { kind: string; value?: unknown } } | undefined;
    if (
      entry?.ref?.kind === 'inline' &&
      typeof entry.ref.value === 'object' &&
      entry.ref.value !== null
    ) {
      return entry.ref.value as DiscoveryScope;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the `integrations` summary block for directory mode. Buckets bound,
 * needs_credentials, and disabled integrations per source kind, and reports
 * the total callable tool count alongside `definitionOnlyCount` (entries with
 * no binding configured yet — hidden from the per-kind buckets to stay tight).
 */
async function buildIntegrationsDirectorySummary(
  context: FlowExecutionContext,
  includeApis: boolean,
  includeMcp: boolean,
  discoveryScope: DiscoveryScope | undefined,
): Promise<
  | {
      api: { bound: number; needsCredentials: number; disabled: number; toolCount: number };
      mcp: { bound: number; needsCredentials: number; disabled: number; toolCount: number };
      definitionOnlyCount: number;
    }
  | undefined
> {
  try {
    const spaceId = requireSpaceId(context);
    const filter = buildIntegrationScopeFilter(discoveryScope, includeApis, includeMcp);
    const { descriptors, definitionOnlyCount } = await readIntegrations(
      context.tenantId,
      spaceId,
      filter,
    );
    const summary = {
      api: { bound: 0, needsCredentials: 0, disabled: 0, toolCount: 0 },
      mcp: { bound: 0, needsCredentials: 0, disabled: 0, toolCount: 0 },
      definitionOnlyCount,
    };
    for (const d of descriptors) {
      const bucket = summary[d.sourceKind];
      if (d.status === 'bound') {
        bucket.bound += 1;
        bucket.toolCount += d.toolCount;
      } else if (d.status === 'needs_credentials') {
        bucket.needsCredentials += 1;
      } else if (d.status === 'disabled') {
        bucket.disabled += 1;
      }
    }
    return summary;
  } catch (err) {
    // Best-effort — a missing space shouldn't break list directory mode.
    getOrchestratorLogger().warn(
      `[catalog.tool.list] integrations summary failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Resolve `toolIds[]` and/or `callName` to full `IntegrationToolDescriptor`s.
 * When `callName` resolves to multiple candidates, returns an `ambiguous`
 * detail payload with the candidate `toolId`s — the agent re-calls with a
 * specific `toolIds` entry.
 */
async function buildIntegrationToolDetail(
  context: FlowExecutionContext,
  toolIds: readonly string[],
  callName: string | undefined,
  includeApis: boolean,
  includeMcp: boolean,
  discoveryScope: DiscoveryScope | undefined,
): Promise<Record<string, unknown>> {
  const spaceId = requireSpaceId(context);
  const filter = buildIntegrationScopeFilter(discoveryScope, includeApis, includeMcp);
  const { tools } = await readIntegrations(context.tenantId, spaceId, filter);

  const byToolId = new Map(tools.map((t) => [t.toolId, t]));
  const byCallName = new Map<string, IntegrationToolDescriptor[]>();
  for (const t of tools) {
    const list = byCallName.get(t.callName) ?? [];
    list.push(t);
    byCallName.set(t.callName, list);
  }

  const resolved: IntegrationToolDescriptor[] = [];
  for (const toolId of toolIds) {
    // Pre-validate shape so a typo doesn't silently miss.
    if (!parseIntegrationToolId(toolId)) continue;
    const t = byToolId.get(toolId);
    if (t) resolved.push(t);
  }

  if (typeof callName === 'string') {
    const candidates = byCallName.get(callName) ?? [];
    if (candidates.length === 1) {
      const t = candidates[0]!;
      if (!resolved.some((r) => r.toolId === t.toolId)) resolved.push(t);
    } else if (candidates.length > 1) {
      // Ambiguous — the agent must disambiguate by toolId.
      return {
        mode: 'detail',
        operations: [],
        integrationTools: [],
        ambiguous: {
          callName,
          candidates: candidates.map((c) => c.toolId),
        },
        count: 0,
      };
    }
  }

  return {
    mode: 'detail',
    operations: [],
    integrationTools: resolved.map((t) => ({
      sourceKind: t.sourceKind,
      integrationId: t.integrationId,
      bindingId: t.bindingId,
      toolName: t.toolName,
      toolId: t.toolId,
      callName: t.callName,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.opTaskOnly !== undefined ? { opTaskOnly: t.opTaskOnly } : {}),
      ...(t.stale !== undefined ? { stale: t.stale } : {}),
    })),
    count: resolved.length,
  };
}
