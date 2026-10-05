import {
  type AgentDefinition,
  type StepExecutionId,
  type IdempotencyKey,
  type StepResultMessage,
  type AflowError,
  errorContext,
  getOperation,
  type GrantEnforcementResult,
  SNOOZE_OPERATION_ID,
  resolveSnoozeDelayMs,
} from '@aflow/schemas';
import {
  scheduleShardTimer,
  type SessionHotState,
  type StepHotState,
  type SessionEvent,
  getSessionState,
  updateSessionState,
  atomicScheduleStep,
  getRunAccessGrant,
} from '@aflow/redis';
import { readCurrentActorUserId } from '../helpers/executionAuthority.js';
import {
  GrantRenewalRefused,
  renewRunAccessGrant,
  resolveGrantRenewalSource,
} from '../../gates/grantRenewal.js';
import { routeSessionPauseToSubscribers } from '../handlers/pausedSessionRouting.js';
import { resolveStepInput } from '../helpers/stepInputResolution.js';
import {
  buildSpaceContext,
  readCachedSpaceContext,
  cacheSpaceContext,
  readSpaceContextGen,
} from '../helpers/spaceContext.js';
import { serializeOverlay, readInlineVar } from '../helpers/runtimeState.js';
import { persistAgentTurnToolSurface } from '../helpers/persistToolSurface.js';
import { resolveConfigRecursive } from '../helpers/configResolution.js';
import { resolveConfigRecursiveWithReport } from '../helpers/configResolution.js';
import { decideHarnessBrowserGating, decideStepGating } from '../../gates/decideStepGating.js';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { describeEnqueueFailure, enqueueFailureResultError } from '../../../lib/enqueueFailure.js';
import { dispatchOrWaitOnExecutor } from './executorWait.js';
import type { SessionOrchestratorBindings } from '../lifecycle/context.js';
import { resolveAndGate as stepServiceResolveAndGate } from '../../StepService/index.js';
import type { ScheduleStepParams } from '../types.js';
import { generateStepExecutionId, generateEventId } from '../helpers/ids.js';
import { getStepDefinition } from '../helpers/flowDefinition.js';
import { isInlineOperation } from '../helpers/inlineOperations.js';
import { ensureAgentChatInputOverlay, seedTurn0ChatInput } from '../helpers/inputPause.js';
import { dispatchInlineOp } from '../handlers/dispatchInlineOp.js';
import { buildStepScheduledRecoveryEvent } from '../helpers/recoveryEmitter.js';

import { createBuildAgentFlowContextDetails } from '../helpers/agentFlowContext.js';
import { createRelayWorkflowTaskActivity } from './relayWorkflowTaskActivity.js';
import { extractStepDetail } from './stepDetail.js';

