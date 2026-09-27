import type { Redis } from 'ioredis';
import type {
  StepExecutionId,
  OperationId,
  StepDefinition,
  IdempotencyKey,
  AgentToolSpec,
} from '@aflow/schemas';
import {
  applyToolFilter,
  mapMcpToolToToolSpec,
  type McpCachedTool,
  type McpToolFilter,
} from '@aflow/schemas';
import { addStepResult, updateSessionState, getSessionState } from '@aflow/redis';
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
import {
  DISCOVERY_SCOPE_VAR,
  type DiscoveryScope,
  type VirtualToolEntry,
} from '../../helpers/agentTurn.js';
import { readInlineVar, writeInlineVar } from '../../helpers/runtimeState.js';

interface BindingCandidate {
  bindingId: string;
  serverId: string;
  spaceId: string;
  authJson: unknown;
  cachedTools: unknown;
  enabled: boolean;
  scope: { tenantId: string; spaceId?: string; flowId?: string };
}

export async function handleMcpToolPromoteInline(
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
    let toolNames: string[] = [];
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (data && typeof data === 'object') {
        const sid = (data as { serverId?: unknown }).serverId;
        const names = (data as { toolNames?: unknown }).toolNames;
        if (typeof sid === 'string' && sid.length > 0) serverId = sid;
        if (Array.isArray(names)) {
          toolNames = names.filter((n): n is string => typeof n === 'string' && n.length > 0);
        }
      }
    } catch {
      /* fall through */
    }
    if (!serverId || toolNames.length === 0) {
      await emitFailure(
        redis,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        startTime,
        'MCP_PROMOTE_INVALID_INPUT',
        'mcp.tool.promote requires { serverId: string, toolNames: string[] } (non-empty).',
        parentStepExecutionId,
      );
      return;
    }

    const spaceId = requireSpaceId(context);

    // Scope check (mirrors mcp.tool.discover) — binding-aware.
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
        `MCP server "${serverId}" is not in this agent's scope.`,
        parentStepExecutionId,
      );
      return;
    }

    const broadEntry = serverEntries.find((e) => !e.bindingId);
    const pinnedBindingIds = new Set(
      serverEntries.filter((e) => e.bindingId).map((e) => e.bindingId!),
    );
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

    // Load definition + bindings.
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
          enabled: mcpServerBindings.enabled,
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

    const candidates: BindingCandidate[] = bindingRows
      .map((b): BindingCandidate => {
        const scopeJson = (b.scopeJson ?? {}) as Record<string, unknown>;
        const flowId = typeof scopeJson['flowId'] === 'string' ? scopeJson['flowId'] : undefined;
        return {
          bindingId: b.bindingId,
          serverId: b.serverId,
          spaceId: b.spaceId,
          authJson: b.authJson,
          cachedTools: b.cachedTools,
          enabled: ((b.enabled as number | undefined) ?? 1) === 1,
          scope: {
            tenantId: (scopeJson['tenantId'] as string | undefined) ?? (context.tenantId as string),
            spaceId: b.spaceId,
            ...(flowId ? { flowId } : {}),
          },
        };
      })
      .filter((b) => b.scope.tenantId === context.tenantId && b.spaceId === spaceId && b.enabled);

    // Narrow candidates to the grant's pinned bindings when no broad surface exists.
    let scopedCandidates = candidates;
    if (!broadEntry && pinnedBindingIds.size > 0) {
      scopedCandidates = candidates.filter((b) => pinnedBindingIds.has(b.bindingId));
    }

    const flowIdForScope = context.agentDefinition.flowId as string | undefined;
    const binding = resolveBindingByScope<BindingCandidate>(scopedCandidates, {
      tenantId: context.tenantId as string,
      spaceId,
      ...(flowIdForScope ? { flowId: flowIdForScope } : {}),
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
        `No enabled MCP binding for server "${serverId}" in space "${spaceId}".`,
        parentStepExecutionId,
      );
      return;
    }

    const cachedTools = Array.isArray(binding.cachedTools)
      ? (binding.cachedTools as McpCachedTool[])
      : [];
    const cachedByName = new Map<string, McpCachedTool>(cachedTools.map((t) => [t.name, t]));

    const defJson = (defRow.definitionJson ?? {}) as Record<string, unknown>;
    const toolFilter = defJson['toolFilter'] as McpToolFilter | undefined;
    const aclSurvivors = new Set(applyToolFilter(cachedTools, toolFilter).map((t) => t.name));
    const opTaskOnlySet = new Set(toolFilter?.opTaskOnly ?? []);

    const promoted: string[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    const promotedSpecs: AgentToolSpec[] = [];

    for (const name of toolNames) {
      const tool = cachedByName.get(name);
      if (!tool) {
        rejected.push({
          name,
          reason: `not_in_cache: tool "${name}" not found in binding.cachedTools — call mcp.tool.discover first.`,
        });
        continue;
      }
      if (!aclSurvivors.has(name)) {
        rejected.push({
          name,
          reason: `blocked_by_acl: tool "${name}" blocked by definition.toolFilter.`,
        });
        continue;
      }
      if (grantedToolNames && !grantedToolNames.has(name)) {
        rejected.push({
          name,
          reason: `not_in_grant: tool "${name}" is not in the task's MCP capability grant tools[].`,
        });
        continue;
      }
      const spec = mapMcpToolToToolSpec(
        serverId,
        defRow.name,
        tool,
        opTaskOnlySet.has(name),
        binding.bindingId,
      );
      promotedSpecs.push(spec);
      promoted.push(name);
    }

    // Write promoted tools to runtime state.
    if (promotedSpecs.length > 0) {
      const runtimeState = sessionState?.runtimeState;
      if (runtimeState) {
        const vtKey = 'ai.agent._virtualTools';
        const currentVt = readInlineVar(
          runtimeState,
          vtKey,
          {} as Record<string, VirtualToolEntry>,
        );
        const turnKey = Object.keys(runtimeState.variables).find((k) =>
          k.startsWith('ai.agent.turnNumber.'),
        );
        const turnNumber = turnKey ? readInlineVar(runtimeState, turnKey, 0) : 0;

        const newVt = { ...currentVt };
        for (const spec of promotedSpecs) {
          if (!newVt[spec.toolId]) {
            newVt[spec.toolId] = { discoveredAtTurn: turnNumber };
          }
        }

        const newVars = { ...runtimeState.variables };
        writeInlineVar(newVars, vtKey, newVt, {
          nowMs: Date.now(),
          stepExecutionId,
          stepId: stepDef.stepId,
          version: Object.keys(newVt).length,
        });

        // Merge into _discoveredMcpToolSpecs (lowering reads this).
        const existingDiscovered = runtimeState.variables['ai.agent._discoveredMcpToolSpecs'] as
          { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
        const existing =
          existingDiscovered?.ref?.kind === 'inline' && Array.isArray(existingDiscovered.ref.value)
            ? (existingDiscovered.ref.value as AgentToolSpec[])
            : [];
        const existingIds = new Set(existing.map((s) => s.toolId));
        const merged = [...existing, ...promotedSpecs.filter((s) => !existingIds.has(s.toolId))];
        newVars['ai.agent._discoveredMcpToolSpecs'] = {
          ref: { kind: 'inline', value: merged },
          cachedAtMs: Date.now(),
        };

        await updateSessionState(redis, context.tenantId, context.runId, {
          runtimeState: {
            ...runtimeState,
            variables: newVars,
            version: runtimeState.version + 1,
          },
        });
      }
    }

    const outputData = { serverId, bindingId: binding.bindingId, promoted, rejected };
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
      `[mcp.tool.promote] server=${serverId} binding=${binding.bindingId} promoted=${String(promoted.length)} rejected=${String(rejected.length)}`,
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
      'MCP_PROMOTE_FAILED',
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
