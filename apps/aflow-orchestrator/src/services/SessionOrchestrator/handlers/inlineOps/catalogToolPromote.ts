import type { Redis } from 'ioredis';
import type {
  AgentToolSpec,
  IdempotencyKey,
  IntegrationDescriptor,
  OperationId,
  RunAccessGrant,
  StepDefinition,
  StepExecutionId,
} from '@aflow/schemas';
import type { IntegrationToolDiagnostic } from '../../helpers/integrationReader.js';
import {
  SPACE_POLICY_OPERATION_PREFIXES,
  SPACE_POLICY_RUNS_WHEN_UNSET,
  buildGroupId,
  grantDecisionForOperation,
  buildVirtualToolSpec,
  getOperation,
  parseIntegrationToolId,
  processEditionDescriptor,
  uncomposedOperationReason,
} from '@aflow/schemas';
import {
  addStepResult,
  getRunAccessGrant,
  getSessionState,
  updateSessionState,
} from '@aflow/redis';
import { encodeInlineOpOutputRef } from './helpers.js';
import {
  createTenantContext,
  getDatabase,
  listCustomAgentsInSpace,
  listPlatformRoles,
  withTenantSchema,
} from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { FlowExecutionContext } from '../../types.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import { readInlineVar, writeInlineVar } from '../../helpers/runtimeState.js';
import {
  DISCOVERY_SCOPE_VAR,
  MAX_VIRTUAL_TOOLS,
  type DiscoveryScope,
  type VirtualToolEntry,
} from '../../helpers/agentTurn.js';
import { requireSpaceId } from './spaceScope.js';
import { loweredOperationForToolId } from '../../helpers/toolAccess.js';
import {
  resolveSpacePolicyStates,
  type SpacePolicyState,
} from '../../helpers/spacePolicyCapabilities.js';
import { readIntegrations } from '../../helpers/integrationReader.js';

interface PromoteRejection {
  toolId: string;
  reason: string;
}