const STATE_REF = /^\$\{state\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * The model this run's agent turn is actually running on.
 *
 * Derived here rather than threaded through every `scheduleStep` call site,
 * since the answer is a property of the run, not of the caller.
 *
 * The platform agents do not pin a literal — Helmsman's step config carries
 * `${state.helmsman_model}`, because the model is the operator's live choice.
 * A resolver that accepted any non-empty string would forward that expression
 * verbatim, and downstream it is simply a model name nothing can resolve: the
 * caller preference silently drops and whatever default is reachable wins
 * instead. So a state reference is looked up, and anything still unresolved is
 * reported as no answer rather than as a bogus one.
 */
export function deriveAgentModel(
  agentDefinition: AgentDefinition,
  runtimeState: SessionHotState['runtimeState'] | undefined,
): string | undefined {
  for (const step of agentDefinition.steps) {
    if (step.operation !== 'ai.agent.turn') continue;
    const model = step.config['model'];
    if (typeof model !== 'string' || model.length === 0) continue;
    const stateRef = STATE_REF.exec(model);
    if (!stateRef) return model.includes('${') ? undefined : model;
    if (!runtimeState) return undefined;
    const resolved = readInlineVar(runtimeState, stateRef[1]!, '');
    return resolved.length > 0 ? resolved : undefined;
  }
  return undefined;
}

export function createScheduleStep(bindings: SessionOrchestratorBindings) {
  const { deps } = bindings;
  const { db, redis, payloadStore, guardrailGate } = deps;
  const buildAgentFlowContextDetails = createBuildAgentFlowContextDetails(deps);
  const relayWorkflowTaskActivity = createRelayWorkflowTaskActivity(bindings);

  return async function scheduleStep(params: ScheduleStepParams): Promise<StepExecutionId> {
    let { context } = params;
    const { stepId, inputRef, attempt = 1, delayMs } = params;
    const now = Date.now();

    const stepDef = getStepDefinition(context.agentDefinition, stepId);
    const stepExecutionId = generateStepExecutionId();
    const idempotencyKey =
      `${context.runId}:${stepExecutionId}:${String(attempt)}` as IdempotencyKey;

    let runState: SessionHotState | null | undefined;
    let runtimeState: SessionHotState['runtimeState'] | undefined;
    try {
      runState = await getSessionState(redis, context.tenantId, context.runId);
      runtimeState = runState?.runtimeState;
    } catch {
      /* resolve without state */
    }

    const callerModel = deriveAgentModel(context.agentDefinition, runtimeState);

    // Ensure spaceId is always on the context (from hot state if caller didn't provide it)
    if (!context.spaceId && runState?.spaceId) {
      context = { ...context, spaceId: runState.spaceId };
    }

    // Refuse to schedule steps for terminal or cancelled runs
    if (
      runState?.status === 'FAILED' ||
      runState?.status === 'SUCCEEDED' ||
      runState?.status === 'CANCELLED'
    ) {
      console.warn(
        `[SessionOrchestrator] Refusing to schedule step ${stepId} — run ${context.runId} is ${runState.status}`,
      );
      return stepExecutionId;
    }

    let grant = await getRunAccessGrant(redis, context.tenantId, context.runId);
    {
      const renewalSource = resolveGrantRenewalSource(grant, runState);
      if (renewalSource) {
        try {
          // Renewal fires at most once per grant lifetime, never per step, so
          // it can afford the principal check a resume performs. On failure
          // the grant stays expired/absent and the step is denied with the
          // non-retryable permission error below.
          const renewedGrant = await renewRunAccessGrant(db, redis, {
            tenantId: context.tenantId,
            runId: context.runId,
            source: renewalSource,
          });
          console.warn(
            `[SessionOrchestrator] Auto-renewed ${grant ? 'expired' : 'absent'} grant for run ${context.runId}`,
          );
          grant = renewedGrant;
        } catch (renewErr) {
          if (renewErr instanceof GrantRenewalRefused) {
            console.warn(
              `[SessionOrchestrator] Grant renewal refused for run ${context.runId}: ${renewErr.message}`,
            );
            grant = null;
          } else {
            console.warn(
              `[SessionOrchestrator] Grant auto-renewal failed for run ${context.runId}:`,
              renewErr instanceof Error ? renewErr.message : String(renewErr),
            );
            // grant stays expired/absent — enforcement below will handle it
          }
        }
      }

      const opDesc = getOperation(stepDef.operation);
      const opMutates = opDesc?.mutates ?? false;
      const opPrivileged = opDesc?.privileged ?? false;
      const opCapabilityGroupId =
        opDesc?.capabilityGroupId ?? stepDef.operation.split('.').slice(0, -1).join('.');
      const opAccessMode = opDesc?.accessMode ?? (opMutates ? 'write' : 'read');
      const opRiskModifiers = opDesc?.riskModifiers ?? [];

      const grantResult: GrantEnforcementResult = decideStepGating({
        stepDef,
        opDesc,
        grant,
        opMutates,
        opPrivileged,
        opCapabilityGroupId,
        opAccessMode,
        opRiskModifiers,
        allSteps: context.agentDefinition.steps,
      });

      // The appliance's half of a host binding. The machine checks its own half
      // on every operation; this is the one that could otherwise never refuse,
      // which is why deleting a binding row revoked nothing.
      let bindingRefusal: string | undefined;
      let harnessBrowserResult: GrantEnforcementResult = { allowed: true };
      if (stepDef.stepType === 'host') {
        try {
          const { getDatabase, withTenantSchema, createTenantContext } =
            await import('@aflow/database');
          const { checkHostBinding } = await import('../../gates/hostBindingGate.js');
          // The store, not just the inline form: a `host.file.put` carrying a
          // large body is a stored ref, and treating that as unreadable would
          // refuse the operation rather than check it.
          const resolvedInput = await payloadStore.retrieve(inputRef);
          harnessBrowserResult = decideHarnessBrowserGating({
            stepDef,
            grant,
            resolvedInput,
            allSteps: context.agentDefinition.steps,
          });
          const outcome = await withTenantSchema(
            getDatabase(),
            createTenantContext(context.tenantId),
            async (tx) =>
              await checkHostBinding({
                operationId: stepDef.operation,
                spaceId: context.spaceId,
                resolvedInput,
                tx,
              }),
          );
          if (!outcome.allowed) bindingRefusal = outcome.reason;
        } catch (err) {
          // A gate that cannot answer must not become a way through. The host
          // lane is the one place where failing open would hand out access to
          // the operator's own machine.
          bindingRefusal = `The connected folder for this step could not be confirmed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      const grantRefusal = !grantResult.allowed
        ? grantResult.reason
        : !harnessBrowserResult.allowed
          ? harnessBrowserResult.reason
          : undefined;
      if (grantRefusal !== undefined || bindingRefusal !== undefined) {
        // Denied → fail just this step via a synthetic result. Never park the
        // run: this point is reached before any step state exists, so a pause
        // here emits no resume contract for anyone to act on.
        const denialReason = bindingRefusal ?? grantRefusal ?? 'Denied.';
        console.warn(`[SessionOrchestrator] Denied step ${stepId}: ${denialReason}`);

        const errorPayload = {
          code: bindingRefusal !== undefined ? 'HOST_BINDING_DENIED' : 'GRANT_DENIED',
          message: denialReason,
          classification: 'permission' as const,
          retryable: false,
          timestamp: new Date().toISOString(),
        };
        const errorRef = `inline:${Buffer.from(JSON.stringify(errorPayload)).toString('base64')}`;

        // Schedule step state first so it appears in timeline
        const stepState: StepHotState = {
          stepExecutionId,
          tenantId: context.tenantId,
          sessionId: context.runId,
          stepId,
          stepType: stepDef.stepType,
          operationId: stepDef.operation,
          attempt,
          status: 'SCHEDULED',
          scheduledAt: now,
          inputRef,
          idempotencyKey,
          traceId: context.traceId,
          parentStepExecutionId: params.parentStepExecutionId,
        };

        const stepEvent: SessionEvent = {
          eventId: generateEventId(),
          eventType: 'StepScheduled',
          timestamp: now,
          sessionId: context.runId,
          stepId,
          stepExecutionId,
          stepType: stepDef.stepType,
          attempt,
          metadata: {
            stepName: stepDef.name ?? stepId,
            operationId: stepDef.operation,
          },
        };

        await atomicScheduleStep(
          redis,
          context.tenantId,
          context.runId,
          stepState,
          { currentStepId: stepId, currentStepExecutionId: stepExecutionId, status: 'RUNNING' },
          stepEvent,
        );

        // Forward StepScheduled to parent for unified timeline rendering
        if (runState?.parentSessionId) {
          try {
            const { forwardEventToParent } = await import('../handlers/forwardChildEvent.js');
            await forwardEventToParent(redis, context.tenantId, context.runId, stepEvent);
          } catch {
            // Best-effort forwarding
          }
        }

        await bindings.applyResult({
          result: {
            messageVersion: 1,
            tenantId: context.tenantId,
            sessionId: context.runId,
            stepExecutionId,
            stepId,
            stepType: stepDef.stepType,
            operationId: stepDef.operation,
            attempt,
            idempotencyKey,
            status: 'FAILED',
            errorRef,
            error: errorPayload,
            traceId: context.traceId,
            finishedAtMs: Date.now(),
          } as StepResultMessage,
          messageId: `synthetic:grant-denied:${stepExecutionId}`,
        });
        return stepExecutionId;
      }
    }

    // ── State-variable-first: agent turn 0 — write chatInput before resolution ──
    if (stepDef.operation === 'ai.agent.turn' && runtimeState) {
      const turnVarKey = `ai.agent.turnNumber.${stepId}`;
      const turnVar = runtimeState.variables[turnVarKey] as
        { ref?: { kind: string; value?: unknown } } | undefined;
      const turnNumber =
        turnVar?.ref?.kind === 'inline' && typeof turnVar.ref.value === 'number'
          ? turnVar.ref.value
          : 0;

      if (turnNumber === 0) {
        const rc = resolveConfigRecursive(stepDef.config, {}, runtimeState) as Record<
          string,
          unknown
        >;
        const promptText = ((rc['prompt'] ?? rc['goal'] ?? '') as string) || undefined;

        if (promptText) {
          const seeded = seedTurn0ChatInput(runtimeState, promptText, stepId, now);
          if (seeded) {
            runtimeState = seeded;
            const overlay = ensureAgentChatInputOverlay(runState ?? {}, stepId);

            await updateSessionState(redis, context.tenantId, context.runId, {
              runtimeState,
              variableDefsOverlay: serializeOverlay(overlay),
            });

            getOrchestratorLogger().debug(
              `Agent turn 0: wrote chatInput for ${stepId}, prompt length=${String(promptText.length)}`,
            );
          }
        }
      }
    }

    // Phase B: Pre-execution state variable gating via StepService.
    const { unresolvedStateRefs } = resolveConfigRecursiveWithReport(
      stepDef.config,
      {},
      runtimeState,
    );

    if (unresolvedStateRefs.length > 0) {
      const gateResult = await stepServiceResolveAndGate(
        { redis, payloadStore },
        {
          tenantId: context.tenantId,
          runId: context.runId,
          agentDef: context.agentDefinition,
          traceId: context.traceId,
          stepDef,
          stepExecutionId,
          attempt,
          runState: runState ?? ({} as SessionHotState),
        },
        unresolvedStateRefs,
      );
      if (gateResult) {
        await routeSessionPauseToSubscribers(
          { redis, payloadStore, db },
          {
            tenantId: context.tenantId,
            runId: context.runId,
            traceId: context.traceId,
            ...(runState ? { runState } : {}),
            contractRef:
              gateResult.kind === 'paused' ? (gateResult.requestedInputRef ?? null) : null,
            pauseReason: 'Required input missing before the step could run',
            // scheduleStep is reached from consumers with mixed ack semantics —
            // never depend on redelivery.
            replayCarriesRetry: false,
          },
        );
        return stepExecutionId;
      }
    }

    const isAgentTurnStep = stepDef.operation === 'ai.agent.turn';
    const currentActorUserId = readCurrentActorUserId(runState) ?? runState?.createdBy;
    const { loadSessionRoster } = await import('../helpers/sessionRoster.js');
    const sessionParticipants = isAgentTurnStep
      ? await loadSessionRoster(db, context.tenantId, context.runId)
      : [];
    const agentFlowContextDetails =
      isAgentTurnStep && runState?.target
        ? await buildAgentFlowContextDetails({
            tenantId: context.tenantId,
            runId: context.runId,
            target: runState.target,
            ...(runState.spaceId ? { spaceId: runState.spaceId } : {}),
            // Who the agent is addressing on THIS turn. In a shared room that
            // is whoever last spoke, not whoever opened the session — telling
            // the agent otherwise makes it answer a second participant by the
            // first one's name.
            ...(currentActorUserId ? { createdBy: currentActorUserId } : {}),
            ...(runState.trigger ? { trigger: runState.trigger } : {}),
            ...(runState.voiceMode === true ? { voiceMode: true } : {}),
            ...(sessionParticipants.length > 0 ? { participants: sessionParticipants } : {}),
          })
        : undefined;

    let spaceContextForTurn: Awaited<ReturnType<typeof buildSpaceContext>> | undefined;
    if (isAgentTurnStep && runState?.spaceId) {
      const currentGen = await readSpaceContextGen(redis, context.tenantId, runState.spaceId);
      spaceContextForTurn = readCachedSpaceContext(runState, currentGen);
      if (!spaceContextForTurn) {
        spaceContextForTurn = await buildSpaceContext(db, context.tenantId, runState.spaceId);
        if (spaceContextForTurn) {
          await cacheSpaceContext(
            redis,
            context.tenantId,
            context.runId,
            spaceContextForTurn,
            currentGen,
          );
        }
      }
    }
    let resolvedInputRef: string;
    let inputValidationError: Error | null = null;
    try {
      resolvedInputRef = await resolveStepInput(
        payloadStore,
        stepDef,
        inputRef,
        runtimeState,
        context.agentDefinition,
        context.tenantId,
        context.runId,
        params.lastToolResults,
        runState?.spaceId,
        agentFlowContextDetails,
        spaceContextForTurn,
        runState?.agentRoleOverride,
        runState?.delegationContextJson,
        runState?.finalOutputSchemaOverrideJson,
        grant,
      );
    } catch (err) {
      inputValidationError = err instanceof Error ? err : new Error(String(err));
      resolvedInputRef = inputRef;
    }

    // Persist the per-turn tool surface buildAgentTurnInput computed into
    // runtimeState so the virtual-tool lowering gate (handleRunStepInline) reads
    // THIS turn's surface, not the prior turn's. See persistAgentTurnToolSurface.
    if (isAgentTurnStep && !inputValidationError) {
      await persistAgentTurnToolSurface(
        redis,
        context.tenantId,
        context.runId,
        stepId,
        runtimeState,
      );
    }

    // Guardrail: on_tool_input / on_agent_turn_input
    if (guardrailGate) {
      const trigger =
        stepDef.operation === 'ai.agent.turn'
          ? ('on_agent_turn_input' as const)
          : ('on_tool_input' as const);
      if (!runState?.target) {
        // Hot state must exist for guardrails — without it, we can't key the
        // policy cache. Skip the check (fail-open) and log; this matches the
        // existing compile-failure fail-open semantics.
        getOrchestratorLogger().warn(
          `[guardrail] No runState.target for run ${context.runId}; skipping ${trigger} check (fail-open)`,
        );
      }
      const gr = runState?.target
        ? await guardrailGate.check(trigger, resolvedInputRef, {
            tenantId: context.tenantId,
            runId: context.runId,
            target: runState.target,
            stepExecutionId,
            stepId,
            operationId: stepDef.operation,
          })
        : ({
            passed: true,
            violations: [],
            action: 'allow' as const,
            durationMs: 0,
            checksRun: 0,
          } as Awaited<ReturnType<typeof guardrailGate.check>>);
      if (!gr.passed && (gr.action === 'block' || gr.action === 'escalate')) {
        const { GuardrailBlockedError } = await import('../../GuardrailGate/index.js');
        throw new GuardrailBlockedError(gr.violations);
      }
    }

    const stepState: StepHotState = {
      stepExecutionId,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepId,
      stepType: stepDef.stepType,
      operationId: stepDef.operation,
      attempt,
      status: 'SCHEDULED',
      scheduledAt: now,
      inputRef: resolvedInputRef,
      idempotencyKey,
      traceId: context.traceId,
      parentStepExecutionId: params.parentStepExecutionId,
    };

    const runUpdates: Partial<SessionHotState> = {
      currentStepId: stepId,
      currentStepExecutionId: stepExecutionId,
      status: 'RUNNING',
    };

    const stepEvent: SessionEvent = {
      eventId: generateEventId(),
      eventType: 'StepScheduled',
      timestamp: now,
      sessionId: context.runId,
      stepId,
      stepExecutionId,
      stepType: stepDef.stepType,
      attempt,
      metadata: {
        stepName: stepDef.name ?? stepId,
        operationId: stepDef.operation,
        inputRef: resolvedInputRef,
      },
    };
    const schedStepDetail = extractStepDetail(stepDef.operation, resolvedInputRef);
    if (schedStepDetail != null) {
      stepEvent.metadata!['stepDetail'] = schedStepDetail;
    }
    if (stepDef.tags.includes('virtual_tool')) {
      stepEvent.metadata!['dispatchWrapper'] = true;
    }

    const schedRecoveryEvents = await buildStepScheduledRecoveryEvent(
      redis,
      context.tenantId,
      context.runId,
      stepState,
    );

    await atomicScheduleStep(
      redis,
      context.tenantId,
      context.runId,
      stepState,
      runUpdates,
      stepEvent,
      undefined, // ttlSeconds (use default)
      schedRecoveryEvents,
    );

    await relayWorkflowTaskActivity(
      context.tenantId as string,
      context.runId,
      stepDef.operation,
      stepDef.name ?? stepId,
      schedStepDetail ?? undefined,
    );

    // Forward StepScheduled to parent for unified timeline rendering
    if (runState?.parentSessionId) {
      try {
        const { forwardEventToParent } = await import('../handlers/forwardChildEvent.js');
        await forwardEventToParent(redis, context.tenantId, context.runId, stepEvent);
      } catch {
        // Best-effort forwarding
      }
    }

    // Input validation failed — the step is now SCHEDULED in Redis so it appears
    // in the timeline, but we immediately produce a synthetic FAILED result. This
    // routes through the normal failure path (onFailure routing, agent error
    // feedback) instead of killing the entire run.
    if (inputValidationError) {
      const { StepInputValidationError: StepValidationErr } =
        await import('../helpers/stepInputResolution.js');
      const isStructured = inputValidationError instanceof StepValidationErr;
      const vr = isStructured
        ? (inputValidationError as InstanceType<typeof StepValidationErr>).validationResult
        : undefined;
      const errorPayload = {
        code: vr?.errorType ?? 'INPUT_VALIDATION_FAILED',
        message: inputValidationError.message,
        classification: 'validation' as const,
        retryable: false,
        timestamp: new Date().toISOString(),
        ...(vr?.errors ? { details: vr.errors } : {}),
        ...(vr?.unresolvedRefs ? { unresolvedRefs: vr.unresolvedRefs } : {}),
      };
      const errorRef = `inline:${Buffer.from(JSON.stringify(errorPayload)).toString('base64')}`;
      await bindings.applyResult({
        result: {
          messageVersion: 1,
          tenantId: context.tenantId,
          sessionId: context.runId,
          stepExecutionId,
          stepId,
          stepType: stepDef.stepType,
          operationId: stepDef.operation,
          attempt,
          idempotencyKey,
          status: 'FAILED',
          errorRef,
          error: errorPayload,
          traceId: context.traceId,
          finishedAtMs: Date.now(),
        } as StepResultMessage,
        messageId: `synthetic:input-validation-failed:${stepExecutionId}`,
      });
      return stepExecutionId;
    }

    if (isInlineOperation(stepDef.operation)) {
      if (stepDef.operation === SNOOZE_OPERATION_ID) {
        const snoozeInput = await payloadStore.retrieve(resolvedInputRef);
        const snoozeDelayMs = resolveSnoozeDelayMs(snoozeInput);
        await scheduleShardTimer(redis, {
          tenantId: context.tenantId,
          sessionId: context.runId,
          stepExecutionId,
          stepId,
          operationId: stepDef.operation,
          stepType: stepDef.stepType,
          reason: 'delayed_start',
          attempt,
          inputRef: resolvedInputRef,
          traceId: context.traceId,
          dueAtMs: now + snoozeDelayMs,
          ...(params.parentStepExecutionId
            ? { parentStepExecutionId: params.parentStepExecutionId }
            : {}),
        });
        return stepExecutionId;
      }
      await dispatchInlineOp(
        redis,
        payloadStore,
        context,
        stepDef,
        stepExecutionId,
        idempotencyKey,
        resolvedInputRef,
        attempt,
        now,
        params.parentStepExecutionId,
      );
      return stepExecutionId;
    }

    if (delayMs && delayMs > 0) {
      await scheduleShardTimer(redis, {
        tenantId: context.tenantId,
        sessionId: context.runId,
        stepExecutionId,
        stepId,
        operationId: stepDef.operation,
        stepType: stepDef.stepType,
        reason: 'delayed_start',
        attempt,
        inputRef: resolvedInputRef,
        traceId: context.traceId,
        dueAtMs: now + delayMs,
      });
    } else {
      let failure: AflowError | undefined;
      let thrown: unknown;
      try {
        const dispatched = await dispatchOrWaitOnExecutor(redis, {
          messageVersion: 1,
          tenantId: context.tenantId,
          sessionId: context.runId,
          stepExecutionId,
          parentStepExecutionId: params.parentStepExecutionId ?? null,
          stepId,
          stepType: stepDef.stepType,
          operationId: stepDef.operation,
          attempt,
          idempotencyKey,
          inputRef: resolvedInputRef,
          traceId: context.traceId,
          scheduledAtMs: now,
          credentialOwnerId: runState?.createdBy,
          spaceId: context.spaceId ?? runState?.spaceId,
          ...(callerModel !== undefined ? { callerModel } : {}),
          ...(runState?.activatedByPerson !== undefined
            ? { activatedByPerson: runState.activatedByPerson }
            : {}),
          // Stamped at dispatch, where the generation's calls are known as a
          // set. An executor answering one of them can only see the peers that
          // have already committed, so anything it counted for itself would be
          // arrival order wearing a deterministic name.
        });
        if (dispatched.kind === 'waiting') {
          getOrchestratorLogger().info(
            `Step ${stepId} is waiting for its ${stepDef.stepType} executor`,
            {
              tenantId: context.tenantId,
              sessionId: context.runId,
              stepExecutionId,
              operationId: stepDef.operation,
              nextLookAtMs: dispatched.nextLookAtMs,
            },
          );
        }
      } catch (error) {
        thrown = error;
        failure = describeEnqueueFailure(error);
      }
      if (failure !== undefined) {
        // A refused enqueue emits a synthetic FAILED result routed through
        // applyResult, so the step's onFailure routing fires (e.g. back to
        // the agent) instead of killing the entire run.
        getOrchestratorLogger().error(
          `Job enqueue failed for step ${stepId} (${failure.code})`,
          thrown instanceof Error ? thrown : undefined,
          errorContext(failure, {
            tenantId: context.tenantId,
            sessionId: context.runId,
            stepExecutionId,
            stepId,
            stepType: stepDef.stepType,
            operationId: stepDef.operation,
            traceId: context.traceId,
          }),
        );
        const errorPayload = enqueueFailureResultError(failure);
        const errorRef = `inline:${Buffer.from(JSON.stringify(errorPayload)).toString('base64')}`;
        await bindings.applyResult({
          result: {
            messageVersion: 1,
            tenantId: context.tenantId,
            sessionId: context.runId,
            stepExecutionId,
            stepId,
            stepType: stepDef.stepType,
            operationId: stepDef.operation,
            attempt,
            idempotencyKey,
            status: 'FAILED',
            errorRef,
            error: errorPayload,
            traceId: context.traceId,
            finishedAtMs: Date.now(),
          } as StepResultMessage,
          messageId: `synthetic:enqueue-failed:${stepExecutionId}`,
        });
        return stepExecutionId;
      }
    }

    return stepExecutionId;
  };
}
