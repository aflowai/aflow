import {
  type StepId,
  type IdempotencyKey,
  type StepResultMessage,
  type RunAccessGrant,
  errorContext,
  processFlowInput,
} from '@aflow/schemas';
import {
  addStepJob,
  type SessionHotState,
  type StepHotState,
  type SessionEvent,
  getSessionStateSafe,
  isSessionCorrupt,
  atomicCreateSession,
  markSeenThroughMessage,
  markRunActive,
  parseRunAccessGrant,
  serializeRunAccessGrant,
  DISCLOSED_CALLERS_FIELD,
  serializeDisclosedCallers,
} from '@aflow/redis';
import { createTenantContext } from '@aflow/database';
import { resolveDisclosedCallers } from '@aflow/cybernetic-runtime';
import type { DisclosedCallerBinding } from '@aflow/schemas';
import { resolveStepInput } from '../helpers/stepInputResolution.js';
import { buildSpaceContext, readSpaceContextGen } from '../helpers/spaceContext.js';
import { initializeRuntimeState } from '../helpers/runtimeState.js';
import { resolveConfigRecursive } from '../helpers/configResolution.js';
import { resolveConfigRecursiveWithReport } from '../helpers/configResolution.js';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { describeEnqueueFailure, enqueueFailureResultError } from '../../../lib/enqueueFailure.js';
import { encodeTaskInput } from '../../../lib/encodeTaskInput.js';
import type { SessionOrchestratorBindings } from '../lifecycle/context.js';
import type { FlowExecutionContext, SessionStatus, SessionOrchestrator } from '../types.js';
import { generateStepExecutionId, generateEventId } from '../helpers/ids.js';
import { buildAuthorityFromActor } from '../helpers/executionAuthority.js';
import { getStepDefinition } from '../helpers/flowDefinition.js';
import { isInlineOperation } from '../helpers/inlineOperations.js';
import { fetchAgentDef } from '../helpers/fetchAgentDef.js';
import {
  filterRequiredUnresolved,
  extractUserMessageFromInput,
  agentChatInputVarId,
  pauseForMissingVariables,
} from '../helpers/inputPause.js';
import { dispatchInlineOp } from '../handlers/dispatchInlineOp.js';
import { routeSessionPauseToSubscribers } from '../handlers/pausedSessionRouting.js';
import { buildRunCreatedRecoveryEvents } from '../helpers/recoveryEmitter.js';

import { createBuildAgentFlowContextDetails } from '../helpers/agentFlowContext.js';
import { createRelayWorkflowTaskActivity } from '../scheduling/relayWorkflowTaskActivity.js';
import { extractStepDetail } from '../scheduling/stepDetail.js';

