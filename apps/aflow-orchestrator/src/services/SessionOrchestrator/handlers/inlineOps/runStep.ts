import type { Redis } from 'ioredis';
import { logOrchestratorError } from '../../../../lib/orchestratorLogger.js';
import type {
  StepExecutionId,
  OperationId,
  StepId,
  StepType,
  StepDefinition,
  IdempotencyKey,
} from '@aflow/schemas';
import {
  getOperation,
  normalizeAgentInput,
  toJsonSchemaSync,
  suggestOperations,
} from '@aflow/schemas';
import { addStepResult, getSessionState, updateSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { FlowExecutionContext } from '../../types.js';
import {
  DISCOVERY_SCOPE_VAR,
  TOOL_SURFACE_VAR,
  type DiscoveryScope,
} from '../../helpers/agentTurn.js';
import { checkPlatformOpScope } from './catalogToolPromote.js';

/**
 * Handle agent.control.run_step inline: read the requested stepType/operation/inputs,
 * inject a dynamic step definition into the in-memory flow, and schedule the real
 * operation to its executor. The dynamic step's onSuccess/onFailure wire back to
 * the run_step step's original successors.
 *
 * Flow: run_step(SUCCESS) -> applyResult routes to dynamicStep -> executor -> result -> applyResult -> agent
 */
export async function handleRunStepInline(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  runStepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  _scheduledAtMs: number,
  parentStepExecutionId?: StepExecutionId,
): Promise<void> {
  const startTime = Date.now();
  try {
    // Read the resolved input to get the dynamic step parameters
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      throw new Error('Failed to read run_step input payload');
    }

    const rawOperationId = input['operationId'] as string | undefined;
    // Agents sometimes pass "parameters" instead of "inputs" — accept both
    const rawInputs = (input['inputs'] ?? input['parameters']) as
      Record<string, unknown> | undefined;
    const targetInputs: Record<string, unknown> =
      rawInputs && typeof rawInputs === 'object' ? { ...rawInputs } : {};

    const displayOutput = runStepDef.outputOptions?.displayToUser === true;

    if (!rawOperationId) {
      throw new Error(
        'agent.control.run_step requires "operationId" — the fully-qualified operation ID ' +
          '(e.g., "ai.text.generate", "agent.manage.get"). ' +
          'Use get_schema to discover available operations.',
      );
    }

    // Ceiling enforcement — the model's decision cannot execute what its turn
    // was never handed. Two cases:
    //  - Synthetic virtual-tool steps (tag `virtual_tool`, lowered from an
    //    agent tool call): the invoked toolId must be a member of the turn's
    //    persisted tool surface. Without this, any toolId the model emits —
    //    hallucinated, JSON-fallback-repaired, or adversarial — would execute
    //    as an operation despite never being a tool.
    //  - Authored graph run_step steps (the classic discovery pattern, where
    //    discovered ops run without promotion): the session's discovery scope
    //    is the authority, fail-closed when absent.
    {
      const isSyntheticVirtualTool = runStepDef.tags.includes('virtual_tool');
      const sessionState = await getSessionState(redis, context.tenantId, context.runId);
      const stateVars = sessionState?.runtimeState?.variables;

      if (isSyntheticVirtualTool) {
        const parentAgentStepId = runStepDef.tags
          .find((t) => t.startsWith('parent:'))
          ?.slice('parent:'.length);
        const invokedToolId =
          runStepDef.tags.find((t) => t.startsWith('_toolId:'))?.slice('_toolId:'.length) ??
          rawOperationId;
        const surfaceEntry = stateVars?.[`${TOOL_SURFACE_VAR}.${parentAgentStepId ?? ''}`] as
          { ref?: { kind: string; value?: unknown } } | undefined;
        const surface =
          surfaceEntry?.ref?.kind === 'inline' && Array.isArray(surfaceEntry.ref.value)
            ? (surfaceEntry.ref.value as unknown[]).filter(
                (t): t is string => typeof t === 'string',
              )
            : undefined;
        if (!surface?.includes(invokedToolId)) {
          throw new Error(
            `TOOL_NOT_ON_SURFACE: "${invokedToolId}" is not one of the tools available to you ` +
              'this turn. Call only the tools listed in your function definitions. If the ' +
              'operation appears in your promotable catalog, add it first with ' +
              'catalog.tool.promote, then call it on the next turn.',
          );
        }
      } else {
        // Authored (non-lowered) run_step. Two shapes reach here:
        //  - an agent's discovery run_step (the classic `flowcontrol-1` graph
        //    tool that runs a DISCOVERED op) — the agent's discovery scope
        //    bounds which ops it may invoke this way;
        //  - a DIRECT operation execution with no agent discovery at all —
        //    the mcp-runner running a configured `operationId`, a single-op
        //    run, a scheduled op, etc. These carry no discovery scope, and the
        //    space capability profile (enforced at scheduleStep) is their
        //    authority — discovery must NOT gate them.
        // So the scope clamp applies ONLY when a scope is present; absent
        // scope falls through to the profile. (The agent virtual-tool
        // escalation vector is closed separately by the surface check above.)
        const scopeEntry = stateVars?.[DISCOVERY_SCOPE_VAR] as
          { ref?: { kind: string; value?: unknown } } | undefined;
        const discoveryScope =
          scopeEntry?.ref?.kind === 'inline' &&
          typeof scopeEntry.ref.value === 'object' &&
          scopeEntry.ref.value !== null
            ? (scopeEntry.ref.value as DiscoveryScope)
            : undefined;
        if (discoveryScope) {
          const scopeReason = checkPlatformOpScope(rawOperationId, discoveryScope);
          if (scopeReason) {
            throw new Error(
              `OPERATION_OUT_OF_SCOPE: run_step cannot execute "${rawOperationId}" — ${scopeReason}. ` +
                'run_step is limited to operations within your discovery scope.',
            );
          }
        }
      }
    }

    const resolvedOperation = rawOperationId;
    const opDescriptor = getOperation(resolvedOperation);
    if (!opDescriptor) {
      const suggestions = suggestOperations(resolvedOperation);
      const hint =
        suggestions.length > 0
          ? `\nDid you mean: ${suggestions.join(', ')}?`
          : '\nUse catalog.tool.search to discover available operations.';
      throw new Error(`Unknown operation: "${resolvedOperation}".${hint}`);
    }

    // Block internal-only operations (these are excluded from the agent catalog entirely)
    if (opDescriptor.internal && !context.agentDefinition.metadata.system) {
      throw new Error(
        `Operation "${resolvedOperation}" is internal and can only be invoked from system flows (metadata.system: true).`,
      );
    }

    if (!opDescriptor.agentTool && !context.agentDefinition.metadata.system) {
      const alt = opDescriptor.agentAlternative
        ? ` ${opDescriptor.agentAlternative}`
        : ' Use catalog.tool.search to discover available operations.';
      throw new Error(`Operation "${resolvedOperation}" is not available as an agent tool.${alt}`);
    }

    let normalizedInputs = targetInputs;
    try {
      const jsonSchema = toJsonSchemaSync(opDescriptor.inputZod) as Record<string, unknown>;
      normalizedInputs = normalizeAgentInput(targetInputs, jsonSchema);
    } catch {
      // Best-effort — proceed with original inputs if normalization fails
    }

    const targetStepTypeResolved = opDescriptor.stepType;

    // Generate a unique stepId for the dynamic step
    const dynamicStepId =
      `dynamic_${resolvedOperation.replace(/\./g, '_')}_${crypto.randomUUID().slice(0, 8)}` as StepId;

    // Per-execution routing: each dynamic step is tagged with its parent
    // stepExecutionId so applyStepSucceeded can route each run_step SUCCESS
    // to the correct dynamic step. This avoids the shared-mutation bug where
    // parallel invoke_steps calls all patch runStepDef.onSuccess and the last
    // writer wins (routing ALL results to a single dynamic step).
    const dynamicStepDef: StepDefinition = {
      stepId: dynamicStepId,
      stepType: targetStepTypeResolved as StepType,
      operation: resolvedOperation as OperationId,
      name: `↪ ${opDescriptor.name}`,
      description: `Dynamically executed via agent.control.run_step: ${opDescriptor.semanticDescription}`,
      config: {},
      tags: [
        'dynamic',
        'run_step',
        `parent:${runStepDef.stepId}`,
        `_routing:${stepExecutionId}`,
        ...runStepDef.tags.filter((t) => t.startsWith('_toolId:') || t.startsWith('_toolCallId:')),
      ],
      optional: false,
      onSuccess: runStepDef.onSuccess,
      onFailure: runStepDef.onFailure,
      ...(runStepDef.outputMapping ? { outputMapping: runStepDef.outputMapping } : {}),
      ...(displayOutput ? { outputOptions: { displayToUser: true } } : {}),
    };

    // Inject the dynamic step into the in-memory flow definition
    context.agentDefinition.steps.push(dynamicStepDef);

    // Persist the dynamic step to Redis BEFORE emitting the SUCCESS result.
    // The result consumer re-fetches agentDef from Postgres and merges dynamic
    // steps from Redis. If the SUCCESS result is processed before the dynamic
    // step is persisted, the routing target won't be found and the run will
    // complete prematurely (nextStepId=null → isTerminal=true).
    try {
      const existingState = await getSessionState(redis, context.tenantId, context.runId);
      const existingDynamic: StepDefinition[] = existingState?.dynamicSteps
        ? (JSON.parse(existingState.dynamicSteps) as StepDefinition[])
        : [];
      existingDynamic.push(dynamicStepDef);
      await updateSessionState(redis, context.tenantId, context.runId, {
        dynamicSteps: JSON.stringify(existingDynamic),
      });
    } catch (persistErr) {
      logOrchestratorError(
        `[SessionOrchestrator] Failed to persist dynamic step to Redis:`,
        persistErr,
        {
          tenantId: context.tenantId,
          sessionId: context.runId,
          dynamicStepId,
        },
      );
    }

    // Emit a synthetic SUCCESS result for the run_step step itself.
    // The output is targetInputs so they flow into the dynamic step as raw input
    // (the dynamic step has no ${...} refs in config, so resolveStepInput merges
    // raw input on top of config).
    const runStepOutputRef = `inline:${Buffer.from(JSON.stringify(normalizedInputs)).toString('base64')}`;

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: runStepDef.stepId,
      stepType: 'agent' as StepType,
      operationId: 'agent.control.run_step' as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef: runStepOutputRef,
      resolvedInputRef: resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  } catch (err) {
    // Emit failure result for the run_step step
    const errorData = {
      code: 'RUN_STEP_FAILED',
      message: err instanceof Error ? err.message : String(err),
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
      stepId: runStepDef.stepId,
      stepType: 'agent' as StepType,
      operationId: 'agent.control.run_step' as OperationId,
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