export async function handleCatalogToolPromoteInline(
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
  const logger = getOrchestratorLogger();

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input → caught by the validation below */
    }

    const rawToolIds = input['toolIds'];
    if (!Array.isArray(rawToolIds) || rawToolIds.length === 0) {
      await emitFailure(
        redis,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        startTime,
        'CATALOG_PROMOTE_INVALID_INPUT',
        'catalog.tool.promote requires { toolIds: string[] } (non-empty).',
        parentStepExecutionId,
      );
      return;
    }
    const toolIds = rawToolIds.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (toolIds.length === 0) {
      await emitFailure(
        redis,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        startTime,
        'CATALOG_PROMOTE_INVALID_INPUT',
        'catalog.tool.promote toolIds must contain at least one non-empty string.',
        parentStepExecutionId,
      );
      return;
    }

    const spaceId = requireSpaceId(context);

    // Read discovery scope once — used to enforce policy at promotion time
    // (lowering re-checks at call time as defense in depth).
    const sessionState = await getSessionState(redis, context.tenantId, context.runId);
    const runtimeState = sessionState?.runtimeState;
    const scopeEntry = runtimeState?.variables[DISCOVERY_SCOPE_VAR] as
      { ref?: { kind: string; value?: unknown } } | undefined;
    const discoveryScope: DiscoveryScope | undefined =
      scopeEntry?.ref?.kind === 'inline' &&
      typeof scopeEntry.ref.value === 'object' &&
      scopeEntry.ref.value !== null
        ? (scopeEntry.ref.value as DiscoveryScope)
        : undefined;

    // Partition input toolIds into platform / agent / integration buckets.
    const platformOpIds: string[] = [];
    const agentToolIds: string[] = [];
    const integrationToolIds: string[] = [];
    const malformed: PromoteRejection[] = [];
    for (const toolId of toolIds) {
      if (toolId.startsWith('agent:')) {
        const agentId = toolId.slice('agent:'.length);
        if (!agentId) {
          malformed.push({
            toolId,
            reason: `malformed: agent toolId must be "agent:{agentId}"`,
          });
          continue;
        }
        agentToolIds.push(toolId);
      } else if (toolId.startsWith('api:') || toolId.startsWith('mcp:')) {
        const parsed = parseIntegrationToolId(toolId);
        if (!parsed) {
          malformed.push({
            toolId,
            reason: `malformed: integration toolId must be "api:{bindingId}/{toolName}" or "mcp:{bindingId}/{toolName}"`,
          });
          continue;
        }
        integrationToolIds.push(toolId);
      } else {
        platformOpIds.push(toolId);
      }
    }

    // The same grant the surface filters against, read once for every kind:
    // each of them lowers to an operation the surface will check.
    const runGrant = await getRunAccessGrant(redis, context.tenantId, context.runId);

    const promoted: string[] = [];
    const rejected: PromoteRejection[] = [...malformed];

    // Agent and integration tools dispatch something other than themselves —
    // `agent.control.delegate`, `api.http.call`, `mcp.tool.call` — and the
    // surface filters on that lowered operation. Checking only the platform
    // branch would leave the other two promoting successfully into the same
    // silent drop this check exists to end.
    for (const list of [agentToolIds, integrationToolIds]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const toolId = list[i]!;
        const lowered = loweredOperationForToolId(toolId);
        if (lowered === null) continue;
        const reason = checkGrantAdmitsOp(lowered, runGrant);
        if (reason) {
          rejected.push({ toolId, reason });
          list.splice(i, 1);
        }
      }
    }
    const promotedSpecsApi: AgentToolSpec[] = [];
    const promotedSpecsMcp: AgentToolSpec[] = [];

    // ── Platform operations ──
    // Only when the batch holds an operation a space policy can gate. Promoting
    // memory or AI tools reached no database before this and should not start
    // now — nor inherit a failure mode from a read whose answer could not
    // change theirs.
    const needsPolicy = platformOpIds.some((opId) => {
      const stepType = getOperation(opId)?.stepType;
      return stepType !== undefined && SPACE_POLICY_OPERATION_PREFIXES.has(stepType);
    });
    const policyStates = needsPolicy
      ? await withTenantSchema(getDatabase(), createTenantContext(context.tenantId), async (tx) =>
          resolveSpacePolicyStates(tx, spaceId),
        )
      : new Map<string, SpacePolicyState>();

    for (const opId of platformOpIds) {
      const reason =
        // Ahead of every other gate: the others answer what an operator permits
        // of a capability that exists, this one whether the deployment carries
        // a lane able to serve it at all.
        uncomposedOperationReason(opId, processEditionDescriptor()) ??
        checkPlatformOpScope(opId, discoveryScope) ??
        checkSpacePolicyForOp(opId, policyStates) ??
        checkGrantAdmitsOp(opId, runGrant);
      if (reason) {
        rejected.push({ toolId: opId, reason });
        continue;
      }
      promoted.push(opId);
    }

    if (agentToolIds.length > 0) {
      let visible: ReadonlySet<string> = new Set();
      if (discoveryScope?.allowedAgents !== false) {
        const db = getDatabase();
        const [platformRoles, customRows] = await Promise.all([
          Promise.resolve(listPlatformRoles()),
          listCustomAgentsInSpace(db, context.tenantId, spaceId),
        ]);
        visible = new Set<string>([
          ...platformRoles.map((e) => e.systemRole),
          ...customRows.map((r) => r.slug),
        ]);
      }
      for (const toolId of agentToolIds) {
        const agentHandle = toolId.slice('agent:'.length);
        const reason = checkAgentScope(agentHandle, discoveryScope, visible);
        if (reason) {
          rejected.push({ toolId, reason });
          continue;
        }
        promoted.push(toolId);
      }
    }

    // ── Integration tools ──
    if (integrationToolIds.length > 0) {
      const { tools, descriptors, toolDiagnostics } = await readIntegrations(
        context.tenantId,
        spaceId,
      );
      const byToolId = new Map(tools.map((t) => [t.toolId, t]));
      const diagByToolId = new Map(toolDiagnostics.map((d) => [d.toolId, d]));
      // API and MCP bindings live in separate tables and may share a bindingId —
      // key by (sourceKind, bindingId) so a collision cannot misattribute.
      const descriptorByBindingId = new Map(
        descriptors.filter((d) => d.bindingId).map((d) => [`${d.sourceKind}:${d.bindingId!}`, d]),
      );

      for (const toolId of integrationToolIds) {
        const desc = byToolId.get(toolId);
        if (!desc) {
          rejected.push({
            toolId,
            reason: explainUnavailableIntegrationTool(toolId, diagByToolId, descriptorByBindingId),
          });
          continue;
        }

        // Scope check — runner/specialist agents see allowlist-derived scope.
        // In `allowlist` mode this enforces binding + toolNames narrowing so a
        // task granted one tool cannot promote sibling tools or a different
        // binding under the same integration. In `bound` mode (Helmsman) the
        // operator's binding configuration is the policy, so per-tool checks
        // are intentionally skipped.
        const scopeReason = checkIntegrationScope(
          discoveryScope,
          desc.sourceKind,
          desc.integrationId,
          desc.bindingId,
          desc.toolName,
        );
        if (scopeReason) {
          rejected.push({ toolId, reason: scopeReason });
          continue;
        }

        const spec =
          desc.sourceKind === 'api'
            ? buildVirtualToolSpec({
                operationId: desc.toolId,
                stepType: 'api',
                name: desc.name,
                description: desc.description,
                inputSchema: desc.inputSchema,
                source: 'api',
                lowering: 'api_call',
                callName: desc.callName,
                apiMeta: {
                  apiId: desc.integrationId,
                  endpointId: desc.toolName,
                  bindingId: desc.bindingId,
                },
              })
            : buildVirtualToolSpec({
                operationId: desc.toolId,
                stepType: 'mcp',
                name: desc.name,
                description: desc.description,
                inputSchema: desc.inputSchema,
                source: 'mcp',
                lowering: 'mcp_call',
                callName: desc.callName,
                mcpMeta: {
                  serverId: desc.integrationId,
                  toolName: desc.toolName,
                  bindingId: desc.bindingId,
                },
              });
        if (desc.opTaskOnly) {
          spec.governance = { sideEffects: true, opTaskOnly: true };
        }

        if (desc.sourceKind === 'api') promotedSpecsApi.push(spec);
        else promotedSpecsMcp.push(spec);
        promoted.push(toolId);
      }
    }

    // ── Write to runtime state ──
    if (promoted.length > 0) {
      if (!runtimeState) {
        await emitFailure(
          redis,
          context,
          stepDef,
          stepExecutionId,
          idempotencyKey,
          resolvedInputRef,
          attempt,
          startTime,
          'CATALOG_PROMOTE_RUNTIME_STATE_MISSING',
          'catalog.tool.promote requires session runtime state to persist promotions. ' +
            'Try the call again from within an active agent turn.',
          parentStepExecutionId,
        );
        return;
      }
      const vtKey = 'ai.agent._virtualTools';
      const currentVt = readInlineVar(runtimeState, vtKey, {} as Record<string, VirtualToolEntry>);
      const turnKey = Object.keys(runtimeState.variables).find((k) =>
        k.startsWith('ai.agent.turnNumber.'),
      );
      const turnNumber = turnKey ? readInlineVar(runtimeState, turnKey, 0) : 0;

      const newVt = { ...currentVt };
      for (const p of promoted) {
        if (!newVt[p]) newVt[p] = { discoveredAtTurn: turnNumber };
      }

      const newVars = { ...runtimeState.variables };
      writeInlineVar(newVars, vtKey, newVt, {
        nowMs: Date.now(),
        stepExecutionId,
        stepId: stepDef.stepId,
        version: Object.keys(newVt).length,
      });

      if (promotedSpecsApi.length > 0) {
        mergeDiscoveredSpecs(newVars, 'ai.agent._discoveredApiToolSpecs', promotedSpecsApi);
      }
      if (promotedSpecsMcp.length > 0) {
        mergeDiscoveredSpecs(newVars, 'ai.agent._discoveredMcpToolSpecs', promotedSpecsMcp);
      }

      await updateSessionState(redis, context.tenantId, context.runId, {
        runtimeState: {
          ...runtimeState,
          variables: newVars,
          version: runtimeState.version + 1,
          updatedAtMs: Date.now(),
        },
      });
    }

    // Surface the cap to the agent when the merged _virtualTools set would
    // exceed MAX_VIRTUAL_TOOLS. Read time LRU-evicts the least-recently-used
    // entries; without this warning the agent thinks all promoted tools are
    // callable but only the 20 most-recently-used will land on the surface.
    // Plain platform-op promotes that contain ONLY core-pinned ops don't
    // bump the discovered count, so the warning fires only on actually
    // cap-affecting promotes.
    let capWarning: { capacity: number; total: number; evictionLikely: number } | undefined;
    if (promoted.length > 0 && runtimeState) {
      const vt =
        readInlineVar(
          runtimeState,
          'ai.agent._virtualTools',
          {} as Record<string, VirtualToolEntry>,
        ) ?? {};
      const merged = new Set<string>([...Object.keys(vt), ...promoted]);
      if (merged.size > MAX_VIRTUAL_TOOLS) {
        capWarning = {
          capacity: MAX_VIRTUAL_TOOLS,
          total: merged.size,
          evictionLikely: merged.size - MAX_VIRTUAL_TOOLS,
        };
      }
    }

    const outputData = {
      promoted,
      rejected,
      count: promoted.length,
      ...(capWarning ? { capWarning } : {}),
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

    const apiPromoted = promotedSpecsApi.length;
    const mcpPromoted = promotedSpecsMcp.length;
    // `promoted` holds toolIds from three sources: platform ops (bare
    // operation ids like `memory.store.put`), agent dispatches
    // (`agent:{agentId}`), and integration tools (`api:...` / `mcp_*.*`).
    // Counting by toolId prefix gives the four buckets separately so a run
    // that promotes both agents and platform ops doesn't over-report
    // platformPromoted (reviewer P2).
    const agentPromoted = promoted.filter((id) => id.startsWith('agent:')).length;
    const platformPromoted = promoted.length - apiPromoted - mcpPromoted - agentPromoted;
    // Rejection reasons are colon-prefixed (e.g. "not_in_grant: tool ...");
    // bucket by the leading token so the histogram is stable.
    const rejectionReasonCounts: Record<string, number> = {};
    for (const r of rejected) {
      const bucket = r.reason.split(':', 1)[0]?.trim() || 'unknown';
      rejectionReasonCounts[bucket] = (rejectionReasonCounts[bucket] ?? 0) + 1;
    }
    logger.info('[catalog.tool.promote] promotion outcome', {
      tenantId: context.tenantId,
      runId: context.runId,
      event: 'catalog.tool.promote.outcome',
      promotedTotal: promoted.length,
      apiPromoted,
      mcpPromoted,
      agentPromoted,
      platformPromoted,
      rejectedTotal: rejected.length,
      rejectionReasonCounts,
      // Cap detail list so a runaway promote payload doesn't bloat logs.
      sampleRejections: rejected.slice(0, 10).map((r) => ({ toolId: r.toolId, reason: r.reason })),
    });
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
      'CATALOG_PROMOTE_FAILED',
      `catalog.tool.promote failed: ${err instanceof Error ? err.message : String(err)}`,
      parentStepExecutionId,
    );
  }
}

