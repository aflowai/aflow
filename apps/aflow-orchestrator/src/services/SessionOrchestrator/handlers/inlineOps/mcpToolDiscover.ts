import type { Redis } from 'ioredis';
import type { StepExecutionId, OperationId, StepDefinition, IdempotencyKey } from '@aflow/schemas';
import {
  applyToolFilter,
  MCP_TOOLS_STALE_AFTER_MS,
  type McpCachedTool,
  type McpToolFilter,
} from '@aflow/schemas';
import { addStepResult, getSessionState } from '@aflow/redis';
import { encodeInlineOpOutputRef } from './helpers.js';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  mcpServerDefinitions,
  mcpServerBindings,
} from '@aflow/database';
import { eq, and, inArray } from 'drizzle-orm';
import { resolveBindingByScope } from '@aflow/lib';
import type { PayloadStore } from '@aflow/payload-store';
import type { FlowExecutionContext } from '../../types.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import { requireSpaceId } from './spaceScope.js';
import { DISCOVERY_SCOPE_VAR, type DiscoveryScope } from '../../helpers/agentTurn.js';

interface BindingCandidate {
  bindingId: string;
  serverId: string;
  spaceId: string;
  authJson: unknown;
  cachedTools: unknown;
  cachedToolsAt: Date | null;
  enabled: boolean;
  pinnedOrigin: string | null;
  scope: { tenantId: string; spaceId?: string; flowId?: string };
}