export function createStartRun(bindings: SessionOrchestratorBindings) {
  const { deps } = bindings;
  const { db, redis, payloadStore, guardrailGate, manifestService } = deps;
  const buildAgentFlowContextDetails = createBuildAgentFlowContextDetails(deps);
  const relayWorkflowTaskActivity = createRelayWorkflowTaskActivity(bindings);

  return async function startRun(params: Parameters<SessionOrchestrator['startRun']>[0]) {
    const startTime = Date.now();
    const { runId } = params;
    const now = Date.now();

    if (await isSessionCorrupt(redis, params.tenantId, runId)) {
      throw new Error(`Run ${runId} is stalled (state corrupt); clear quarantine to retry`);
    }

    const runResult = await getSessionStateSafe(redis, params.tenantId, runId);
    const existingRun = runResult.ok ? runResult.state : null;
    if (existingRun && existingRun.status !== 'QUEUED') {
      return { runId, status: existingRun.status as SessionStatus };
    }

    const checkExistingMs = Date.now() - startTime;

    const stepExecutionId = generateStepExecutionId();
    const runTarget = params.target;

    const fetchDefStart = Date.now();
    const agentDef = await fetchAgentDef(
      db,
      payloadStore,
      params.tenantId,
      runTarget,
      params.agentVersion,
    );
    const fetchDefMs = Date.now() - fetchDefStart;
    getOrchestratorLogger().debug(
      `startRun timing: checkExisting=${checkExistingMs}ms, fetchDef=${fetchDefMs}ms`,
    );

    // Guardrail: on_run_input
    if (guardrailGate) {
      const gr = await guardrailGate.check('on_run_input', params.inputRef, {
        tenantId: params.tenantId,
        runId,
        target: runTarget,
        ...(params.spaceId ? { spaceId: params.spaceId } : {}),
      });
      if (!gr.passed && gr.action === 'block') {
        const { GuardrailBlockedError } = await import('../../GuardrailGate/index.js');
        throw new GuardrailBlockedError(gr.violations);
      }
    }

    const startStepId = agentDef.startStepId as StepId;
    const stepDef = getStepDefinition(agentDef, startStepId);
    const idempotencyKey = `${runId}:${stepExecutionId}:1` as IdempotencyKey;

    // Parse the run input up front — used for runtime state initialization
    // and for extracting the user message for the FlowRunStarted event.
    let parsedInput: Record<string, unknown> | undefined;
    if (params.inputRef) {
      try {
        const data = await payloadStore.retrieve(params.inputRef);
        if (typeof data === 'object' && data !== null) {
          parsedInput = data as Record<string, unknown>;
        }
      } catch {
        /* ignore */
      }
    }

    if (parsedInput && agentDef.stateVariables.length > 0) {
      const pipelineResult = processFlowInput(parsedInput, agentDef);
      if (pipelineResult.ok) {
        parsedInput = pipelineResult.normalized;
        // Re-encode the normalized input so downstream consumers see the coerced version
        const normalizedInputRef = await encodeTaskInput(
          payloadStore,
          { tenantId: params.tenantId, runId, label: `normalized run input run=${runId}` },
          parsedInput,
        );
        params = { ...params, inputRef: normalizedInputRef };
      } else {
        const details = (pipelineResult.errors ?? []).map((e) => ({
          path: e.path,
          code: e.code,
          message: e.message,
        }));
        const detailMsg =
          pipelineResult.stage === 'coercion'
            ? `Input format error: ${pipelineResult.message}. Use the standard format: { input: <value>, config?: { ... } } or a bare value.`
            : `Flow input validation failed: ${pipelineResult.message}`;
        const flowError = {
          code: 'FLOW_INPUT_VALIDATION_FAILED',
          message: detailMsg,
          classification: 'validation' as const,
          retryable: false,
          timestamp: new Date().toISOString(),
          ...(details.length > 0 ? { details } : {}),
          ...(pipelineResult.unknownKeys ? { unknownKeys: pipelineResult.unknownKeys } : {}),
        };
        throw Object.assign(new Error(detailMsg), { flowError });
      }
    }

    let runtimeState = await initializeRuntimeState(
      agentDef,
      params.inputRef,
      now,
      parsedInput,
      payloadStore,
      { tenantId: params.tenantId, runId, stepExecutionId },
    );

    // Phase B: Pre-execution state variable gating.
    // Check if the start step's config has unresolved ${state.X} refs.
    // If required variables are missing, pause the run and request input.
    const { unresolvedStateRefs } = resolveConfigRecursiveWithReport(
      stepDef.config,
      {},
      runtimeState,
    );
    const requiredUnresolved = filterRequiredUnresolved(unresolvedStateRefs, agentDef);
    if (requiredUnresolved.length > 0) {
      const pauseResult = await pauseForMissingVariables(
        redis,
        payloadStore,
        params.tenantId,
        runId,
        stepExecutionId,
        startStepId,
        runTarget,
        params.agentVersion,
        params.inputRef,
        params.createdBy,
        params.traceId,
        params.idempotencyKey,
        stepDef,
        runtimeState,
        requiredUnresolved,
        agentDef,
        now,
        parsedInput,
        params.spaceId,
        params.clientMessageId,
        {
          ...(existingRun?.parentSessionId ? { parentSessionId: existingRun.parentSessionId } : {}),
          ...(existingRun?.parentStepExecutionId
            ? { parentStepExecutionId: existingRun.parentStepExecutionId }
            : {}),
          ...(existingRun?.workflowExecution
            ? { workflowExecution: existingRun.workflowExecution }
            : {}),
        },
      );
      manifestService?.trackRun({ runId, tenantId: params.tenantId, status: 'PAUSED' });
      await routeSessionPauseToSubscribers(
        {
          redis,
          payloadStore,
          db,
          ...(guardrailGate ? { guardrailGate } : {}),
          ...(manifestService ? { manifestService } : {}),
        },
        {
          tenantId: params.tenantId,
          runId,
          traceId: params.traceId,
          contractRef: pauseResult.requestedInputRef,
          pauseReason: `Required input missing at start: ${requiredUnresolved.join(', ')}`,
          // The start control message is acked whether or not this throws.
          replayCarriesRetry: false,
        },
      );
      return pauseResult;
    }

    const isAgentTurn = stepDef.operation === 'ai.agent.turn';

    if (isAgentTurn && runtimeState) {
      const rc = resolveConfigRecursive(stepDef.config, {}, runtimeState) as Record<
        string,
        unknown
      >;
      const promptText = ((rc['prompt'] ?? rc['goal'] ?? '') as string) || undefined;
      if (promptText) {
        const chatVarId = agentChatInputVarId(startStepId);
        runtimeState = {
          schemaVersion: runtimeState.schemaVersion,
          variables: {
            ...runtimeState.variables,
            [chatVarId]: {
              ref: { kind: 'inline' as const, value: promptText },
              updatedAtMs: now,
              updatedBy: { actor: 'orchestrator' as const, stepId: startStepId },
              version: 1,
            },
          },
          version: runtimeState.version + 1,
          updatedAtMs: now,
        };
      }
    }

    // Resolved once, here, for two reasons. It must not move mid-run — an
    // operator editing a simulation cannot change who the agent has spent the
    // conversation being, the same reason its revision and baseline are pinned.
    // And it must be resolved BEFORE the opening turn's input is materialized,
    // which happens ahead of atomicCreateSession: that write DELs the hash, so
    // the first turn cannot read back what the create literal is about to store.
    let disclosedCallers: DisclosedCallerBinding[] = [];
    if (isAgentTurn && params.spaceId) {
      try {
        disclosedCallers = await resolveDisclosedCallers({
          db,
          tenantCtx: createTenantContext(params.tenantId),
          spaceId: params.spaceId,
          runInput: params.simulationRunInput,
        });
      } catch (err) {
        // A caller the agent is not told about is a colder start, not a wrong
        // one: it asks who it is speaking to. Failing the run would be worse.
        getOrchestratorLogger().warn(
          `startRun: caller disclosure failed, starting without it: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const agentFlowContextDetails = isAgentTurn
      ? await buildAgentFlowContextDetails({
          tenantId: params.tenantId,
          runId,
          target: runTarget,
          ...(params.spaceId ? { spaceId: params.spaceId } : {}),
          ...(params.createdBy ? { createdBy: params.createdBy } : {}),
          ...(params.trigger ? { trigger: params.trigger } : {}),
          ...(params.voiceMode ? { voiceMode: true } : {}),
          disclosedCallers,
          ...(params.actorContext
            ? {
                participants: [
                  {
                    userId: params.actorContext.userId,
                    ...(params.actorContext.displayName
                      ? { displayName: params.actorContext.displayName }
                      : {}),
                  },
                ],
              }
            : {}),
        })
      : undefined;

    let spaceContext: Awaited<ReturnType<typeof buildSpaceContext>> | undefined;
    let spaceContextGen = 0;
    if (isAgentTurn && params.spaceId) {
      spaceContextGen = await readSpaceContextGen(redis, params.tenantId, params.spaceId);
      spaceContext = await buildSpaceContext(db, params.tenantId, params.spaceId);
    }

    // Compiled before input resolution: the opening turn's tool surface is
    // materialized inside resolveStepInput, and it must see the same grant
    // that step gating later enforces. Compiled only — the grant is persisted
    // as part of the atomicCreateSession literal below, because that write
    // DELs the hash and would discard anything stored ahead of it.
    let compiledGrant: RunAccessGrant | null = null;
    if (params.actorContext) {
      try {
        const { compileRunAccessGrant } = await import('@aflow/authz');
        compiledGrant = await compileRunAccessGrant(
          {
            tenantId: params.tenantId,
            spaceId: params.actorContext.spaceId ?? params.spaceId ?? params.tenantId,
            spaceRole: params.actorContext.spaceRole ?? 'viewer',
            userId: params.actorContext.userId,
            tenantRole: params.actorContext.tenantRole,
            grantReason: 'start',
          },
          db,
        );
      } catch (grantErr) {
        // actorContext was present, so this is a real failure — the run will
        // pause fail-closed at its first gated step ("grant missing"). Surface
        // the true cause so it is never hidden behind an opaque pause.
        console.warn(
          `[SessionOrchestrator] Grant compilation FAILED for run ${runId} despite actorContext; ` +
            `run will pause at first gated step:`,
          grantErr instanceof Error ? grantErr.message : String(grantErr),
        );
      }
    }

    // A QUEUED session can arrive already holding the only grant it will ever
    // have: an eval trial's Runner inherits the anchor's read-only trial grant,
    // and nothing here can recompile it — the control message carries no
    // actorContext, and recompiling from the space profile is exactly what that
    // grant exists to prevent. It has to ride the literal below like a compiled
    // one, because atomicCreateSession DELs the hash first (Plan 28 §P3).
    const runGrant =
      compiledGrant ?? (existingRun?.grantJson ? parseRunAccessGrant(existingRun.grantJson) : null);

    const resolvedInputRef = await resolveStepInput(
      payloadStore,
      stepDef,
      params.inputRef,
      runtimeState,
      agentDef,
      params.tenantId,
      runId,
      undefined,
      params.spaceId,
      agentFlowContextDetails,
      spaceContext,
      existingRun?.agentRoleOverride,
      existingRun?.delegationContextJson,
      existingRun?.finalOutputSchemaOverrideJson,
      runGrant,
    );

    // Extract user message for the FlowRunStarted event: prefer the first text-type
    // input variable (state-variable-first), fall back to message/input keys for legacy.
    const startUserMessage = extractUserMessageFromInput(parsedInput, agentDef);

    const runState: SessionHotState = {
      sessionId: runId,
      tenantId: params.tenantId,
      target: runTarget,
      agentVersion: params.agentVersion,
      status: 'RUNNING',
      currentStepId: startStepId,
      currentStepExecutionId: stepExecutionId,
      createdAt: now,
      startedAt: now,
      inputRef: params.inputRef,
      createdBy: params.createdBy,
      traceId: params.traceId,
      idempotencyKey: params.idempotencyKey,
      // The message that opens a room takes the first position in it. Set
      // here rather than incremented, so it lands in the same atomic write
      // that creates the counter's home.
      //
      // The same message starts the conversation's activity clock. A run
      // nobody opened with words — a Runner claiming a task, a schedule
      // firing — never acquires one, which is what keeps it out of the
      // conversation list and away from the metadata plane.
      ...(startUserMessage ? { lastMessageSeq: 1, lastActivityAt: now } : {}),
      ...(params.spaceId ? { spaceId: params.spaceId } : {}),
      ...(params.trigger ? { trigger: params.trigger } : {}),
      ...(params.voiceMode ? { voiceMode: true } : {}),
      ...(params.actorContext ? { actorContextJson: JSON.stringify(params.actorContext) } : {}),
      ...(runGrant ? { grantJson: serializeRunAccessGrant(runGrant) } : {}),
      // Rides the create literal for the same reason the grant does:
      // atomicCreateSession DELs the hash, so anything stored ahead of it is
      // discarded.
      ...(params.simulationRunInput
        ? { simulationRunInputJson: JSON.stringify(params.simulationRunInput) }
        : {}),
      ...(disclosedCallers.length > 0
        ? { [DISCLOSED_CALLERS_FIELD]: serializeDisclosedCallers(disclosedCallers) }
        : {}),

      ...(params.actorContext
        ? {
            executionAuthorityJson: JSON.stringify(
              buildAuthorityFromActor(params.actorContext, {
                spaceId: params.actorContext.spaceId ?? params.spaceId ?? params.tenantId,
                establishedReason:
                  params.trigger === 'schedule'
                    ? 'schedule'
                    : params.trigger === 'webhook'
                      ? 'event'
                      : 'start',
              }),
            ),
          }
        : {}),
      ...(spaceContext
        ? {
            spaceContextJson: JSON.stringify(spaceContext),
            spaceContextBuiltAt: now,
            spaceContextGen,
          }
        : {}),
      lastUpdatedAt: now,
      runtimeState,
      ...(existingRun?.parentSessionId ? { parentSessionId: existingRun.parentSessionId } : {}),
      ...(existingRun?.parentStepExecutionId
        ? { parentStepExecutionId: existingRun.parentStepExecutionId }
        : {}),
      ...(existingRun?.workflowExecution
        ? { workflowExecution: existingRun.workflowExecution }
        : {}),
      ...(existingRun?.waitingForChildSessionIds
        ? { waitingForChildSessionIds: existingRun.waitingForChildSessionIds }
        : {}),
      // Preserve agentRole override from delegation (set by runSubflow handler)
      ...(existingRun?.agentRoleOverride
        ? { agentRoleOverride: existingRun.agentRoleOverride }
        : {}),
      // Preserve delegation context from QUEUED state (set by delegate handler)
      ...(existingRun?.delegationContextJson
        ? { delegationContextJson: existingRun.delegationContextJson }
        : {}),
      // Preserve delegation depth from QUEUED state
      ...(existingRun?.delegationDepth != null
        ? { delegationDepth: existingRun.delegationDepth }
        : {}),
      // Preserve final-output schema override from QUEUED state (set by
      // delegate handler when the parent task declares outputContract.schema).
      // Without this, startRun would clobber the schema and submit_output
      // would silently skip validation — the bug that let malformed runner
      // bundles propagate to the Driver's validate-and-propose step.
      ...(existingRun?.finalOutputSchemaOverrideJson
        ? { finalOutputSchemaOverrideJson: existingRun.finalOutputSchemaOverrideJson }
        : {}),
      ...(existingRun?.finalOutputValidatorRefs
        ? { finalOutputValidatorRefs: existingRun.finalOutputValidatorRefs }
        : {}),
      // Preserve display-only delegation metadata from QUEUED state. The
      // delegate handler stamps these so the chat UI can disambiguate
      // parallel sub-agent runs (e.g. two cybernetic-runner sessions started
      // in the same turn) by workflow + task name. Without this preserve,
      // the QUEUED→RUNNING transition wipes them and forwarded events fall
      // back to the bare agent ID badge.
      ...(existingRun?.delegationDisplayWorkflowSlug
        ? { delegationDisplayWorkflowSlug: existingRun.delegationDisplayWorkflowSlug }
        : {}),
      ...(existingRun?.delegationDisplayTaskId
        ? { delegationDisplayTaskId: existingRun.delegationDisplayTaskId }
        : {}),
      ...(existingRun?.delegationDisplayTaskName
        ? { delegationDisplayTaskName: existingRun.delegationDisplayTaskName }
        : {}),
    };

    const stepState: StepHotState = {
      stepExecutionId,
      tenantId: params.tenantId,
      sessionId: runId,
      stepId: startStepId,
      stepType: stepDef.stepType,
      operationId: stepDef.operation,
      attempt: 1,
      status: 'SCHEDULED',
      scheduledAt: now,
      inputRef: resolvedInputRef,
      idempotencyKey,
      traceId: params.traceId,
    };

    const startEvent: SessionEvent = {
      eventId: generateEventId(),
      eventType: 'SessionStarted',
      timestamp: now,
      sessionId: runId,
      metadata: {
        target: runTarget,
        agentVersion: params.agentVersion,
        inputRef: params.inputRef,
        ...(startUserMessage ? { userMessage: startUserMessage, messageSeq: 1 } : {}),
        ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
        ...(params.actorContext
          ? {
              actorUserId: params.actorContext.userId,
              ...(params.actorContext.displayName
                ? { actorDisplayName: params.actorContext.displayName }
                : {}),
            }
          : {}),
      },
    };
    const stepEvent: SessionEvent = {
      eventId: generateEventId(),
      eventType: 'StepScheduled',
      timestamp: now,
      sessionId: runId,
      stepId: startStepId,
      stepExecutionId,
      stepType: stepDef.stepType,
      attempt: 1,
      metadata: {
        stepName: stepDef.name ?? startStepId,
        operationId: stepDef.operation,
        inputRef: resolvedInputRef,
      },
    };
    const startStepDetail = extractStepDetail(stepDef.operation, resolvedInputRef);
    if (startStepDetail != null) {
      stepEvent.metadata!['stepDetail'] = startStepDetail;
    }

    await relayWorkflowTaskActivity(
      params.tenantId as string,
      runId,
      stepDef.operation,
      stepDef.name ?? startStepId,
      startStepDetail ?? undefined,
    );

    // Opening a room is reading it. Every other way of speaking in a room
    // marks the speaker read through their own message; without the same here,
    // the person who started the conversation comes back to find their own
    // first message sitting under an unread line.
    if (startUserMessage && params.actorContext?.userId) {
      await markSeenThroughMessage(redis, params.tenantId, runId, params.actorContext.userId, 1);
    }

    const recoveryEvents = await buildRunCreatedRecoveryEvents(redis, runState, stepState);

    const atomicStart = Date.now();
    await atomicCreateSession(
      redis,
      runState,
      stepState,
      startEvent,
      stepEvent,
      undefined, // ttlSeconds (use default)
      recoveryEvents,
    );
    const atomicMs = Date.now() - atomicStart;

    // Forward initial StepScheduled to parent for unified timeline rendering
    if (runState.parentSessionId) {
      try {
        const { forwardEventToParent } = await import('../handlers/forwardChildEvent.js');
        await forwardEventToParent(redis, params.tenantId, runId, stepEvent);
      } catch {
        // Best-effort forwarding
      }
    }

    await markRunActive(redis, params.tenantId, runId).catch(() => {});

    manifestService?.trackRun({ runId, tenantId: params.tenantId, status: 'RUNNING' });

    const jobStart = Date.now();
    const startContext: FlowExecutionContext = {
      tenantId: params.tenantId,
      runId,
      agentDefinition: agentDef,
      traceId: params.traceId,
      ...(params.spaceId ? { spaceId: params.spaceId } : {}),
    };

    if (isInlineOperation(stepDef.operation)) {
      await dispatchInlineOp(
        redis,
        payloadStore,
        startContext,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        1,
        now,
      );
    } else {
      try {
        await addStepJob(redis, {
          messageVersion: 1,
          tenantId: params.tenantId,
          sessionId: runId,
          stepExecutionId,
          parentStepExecutionId: null,
          stepId: startStepId,
          stepType: stepDef.stepType,
          operationId: stepDef.operation,
          attempt: 1,
          idempotencyKey,
          inputRef: resolvedInputRef,
          traceId: params.traceId,
          scheduledAtMs: now,
          credentialOwnerId: params.createdBy,
          spaceId: params.spaceId,
        });
      } catch (error) {
        // All enqueue failures (including NoExecutorAvailableError and a lane
        // breaker refusal) route through applyResult so onFailure routing works.
        // For start steps with no onFailure, applyResult will still fail the run.
        const enqueueAflowError = describeEnqueueFailure(error);
        getOrchestratorLogger().error(
          `Job enqueue failed for start step ${startStepId} (${enqueueAflowError.code})`,
          error instanceof Error ? error : undefined,
          errorContext(enqueueAflowError, {
            tenantId: params.tenantId,
            runId,
            stepExecutionId,
            stepId: startStepId,
            stepType: stepDef.stepType,
            operationId: stepDef.operation,
            traceId: params.traceId,
          }),
        );
        const errorPayload = enqueueFailureResultError(enqueueAflowError);
        const errorRef = `inline:${Buffer.from(JSON.stringify(errorPayload)).toString('base64')}`;
        await bindings.applyResult({
          result: {
            messageVersion: 1,
            tenantId: params.tenantId,
            sessionId: runId,
            stepExecutionId,
            stepId: startStepId,
            stepType: stepDef.stepType,
            operationId: stepDef.operation,
            attempt: 1,
            idempotencyKey,
            status: 'FAILED',
            errorRef,
            error: errorPayload,
            traceId: params.traceId,
            finishedAtMs: Date.now(),
          } as StepResultMessage,
          messageId: `synthetic:enqueue-failed:${stepExecutionId}`,
        });
        return { runId, status: 'FAILED' as SessionStatus };
      }
    }

    getOrchestratorLogger().debug(
      `Redis timing: atomicCreate=${atomicMs}ms, addJob=${Date.now() - jobStart}ms, total=${Date.now() - startTime}ms`,
    );
    return { runId, status: 'RUNNING' as SessionStatus };
  };
}