/**
 * Explain why an integration toolId is absent from the promotable set — the
 * rejection reason must name the artifact and the missing thing so the agent's
 * next action is determined. Exported for unit tests.
 */
export function explainUnavailableIntegrationTool(
  toolId: string,
  diagnosticsByToolId: ReadonlyMap<string, IntegrationToolDiagnostic>,
  descriptorsByBindingId: ReadonlyMap<string, IntegrationDescriptor>,
): string {
  const diag = diagnosticsByToolId.get(toolId);
  if (diag) return `${diag.cause}: ${diag.detail}`;

  const parsed = parseIntegrationToolId(toolId);
  if (!parsed) {
    return 'malformed: integration toolId must be "api:{bindingId}/{toolName}" or "mcp:{bindingId}/{toolName}"';
  }
  const descriptor = descriptorsByBindingId.get(`${parsed.sourceKind}:${parsed.bindingId}`);
  if (!descriptor) {
    return (
      `unknown_binding: no ${parsed.sourceKind} binding "${parsed.bindingId}" exists in this ` +
      'space — list bindings with api.binding.list or integration.registry.list'
    );
  }
  return parsed.sourceKind === 'api'
    ? `unknown_endpoint: definition "${descriptor.integrationId}" has no endpoint ` +
        `"${parsed.toolName}" — read endpoint ids with api.definition.get`
    : `unknown_tool: MCP server "${descriptor.integrationId}" has no cached tool ` +
        `"${parsed.toolName}" — the cached tool list may be stale`;
}