export async function handleMcpToolDiscoverInline(
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
    // Parse input
    let serverId: string | undefined;
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (data && typeof data === 'object' && 'serverId' in data) {
        const sid = (data as { serverId?: unknown }).serverId;
        if (typeof sid === 'string' && sid.length > 0) serverId = sid;
      }
    } catch {
      /* fall through to validation error */
    }
    if (!serverId) {
      await emitFailure(
        redis,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        startTime,
        'MCP_DISCOVER_INVALID_INPUT',
        'mcp.tool.discover requires { serverId: string }.',
        parentStepExecutionId,
      );
      return;
    }

    const spaceId = requireSpaceId(context);

    const sessionState = await getSessionState(redis, context.tenantId, context.runId);
    const scopeEntry = sessionState?.runtimeState?.variables[DISCOVERY_SCOPE_VAR] as
      { ref?: { kind: string; value?: unknown } } | undefined;
    const scope =
      scopeEntry?.ref?.kind === 'inline' && scopeEntry.ref.value !== null
        ? (scopeEntry.ref.value as DiscoveryScope)
        : undefined;
    const serverEntries = (scope?.mcpServers ?? []).filter((e) => e.serverId === serverId);
    if (serverEntries.length === 0) {
      await emitFailure(
        redis,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        startTime,
        'MCP_SERVER_NOT_IN_SCOPE',
        `MCP server "${serverId}" is not in this agent's scope. ` +
          `Add it to catalog.coreMcpServers, catalog.discovery.allowedMcpServerIds, ` +
          `or grant it via context.capabilities.integrations[] with { sourceKind: 'mcp', integrationId: '${serverId}', bindingId, toolNames }.`,
        parentStepExecutionId,
      );
      return;
    }

    // If ANY entry has no bindingId (e.g. coreMcpServers), the agent has the
    // broad surface — resolver scope-scoring picks the best binding. If ALL
    // entries are binding-pinned grants, the union of pinned bindings is the
    // candidate set. Compute both:
    const broadEntry = serverEntries.find((e) => !e.bindingId);
    const pinnedBindingIds = new Set(
      serverEntries.filter((e) => e.bindingId).map((e) => e.bindingId!),
    );
    // toolNames union across entries (empty when ANY entry is broad).
    let grantedToolNames: Set<string> | undefined;
    if (!broadEntry) {
      grantedToolNames = new Set();
      let allBroad = true;
      for (const e of serverEntries) {
        if (!e.toolNames || e.toolNames.length === 0) {
          allBroad = true;
          break;
        }
        allBroad = false;
        for (const name of e.toolNames) grantedToolNames.add(name);
      }
      if (allBroad) grantedToolNames = undefined;
    }

    // Load definition + bindings from DB.
    const db = getDatabase();
    const tenantCtx = createTenantContext(context.tenantId);
    const { defRow, bindingRows } = await withTenantSchema(db, tenantCtx, async (tx) => {
      const defs = await tx
        .select({
          serverId: mcpServerDefinitions.serverId,
          name: mcpServerDefinitions.name,
          definitionJson: mcpServerDefinitions.definitionJson,
          enabled: mcpServerDefinitions.enabled,
        })
        .from(mcpServerDefinitions)
        .where(
          and(
            eq(mcpServerDefinitions.serverId, serverId),
            eq(mcpServerDefinitions.spaceId, spaceId),
          ),
        )
        .limit(1);
      const bindings = await tx
        .select({
          bindingId: mcpServerBindings.bindingId,
          serverId: mcpServerBindings.serverId,
          spaceId: mcpServerBindings.spaceId,
          scopeJson: mcpServerBindings.scopeJson,
          authJson: mcpServerBindings.authJson,
          cachedTools: mcpServerBindings.cachedTools,
          cachedToolsAt: mcpServerBindings.cachedToolsAt,
          enabled: mcpServerBindings.enabled,
          pinnedOrigin: mcpServerBindings.pinnedOrigin,
        })
        .from(mcpServerBindings)
        .where(inArray(mcpServerBindings.serverId, [serverId]));
      return { defRow: defs[0], bindingRows: bindings };
    });

    if (!defRow || ((defRow.enabled as number | undefined) ?? 1) !== 1) {
      await emitFailure(
        redis,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        startTime,
        'MCP_DEFINITION_NOT_FOUND',
        `MCP definition "${serverId}" not found or disabled in space "${spaceId}".`,
        parentStepExecutionId,
      );
      return;
    }

    // Filter binding candidates by space + tenant; resolve by scope (flow > space > tenant).
    // When the scope is binding-pinned (only grants reachable, no broad coreMcp entry),
    // restrict to those bindingIds so a grant for `kaggle-readonly` cannot widen to
    // `kaggle-admin`.
    let candidates: BindingCandidate[] = bindingRows
      .map((b): BindingCandidate => {
        const scopeJson = (b.scopeJson ?? {}) as Record<string, unknown>;
        const flowId = typeof scopeJson['flowId'] === 'string' ? scopeJson['flowId'] : undefined;
        return {
          bindingId: b.bindingId,
          serverId: b.serverId,
          spaceId: b.spaceId,
          authJson: b.authJson,
          cachedTools: b.cachedTools,
          cachedToolsAt: b.cachedToolsAt,
          enabled: ((b.enabled as number | undefined) ?? 1) === 1,
          pinnedOrigin: b.pinnedOrigin,
          scope: {
            tenantId: (scopeJson['tenantId'] as string | undefined) ?? context.tenantId,
            spaceId: b.spaceId,
            ...(flowId ? { flowId } : {}),
          },
        };
      })
      .filter((b) => b.scope.tenantId === context.tenantId && b.spaceId === spaceId && b.enabled);

    if (!broadEntry && pinnedBindingIds.size > 0) {
      candidates = candidates.filter((b) => pinnedBindingIds.has(b.bindingId));
    }

    const flowId = context.agentDefinition.flowId as string | undefined;
    const binding = resolveBindingByScope<BindingCandidate>(candidates, {
      tenantId: context.tenantId as string,
      spaceId,
      ...(flowId ? { flowId } : {}),
    });
    if (!binding) {
      await emitFailure(
        redis,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        startTime,
        'MCP_BINDING_NOT_AVAILABLE',
        `No enabled MCP binding for server "${serverId}" in space "${spaceId}". ` +
          `Create one via mcp.binding.upsert, then run mcp.binding.test to pin origin.`,
        parentStepExecutionId,
      );
      return;
    }

    // ACL composition — definition.toolFilter is the single source of truth.
    const cachedTools = Array.isArray(binding.cachedTools)
      ? (binding.cachedTools as McpCachedTool[])
      : [];
    const defJson = (defRow.definitionJson ?? {}) as Record<string, unknown>;
    const toolFilter = defJson['toolFilter'] as McpToolFilter | undefined;
    let filtered = applyToolFilter(cachedTools, toolFilter);

    if (grantedToolNames) {
      filtered = filtered.filter((t) => grantedToolNames.has(t.name));
    }

    const cachedToolsAt = binding.cachedToolsAt ? binding.cachedToolsAt.toISOString() : null;
    const stale =
      !cachedToolsAt || Date.now() - new Date(cachedToolsAt).getTime() > MCP_TOOLS_STALE_AFTER_MS;

    const outputData = {
      serverId,
      bindingId: binding.bindingId,
      tools: filtered,
      cachedToolsAt,
      stale,
    };
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
      stepType: stepDef.stepType,
      operationId: stepDef.operation as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    getOrchestratorLogger().debug(
      `[mcp.tool.discover] server=${serverId} binding=${binding.bindingId} tools=${String(filtered.length)} stale=${String(stale)}`,
    );
  } catch (err) {
    await emitFailure(
      redis,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      startTime,
      'MCP_DISCOVER_FAILED',
      err instanceof Error ? err.message : String(err),
      parentStepExecutionId,
    );
  }
}

async function emitFailure(
  redis: Redis,
  context: FlowExecutionContext,
  stepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  startTime: number,
  code: string,
  message: string,
  parentStepExecutionId?: StepExecutionId,
): Promise<void> {
  const errorData = {
    code,
    message,
    classification: 'validation' as const,
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
    stepType: stepDef.stepType,
    operationId: stepDef.operation as OperationId,
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
