import type {
  OperationId,
  SessionId,
  StepType,
  StepId,
  TraceId,
  IdempotencyKey,
  ActorContext,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import {
  ActorContextSchema,
  ADHOC_CAPSULE_KIND,
  ADHOC_ALWAYS_GRANTABLE,
  ADHOC_NEVER_GRANTABLE,
  isEvalPlaneOperation,
  resolveRoleModel,
  resolveRoleReasoning,
} from '@aflow/schemas';
import { loadSpaceDirectives } from '@aflow/cybernetic-runtime';
import { scheduleShardTimer } from '@aflow/redis';
import { encodeInlineOpOutputRef } from './helpers.js';
import {
  addStepResult,
  addControlMessage,
  setSessionState,
  appendSessionEvent,
  markSessionDirty,
  addWaitingChild,
  getSessionState,
  type SessionHotState,
  type SessionEvent,
} from '@aflow/redis';
import { getDatabase, loadAgentTargetDefinition } from '@aflow/database';
import {
  PersistentAgentTargetSchema,
  agentTargetKey,
  type PersistentAgentTarget,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { requireSpaceId } from './spaceScope.js';

/**
 * Every eval-plane operation a delegation config would put in reach of the
 * Runner: the runner_tools surface plus the capability grant's direct and
 * promotable operation tiers. Exported for unit tests.
 */
export function collectEvalPlaneGrants(subflowConfig: Record<string, unknown>): string[] {
  const granted = new Set<string>();
  const runnerTools = subflowConfig['runner_tools'];
  if (Array.isArray(runnerTools)) {
    for (const tool of runnerTools) {
      if (typeof tool === 'string') granted.add(tool);
    }
  }
  const capabilityGrants = subflowConfig['runner_capability_grants'] as
    { operations?: unknown; promotable?: { operations?: unknown } } | undefined;
  for (const tier of [capabilityGrants?.operations, capabilityGrants?.promotable?.operations]) {
    if (!Array.isArray(tier)) continue;
    for (const op of tier) {
      if (typeof op === 'string') granted.add(op);
    }
  }
  return [...granted].filter(isEvalPlaneOperation);
}

/**
 * Handle agent.control.delegate inline: start a child session for the specified
 * flowId.
 *
 * - wait=true (default): emits PAUSED — the parent run pauses until the child
 *   completes, then the orchestrator auto-resumes the parent with the child's output.
 * - wait=false: emits SUCCEEDED immediately with { childSessionId, status: 'RUNNING' }.
 */
export async function handleDelegateInline(args: InlineHandlerArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const startTime = Date.now();

  try {
    // Read resolved input
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    const rawTarget = input['target'] ?? stepDef.config['target'];
    if (rawTarget === undefined || rawTarget === null) {
      throw new Error(
        'agent.control.delegate requires "target" — a PersistentAgentTarget ' +
          '({ kind: "platform-role", systemRole: ... } or { kind: "custom-agent", agentId: <uuid> }).',
      );
    }
    const targetParse = PersistentAgentTargetSchema.safeParse(rawTarget);
    if (!targetParse.success) {
      throw new Error(
        `agent.control.delegate: invalid "target" — ${targetParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const delegationTarget: PersistentAgentTarget = targetParse.data;
    const targetKey = agentTargetKey(delegationTarget);

    const agentVersionInput =
      (input['agentVersion'] as string | undefined) ?? (input['flowVersion'] as string | undefined);
    const subflowInput = input['input'];
    const subflowConfig = input['config'] as Record<string, unknown> | undefined;
    const delegationContext = input['context'] as Record<string, unknown> | undefined;
    const outputSchemaOverride = input['outputSchema'] as Record<string, unknown> | undefined;
    const validatorRefsOverride = Array.isArray(input['validatorRefs'])
      ? input['validatorRefs'].filter((r): r is string => typeof r === 'string')
      : undefined;
    const displayMeta = input['displayMeta'] as
      { workflowSlug?: string; taskId?: string; taskName?: string } | undefined;
    const timeoutSeconds =
      (input['timeoutSeconds'] as number | undefined) ??
      (stepDef.config['timeoutSeconds'] as number | undefined);

    // Wait mode: true (default) | false (fire-and-forget) | 'until_pause' (supervised)
    const rawWait = input['wait'] ?? stepDef.config['wait'] ?? true;
    const waitMode =
      rawWait === 'until_pause' ? 'until_pause' : rawWait !== false ? 'true' : 'false';
    const waitForCompletion = waitMode !== 'false';

    // Agent role override: defaults to 'subagent' for delegation (autonomous, must-complete).
    // Parent can pass agentRole='assistant' for conversational delegation.
    const agentRoleOverride =
      (input['agentRole'] as 'assistant' | 'subagent' | undefined) ??
      (stepDef.config['agentRole'] as 'assistant' | 'subagent' | undefined) ??
      'subagent';

    // Inherit spaceId from context (enriched by scheduleStep)
    const spaceId = requireSpaceId(context);

    // Resolve agent version. Platform roles are always version '1';
    //    custom agents resolve from the agent_versions table.
    const db = getDatabase();
    let agentVersion: string;
    let resolvedAgentName: string | undefined;
    if (delegationTarget.kind === 'platform-role') {
      agentVersion = '1';
    } else {
      const resolved = await loadAgentTargetDefinition(
        db,
        context.tenantId,
        delegationTarget,
        agentVersionInput && agentVersionInput.length > 0 ? agentVersionInput : 'latest',
      );
      agentVersion = resolved.version;
      resolvedAgentName = resolved.definition.metadata.name;
    }

    // Generate child run identifiers
    const childSessionId = crypto.randomUUID() as SessionId;
    const childTraceId = crypto.randomUUID() as TraceId;
    const childIdempotencyKey = `subflow:${context.runId}:${stepExecutionId}` as IdempotencyKey;
    const now = Date.now();

    // Wrap in the standard envelope { input, config? } that startRun's
    const envelope: Record<string, unknown> = {};
    const isPlatformRole = (role: string): boolean =>
      delegationTarget.kind === 'platform-role' && delegationTarget.systemRole === role;
    const canSynthesizeObjectiveInput =
      isPlatformRole('cybernetic-coach') || stepDef.stepId === 'run-coach';
    if (subflowInput !== undefined) {
      envelope['input'] = subflowInput;
    } else if (
      canSynthesizeObjectiveInput &&
      delegationContext &&
      typeof delegationContext['objective'] === 'string' &&
      delegationContext['objective'].trim().length > 0
    ) {
      // Manual run-coach calls often pass only context.objective; map it to
      // the child primary input so ${state.prompt} is never empty.
      envelope['input'] = delegationContext['objective'];
    }
    if (subflowConfig) envelope['config'] = subflowConfig;

    const cyberneticModelKey: 'runner_model' | 'coach_model' | null = isPlatformRole(
      'cybernetic-runner',
    )
      ? 'runner_model'
      : isPlatformRole('cybernetic-coach')
        ? 'coach_model'
        : null;
    if (cyberneticModelKey && spaceId) {
      const inputObj =
        envelope['input'] && typeof envelope['input'] === 'object'
          ? (envelope['input'] as Record<string, unknown>)
          : undefined;
      const configObj =
        envelope['config'] && typeof envelope['config'] === 'object'
          ? (envelope['config'] as Record<string, unknown>)
          : undefined;
      const callerProvidedModel =
        configObj?.[cyberneticModelKey] !== undefined ||
        inputObj?.[cyberneticModelKey] !== undefined;
      if (!callerProvidedModel) {
        try {
          const directives = await loadSpaceDirectives(db, context.tenantId, spaceId);
          const role = cyberneticModelKey === 'runner_model' ? 'runner' : 'coach';
          const resolvedModel = resolveRoleModel(directives?.modelDefaults, role);
          const resolvedReasoning = resolveRoleReasoning(directives?.reasoningDefaults, role);
          const nextConfig: Record<string, unknown> = { ...(configObj ?? {}) };
          nextConfig[cyberneticModelKey] = resolvedModel;
          // Inject the role's reasoning override (when set) so the child agent
          // resolves `${state.<role>_reasoning_effort}` to a real value. When
          // the operator hasn't set one, leave it as the variable default
          // (null) — agentTurnModel skips the param so the catalog default applies.
          if (resolvedReasoning !== undefined) {
            const reasoningKey =
              cyberneticModelKey === 'runner_model'
                ? 'runner_reasoning_effort'
                : 'coach_reasoning_effort';
            nextConfig[reasoningKey] = resolvedReasoning;
          }
          envelope['config'] = nextConfig;
          getOrchestratorLogger().info(
            `[delegate] Injected ${cyberneticModelKey}=${resolvedModel}` +
              `${resolvedReasoning !== undefined ? ` reasoning=${resolvedReasoning}` : ''} ` +
              `for ${targetKey} (spaceId=${spaceId})`,
          );
        } catch (modelErr) {
          getOrchestratorLogger().warn(
            `[delegate] Failed to resolve ${cyberneticModelKey} from space directives ` +
              `for ${targetKey}; falling back to agent default. Error: ${
                modelErr instanceof Error ? modelErr.message : String(modelErr)
              }`,
          );
        }
      }
    }

    const inputRef = `inline:${Buffer.from(JSON.stringify(envelope)).toString('base64')}`;

    // 1) Retrieve parent's actorContext for propagation to child run.
    const parentState = await getSessionState(redis, context.tenantId, context.runId);
    let parentActorContext: ActorContext | undefined;
    if (parentState?.actorContextJson) {
      try {
        parentActorContext = ActorContextSchema.parse(JSON.parse(parentState.actorContextJson));
      } catch {
        /* best-effort — if parent has no valid actorContext, child runs without grant */
      }
    }

    // Depth check: prevent unbounded delegation nesting
    const parentDepth = parentState?.delegationDepth ?? 0;
    const maxDepth = (stepDef.config['maxDelegationDepth'] as number | undefined) ?? 3;
    if (parentDepth >= maxDepth) {
      throw new Error(
        `Delegation depth limit exceeded (current depth: ${String(parentDepth)}, max: ${String(maxDepth)}). ` +
          `The sub-agent nesting is too deep. Simplify the delegation chain or increase maxDelegationDepth.`,
      );
    }

    // Parallel check: prevent too many concurrent children
    const currentChildren = parentState?.waitingForChildSessionIds?.length ?? 0;
    const maxParallel = (stepDef.config['maxParallelDelegates'] as number | undefined) ?? 5;
    if (waitForCompletion && currentChildren >= maxParallel) {
      throw new Error(
        `Parallel delegation limit exceeded (active children: ${String(currentChildren)}, max: ${String(maxParallel)}). ` +
          `Wait for existing delegations to complete before starting new ones.`,
      );
    }

    // Plan 269 D7 — the subject must not see the ruler: no delegated Runner,
    // capsule or otherwise, may be granted an eval.* tool. The grant rides two
    // channels — runner_tools (the default surface) and the capability grant's
    // operations/promotable tiers (promotable ops become live tools via
    // catalog.tool.promote) — so all of them are scanned.
    if (subflowConfig) {
      const evalPlane = collectEvalPlaneGrants(subflowConfig);
      if (evalPlane.length > 0) {
        throw new Error(
          `Runners can never be granted eval-plane operations — golden datasets grade skill runs, ` +
            `and the subject under measurement must not see the ruler: [${evalPlane.join(', ')}].`,
        );
      }
    }

    if (delegationContext?.['kind'] === ADHOC_CAPSULE_KIND && subflowConfig) {
      const runnerTools = subflowConfig['runner_tools'];
      if (Array.isArray(runnerTools)) {
        const alwaysGrantable = new Set<string>(ADHOC_ALWAYS_GRANTABLE);
        const neverGrantable = new Set<string>(ADHOC_NEVER_GRANTABLE);
        const rejected: string[] = [];
        for (const tool of runnerTools) {
          if (typeof tool !== 'string') continue;
          if (neverGrantable.has(tool)) {
            rejected.push(tool);
          } else if (!alwaysGrantable.has(tool)) {
            // Policy-gated operations are allowed through for now —
            // full space-level policy enforcement comes in Phase 5.
            // This check blocks only the hard-denied operations.
          }
        }
        if (rejected.length > 0) {
          throw new Error(
            `Ad-hoc capsule grant policy violation: the following operations require a formal skill ` +
              `and cannot be granted ad-hoc: [${rejected.join(', ')}]. ` +
              `Create a skill via compose-skill instead.`,
          );
        }
      }
    }

    // A child is attended while its parent is, as the parent is now — not as it
    // was at its own start, and never as the delegation's input says.
    const activatedByPerson = parentState?.activatedByPerson === true;

    // 2) Write QUEUED hot state for child session
    const queuedState: SessionHotState = {
      sessionId: childSessionId,
      tenantId: context.tenantId,
      target: delegationTarget,
      agentVersion,
      status: 'QUEUED',
      createdAt: now,
      startedAt: now,
      inputRef,
      traceId: childTraceId,
      idempotencyKey: childIdempotencyKey,
      lastUpdatedAt: now,
      // Inherit space + createdBy from parent (createdBy is needed for BYOK credential resolution)
      ...(spaceId ? { spaceId } : {}),
      ...(parentState?.createdBy ? { createdBy: parentState.createdBy } : {}),
      // Propagate actorContext so child run has it for nested subflows
      ...(parentState?.actorContextJson ? { actorContextJson: parentState.actorContextJson } : {}),
      activatedByPerson,
      // Subflow linkage: store parent info so the orchestrator can resume
      ...(waitForCompletion
        ? {
            parentSessionId: context.runId,
            parentStepExecutionId: stepExecutionId,
          }
        : {}),
      // Agent role override: applied by the orchestrator when building agent turn input
      agentRoleOverride: agentRoleOverride,
      delegationDepth: parentDepth + 1,
      ...(delegationContext ? { delegationContextJson: JSON.stringify(delegationContext) } : {}),
      ...(outputSchemaOverride
        ? { finalOutputSchemaOverrideJson: JSON.stringify(outputSchemaOverride) }
        : {}),
      ...(validatorRefsOverride && validatorRefsOverride.length > 0
        ? { finalOutputValidatorRefs: validatorRefsOverride }
        : {}),
      // Display-only metadata for chat UI badge / activity bubble.
      ...(displayMeta?.workflowSlug
        ? { delegationDisplayWorkflowSlug: displayMeta.workflowSlug }
        : {}),
      ...(displayMeta?.taskId ? { delegationDisplayTaskId: displayMeta.taskId } : {}),
      ...(displayMeta?.taskName ? { delegationDisplayTaskName: displayMeta.taskName } : {}),
      ...(resolvedAgentName ? { delegationDisplayAgentName: resolvedAgentName } : {}),
    };
    await setSessionState(redis, queuedState);

    // 3) Emit SessionQueued event
    const queuedEvent: SessionEvent = {
      eventId: crypto.randomUUID(),
      eventType: 'SessionQueued',
      timestamp: now,
      sessionId: childSessionId,
      metadata: {
        target: delegationTarget,
        agentVersion,
        parentSessionId: context.runId,
        parentStepExecutionId: stepExecutionId,
      },
    };
    await appendSessionEvent(redis, context.tenantId, childSessionId, queuedEvent);

    // 4) Mark child run dirty for eventual DB flush
    await markSessionDirty(redis, context.tenantId, childSessionId);

    // 5) Enqueue control message to start the child session (with parent's actorContext)
    await addControlMessage(redis, {
      messageVersion: 1,
      type: 'start_run',
      tenantId: context.tenantId,
      runId: childSessionId,
      target: delegationTarget,
      agentVersion,
      inputRef,
      traceId: childTraceId,
      idempotencyKey: childIdempotencyKey,
      requestedAtMs: now,
      ...(spaceId ? { spaceId } : {}),
      ...(parentState?.createdBy ? { createdBy: parentState.createdBy } : {}),
      ...(parentActorContext ? { actorContext: parentActorContext } : {}),
      activatedByPerson,
    });

    if (waitForCompletion) {
      await addWaitingChild(
        redis,
        context.tenantId,
        context.runId,
        stepExecutionId,
        childSessionId,
      );
      const { enterChildWait } = await import('../../helpers/delegationState.js');
      await enterChildWait(redis, context.tenantId, context.runId, { waitMode });
    }

    getOrchestratorLogger().debug(
      `[SessionOrchestrator] agent.control.delegate: started child session ${childSessionId} ` +
        `for ${targetKey}@${agentVersion} (wait=${String(waitForCompletion)})`,
    );

    if (waitForCompletion) {
      // Emit PAUSED — the parent run pauses until the child completes.
      // When the child run reaches terminal state, the orchestrator checks for
      // parentRunId and auto-resumes this step with the child's output.
      const outputData = {
        childSessionId,
        status: 'RUNNING' as const,
        waiting: true,
      };
      const outputRef = `inline:${Buffer.from(JSON.stringify(outputData)).toString('base64')}`;

      await addStepResult(redis, {
        messageVersion: 1,
        tenantId: context.tenantId,
        sessionId: context.runId,
        stepExecutionId,
        parentStepExecutionId: parentStepExecutionId ?? null,
        stepId: stepDef.stepId,
        stepType: 'agent' as StepType,
        operationId: 'agent.control.delegate' as OperationId,
        attempt,
        idempotencyKey,
        status: 'PAUSED',
        outputRef,
        resolvedInputRef,
        durationMs: Date.now() - startTime,
        traceId: context.traceId,
        finishedAtMs: Date.now(),
      });

      if (timeoutSeconds) {
        await scheduleShardTimer(redis, {
          tenantId: context.tenantId,
          sessionId: context.runId, // parent session — timeout acts on parent
          stepExecutionId,
          stepId: stepDef.stepId as StepId,
          operationId: 'agent.control.delegate' as OperationId,
          stepType: 'agent' as StepType,
          reason: 'timeout',
          attempt,
          inputRef: resolvedInputRef,
          traceId: context.traceId,
          dueAtMs: Date.now() + timeoutSeconds * 1000,
        });
      }
    } else {
      // Fire-and-forget: parent continues immediately
      const outputData = {
        childSessionId,
        status: 'RUNNING' as const,
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
        stepType: 'agent' as StepType,
        operationId: 'agent.control.delegate' as OperationId,
        attempt,
        idempotencyKey,
        status: 'SUCCEEDED',
        outputRef,
        resolvedInputRef,
        durationMs: Date.now() - startTime,
        traceId: context.traceId,
        finishedAtMs: Date.now(),
      });
    }
  } catch (err) {
    const errorData = {
      code: 'RUN_SUBFLOW_FAILED',
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
      stepId: stepDef.stepId,
      stepType: 'agent' as StepType,
      operationId: 'agent.control.delegate' as OperationId,
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