/**
 * Authorize promotion of a discovered agent. Returns `null` on allow, or a
 * rejection reason string. Mirrors the gate `catalog.tool.search` applies to
 * agent discovery so the explicit-promotion path can't widen access.
 *
 * - `discovery.allowedAgents === false` blocks all agent promotion.
 * - `visibleAgentIds` is the space-scoped agent set (the same one
 *   `listAgentsWithPlatform` returns). Promoting an agent outside this set
 *   would create a phantom toolbox entry — reject as `unknown_agent`.
 */
export function checkAgentScope(
  agentId: string,
  scope: DiscoveryScope | undefined,
  visibleAgentIds: ReadonlySet<string>,
): string | null {
  // Fail closed on an entirely absent scope — same contract as platform ops
  // and integrations: no discovery scope means nothing is promotable.
  if (!scope) {
    return 'out_of_scope: no discovery scope configured — promotion disabled';
  }
  if (scope.allowedAgents === false) {
    return 'out_of_scope: agent discovery is disabled (allowedAgents=false)';
  }
  if (!visibleAgentIds.has(agentId)) {
    return `unknown_agent: agent "${agentId}" is not visible in this space`;
  }
  return null;
}

/**
 * Authorize promotion of a platform operation against the agent's discovery
 * scope. Mirrors the clamp `catalog.tool.search` applies to search results so
 * promoting a guessed/blind opId can never widen the agent's surface beyond
 * what discovery would have surfaced. Exported for unit tests.
 */
/**
 * Whether the space's operator has switched on what this operation needs.
 *
 * Separate from `checkPlatformOpScope` because it answers a different question
 * with a different authority: that one asks what this agent was scoped to
 * discover, this one asks what the workspace permits at all. Keeping them apart
 * is also what lets the call-time re-check in `run_step` clamp scope without
 * taking on a policy read the schedule path already performs.
 *
 * Enforced here so an agent hears "no" while it is asking, rather than
 * promoting a tool the space forbids and finding out when a call goes nowhere.
 */
export function checkSpacePolicyForOp(
  opId: string,
  policyStates: ReadonlyMap<string, SpacePolicyState>,
): string | null {
  const op = getOperation(opId);
  if (!op) return null;
  if (!SPACE_POLICY_OPERATION_PREFIXES.has(op.stepType)) return null;
  // Follow the executor rather than pick a reading. Where it runs an absent
  // policy, refusing here would withdraw a capability that still works — and
  // agent-created spaces carry no policy, so that is the common case. Where it
  // is fail-closed, allowing an absent one would admit work guaranteed to fail.
  const state = policyStates.get(op.stepType) ?? 'unset';
  if (state === 'enabled') return null;
  if (state === 'unset' && SPACE_POLICY_RUNS_WHEN_UNSET.has(op.stepType)) return null;
  return (
    `policy_disabled: "${opId}" needs ${op.stepType} enabled for this workspace. ` +
    `An operator turns it on in workspace settings; it cannot be promoted or called until they do.`
  );
}

/**
 * Whether the run's grant will let this operation onto the agent's surface.
 *
 * The surface filters every tool through `wouldGrantAllowOperation` on its way
 * out, so an operation the grant excludes is dropped after promotion has said
 * yes — silently, and again on every later turn. The agent re-discovers it,
 * promotes it again, and never learns why. Asking the same question here turns
 * that loop into an answer, and asking it with the *same* predicate is what
 * keeps the two from drifting apart again.
 *
 * The usual cause is the space's capability profile: `Personal Safe` carries no
 * `compute.sandbox`, so a workspace can have compute enabled and a sandbox
 * running and still withhold the tool.
 */
export function checkGrantAdmitsOp(opId: string, grant: RunAccessGrant | null): string | null {
  const decision = grantDecisionForOperation(grant, opId);
  if (decision.allowed) return null;
  // The enforcer's own reason, not a guess at it. A grant refuses for an
  // expired or read-only lease, an explicit deny, a risk modifier, a privileged
  // or task-only operation, as well as a capability group the profile omits —
  // and naming the wrong one sends an operator to a setting that cannot help.
  return `not_in_grant: ${decision.reason} It would be withheld from the tool surface even once promoted.`;
}

export function checkPlatformOpScope(
  opId: string,
  scope: DiscoveryScope | undefined,
): string | null {
  const op = getOperation(opId);
  if (!op) return `unknown_operation: "${opId}"`;
  // Fail closed: no discovery scope means discovery is not enabled for this
  // agent, so nothing is promotable. Every agent that legitimately discovers
  // (Helmsman, the goal-compiled builder agents) writes an explicit
  // discovery.allowedStepTypes scope; the absence of one is the Runner /
  // minimal-agent case, where promotion must never become an escalation path
  // (a task that self-granted catalog.tool.promote could otherwise promote any
  // op, e.g. compute). Plan 233.
  if (!scope) return `out_of_scope: no discovery scope configured — promotion disabled`;
  // Op-level scope is the sole authority when PRESENT — allowedStepTypes does
  // not widen it. This is how a task's promotable grant bounds promotion to
  // exactly the declared operations. A present-but-EMPTY list (`[]`) is the
  // operator turning discovery off: it denies everything and must NOT fall
  // through to allowedStepTypes.
  if (scope.allowedOperationIds) {
    if (!scope.allowedOperationIds.includes(opId)) {
      return `out_of_scope: "${opId}" is not in this agent's promotable operations`;
    }
  } else if (!scope.allowedStepTypes.includes(op.stepType)) {
    return `out_of_scope: step type "${op.stepType}" not in discovery scope`;
  }
  if (scope.excludeOperationIds?.includes(opId)) {
    return `excluded_by_scope: "${opId}"`;
  }
  if (scope.excludeGroupIds && scope.excludeGroupIds.length > 0) {
    const groupId = buildGroupId(op.stepType, op.group);
    if (scope.excludeGroupIds.includes(groupId)) {
      return `excluded_by_group: capability group "${groupId}" excluded`;
    }
  }
  return null;
}

export function checkIntegrationScope(
  scope: DiscoveryScope | undefined,
  sourceKind: 'api' | 'mcp',
  integrationId: string,
  bindingId: string,
  toolName: string,
): string | null {
  // Fail closed on an entirely absent scope — same contract as platform ops
  // and agents. Bound integrations and grants always produce a scope
  // (resolveDiscoveryScope derives entries from coreMcpServers + MCP grants;
  // integration grants set integrations.mode), so a legitimate promoter is
  // never scopeless.
  if (!scope) {
    return 'out_of_scope: no discovery scope configured — promotion disabled';
  }

  const integrations = scope.integrations;
  if (integrations) {
    if (integrations.mode === 'none') {
      return `out_of_scope: integration discovery is disabled (mode=none)`;
    }
    if (integrations.sourceKinds && !integrations.sourceKinds.includes(sourceKind)) {
      return `out_of_scope: sourceKind "${sourceKind}" not in this agent's integration scope`;
    }
    if (integrations.mode === 'allowlist') {
      const allowed = integrations.allowed ?? [];
      const matches = allowed.filter(
        (a) => a.sourceKind === sourceKind && a.integrationId === integrationId,
      );
      if (matches.length === 0) {
        return `not_in_grant: integration "${integrationId}" is not one this agent carries. Which integrations an agent carries is an operator choice made under Connections — a binding that exists, even one just created, stays unreachable until it is enabled there. Ask for that connection to be turned on rather than reporting the integration as missing or broken.`;
      }
      const bindingScoped = matches.filter((a) => a.bindingId !== undefined);
      const broad = matches.filter((a) => a.bindingId === undefined);
      const matchingBinding = bindingScoped.filter((a) => a.bindingId === bindingId);
      if (bindingScoped.length > 0 && matchingBinding.length === 0) {
        return `not_in_grant: binding "${bindingId}" not in this task's allowlist for "${integrationId}"`;
      }
      // Reviewer P2 — union tool-name grants across ALL matching entries
      // (binding-pinned matches when present, else broad). Picking only the
      // first entry would cause "discoverable but not promotable": the read
      // path unions, so catalog.tool.search can surface a tool that this
      // single-entry check rejects purely due to declaration order.
      const effective = matchingBinding.length > 0 ? matchingBinding : broad;
      const anyEntryAllowsAllTools = effective.some(
        (a) => a.toolNames === undefined || a.toolNames.length === 0,
      );
      if (!anyEntryAllowsAllTools) {
        const allowedToolNames = new Set(effective.flatMap((a) => a.toolNames ?? []));
        if (!allowedToolNames.has(toolName)) {
          return `not_in_grant: tool "${toolName}" not in this task's allowlist for "${integrationId}"`;
        }
      }
    }
    return null;
  }

  if (!scope.allowedStepTypes.includes(sourceKind)) {
    return `out_of_scope: step type "${sourceKind}" not in discovery scope`;
  }
  if (sourceKind === 'api') {
    const allowed = (scope as DiscoveryScope & { allowedApiIds?: string[] }).allowedApiIds;
    if (allowed && !allowed.includes(integrationId)) {
      return `out_of_scope: api "${integrationId}" not in discovery scope`;
    }
  } else {
    const allowed = scope.allowedMcpServerIds;
    if (allowed && !allowed.includes(integrationId)) {
      return `out_of_scope: mcp "${integrationId}" not in discovery scope`;
    }
  }
  return null;
}

function mergeDiscoveredSpecs(
  vars: Record<string, unknown>,
  key: string,
  newSpecs: AgentToolSpec[],
): void {
  const existing = vars[key] as
    { ref?: { kind: string; value?: unknown }; cachedAtMs?: number } | undefined;
  const prior =
    existing?.ref?.kind === 'inline' && Array.isArray(existing.ref.value)
      ? (existing.ref.value as AgentToolSpec[])
      : [];
  const seen = new Set(prior.map((s) => s.toolId));
  const merged = [...prior, ...newSpecs.filter((s) => !seen.has(s.toolId))];
  vars[key] = {
    ref: { kind: 'inline', value: merged },
    cachedAtMs: Date.now(),
  };
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
