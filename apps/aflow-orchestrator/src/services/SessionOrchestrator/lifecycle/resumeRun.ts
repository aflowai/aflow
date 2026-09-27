import {
  type SessionId,
  type StepExecutionId,
  type StepId,
  type OperationId,
  type IdempotencyKey,
  type TraceId,
  type StepDefinition,
  mapResumeInput,
  type ResumeInputContract,
} from '@aflow/schemas';
import {
  addStepResult,
  addControlMessage,
  appendSessionEvent,
  markSessionDirty,
  type SessionHotState,
  getSessionStateSafe,
  getStepState,
  isSessionCorrupt,
  atomicCompleteStep,
  setRunAccessGrant,
  updateSessionState,
  getWriteApprovalGrant,
  takeRoomMessagePosition,
} from '@aflow/redis';
import { chooseResumeInputRef } from '../helpers/resumeInputRef.js';
import { readWriteApprovalRequest } from '../scheduling/writeApprovalPause.js';
import {
  getEffectiveStateVariables,
  getVariableVersion,
  serializeOverlay,
  writeInlineVar,
} from '../helpers/runtimeState.js';
import { leaveChildInputToWaiting } from '../helpers/delegationState.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestratorBindings } from '../lifecycle/context.js';
import type { SessionStatus, SessionOrchestrator } from '../types.js';
import { generateEventId } from '../helpers/ids.js';
import { fetchAgentDef } from '../helpers/fetchAgentDef.js';
import {
  extractUserMessageFromInput,
  agentChatInputVarId,
  ensureAgentChatInputOverlay,
} from '../helpers/inputPause.js';
import { buildRunStatusChangedRecoveryEvent } from '../helpers/recoveryEmitter.js';
import { AuthorityLostError, ControlConflictError } from '../../../lib/controlConflict.js';
import {
  buildAuthorityFromActor,
  readEstablishedAuthority,
  revalidateAuthority,
} from '../helpers/executionAuthority.js';

export function createResumeRun(bindings: SessionOrchestratorBindings) {
  const { deps } = bindings;
  const { db, redis, payloadStore, guardrailGate, manifestService } = deps;

  return async function resumeRun(params: Parameters<SessionOrchestrator['resumeRun']>[0]) {
    const now = Date.now();

    if (await isSessionCorrupt(redis, params.tenantId, params.runId)) {
      throw new Error(`Run ${params.runId} is stalled (state corrupt); clear quarantine to retry`);
    }

    const runResult = await getSessionStateSafe(redis, params.tenantId, params.runId);
    if (!runResult.ok) {
      throw new ControlConflictError('run_not_found', `Run ${params.runId} not found in Redis`);
    }
    const runState = runResult.state;
    if (runState.status !== 'PAUSED') {
      throw new ControlConflictError(
        'run_not_paused',
        `Run ${params.runId} is not paused (status: ${runState.status}) — ` +
          `it was already resumed or advanced by someone else.`,
        { observedStatus: runState.status },
      );
    }

    if (runState.delegationPauseSource === 'child_input' && runState.pausedChildSessionId) {
      if (runState.interruptRequested) {
        getOrchestratorLogger().info(
          `[resumeRun] Parent ${params.runId} has interruptRequested=true; ` +
            `refusing to route resume to child ${runState.pausedChildSessionId}. ` +
            `Cancelling child and parent.`,
        );

        // Cascade cancel to the paused child first.
        await addControlMessage(redis, {
          messageVersion: 1,
          type: 'cancel_run',
          tenantId: params.tenantId,
          runId: runState.pausedChildSessionId as SessionId,
          traceId: (runState.traceId ?? crypto.randomUUID()) as TraceId,
          idempotencyKey:
            `interrupt-resume-cascade:${params.runId}:${runState.pausedChildSessionId}` as IdempotencyKey,
          requestedAtMs: Date.now(),
        }).catch((cascadeErr: unknown) => {
          logOrchestratorError(
            `[resumeRun] Failed to cascade cancel to paused child during interrupt:`,
            cascadeErr,
            {
              tenantId: params.tenantId,
              runId: params.runId,
              childId: runState.pausedChildSessionId,
            },
          );
        });

        // Then cancel the parent itself. The interrupt flag means the user
        // does not want this run to continue.
        await bindings.cancelRun({ tenantId: params.tenantId, runId: params.runId });
        return { status: 'CANCELLED' as SessionStatus };
      }

      // 1. Canonical leave-child-input → back to WAITING_ON_CHILD.
      await leaveChildInputToWaiting(redis, params.tenantId, params.runId, {
        fromStatus: runState.status,
      });

      // 2. Emit status event on parent (UI sees transition to WAITING_ON_CHILD)
      await appendSessionEvent(redis, params.tenantId, params.runId, {
        eventId: generateEventId(),
        eventType: 'SessionResumed',
        timestamp: now,
        sessionId: params.runId,
        metadata: { routedToChildRun: runState.pausedChildSessionId },
      });
      await markSessionDirty(redis, params.tenantId, params.runId);

      await addControlMessage(redis, {
        messageVersion: 1,
        type: 'resume_run',
        tenantId: params.tenantId,
        runId: runState.pausedChildSessionId as SessionId,
        stepExecutionId: (runState.childPausedStepExecutionId ?? '') as StepExecutionId,
        inputRef: params.inputRef,
        traceId: params.traceId,
        idempotencyKey: `child-resume:${params.idempotencyKey}` as IdempotencyKey,
        requestedAtMs: Date.now(),
        ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
      });

      getOrchestratorLogger().debug(
        `[resumeRun] Routed resume to child run ${runState.pausedChildSessionId} ` +
          `(parent ${params.runId} → WAITING_ON_CHILD)`,
      );

      return { status: 'WAITING_ON_CHILD' as SessionStatus };
    }

    // CAS against the pause point: the run may have re-paused elsewhere between
    // the API check and here, and resuming the stale target would apply this
    // answer to a different question.
    if (
      runState.currentStepExecutionId &&
      runState.currentStepExecutionId !== params.stepExecutionId
    ) {
      throw new ControlConflictError(
        'resume_step_mismatch',
        `Run ${params.runId} is paused at a different step — this answer targets a pause ` +
          `that is no longer open.`,
        {
          observedStatus: runState.status,
          currentStepExecutionId: runState.currentStepExecutionId,
          requestedStepExecutionId: params.stepExecutionId,
        },
      );
    }

    const stepState = await getStepState(redis, params.tenantId, params.stepExecutionId);
    if (!stepState) throw new Error(`Step execution ${params.stepExecutionId} not found in Redis`);

    const agentDef = await fetchAgentDef(
      db,
      payloadStore,
      params.tenantId,
      runState.target,
      runState.agentVersion,
    );

    if (runState.dynamicSteps) {
      try {
        const dynamicSteps = JSON.parse(runState.dynamicSteps) as StepDefinition[];
        for (const ds of dynamicSteps) {
          const existingIdx = agentDef.steps.findIndex((s) => s.stepId === ds.stepId);
          if (existingIdx >= 0) {
            agentDef.steps[existingIdx] = ds;
          } else {
            agentDef.steps.push(ds);
          }
        }
      } catch {
        getOrchestratorLogger().debug('[resumeRun] Failed to parse dynamicSteps from Redis', {
          tenantId: params.tenantId,
          sessionId: params.runId,
        });
      }
    }

    const targetStepId = (
      runState.pauseType === 'interrupted' && runState.currentStepId
        ? runState.currentStepId
        : stepState.stepId
    ) as StepId;

    // Guardrail: on_user_message
    if (guardrailGate && params.inputRef) {
      const gr = await guardrailGate.check('on_user_message', params.inputRef, {
        tenantId: params.tenantId,
        runId: params.runId,
        target: runState.target,
      });
      if (!gr.passed && gr.action === 'block') {
        const { GuardrailBlockedError } = await import('../../GuardrailGate/index.js');
        throw new GuardrailBlockedError(gr.violations);
      }
    }

    const wasInterrupted = runState.pauseType === 'interrupted';

    const runUpdates: Partial<SessionHotState> & { sessionId: string } = {
      sessionId: params.runId,
      status: 'RUNNING',
      pauseReason: undefined,
      requestedInputRef: undefined,
      // Clear interrupt-related fields on resume (use empty strings / false —
      // undefined is skipped by serializeForHash and leaves stale values in Redis)
      interruptRequested: false,
      // Update voiceMode on every resume — allows toggling mid-conversation
      ...(params.voiceMode !== undefined ? { voiceMode: params.voiceMode } : {}),
    };

    let runtimeState = runState.runtimeState;
    let userMessageText: string | undefined;
    if (params.inputRef && runtimeState) {
      try {
        const userInput = await payloadStore.retrieve(params.inputRef);
        const newVariables = { ...runtimeState.variables };
        let variablesChanged = false;

        // If target step is agent turn, ensure chatInput overlay exists
        const targetStepDef = agentDef.steps.find((s) => s.stepId === targetStepId);
        if (targetStepDef?.operation === 'ai.agent.turn') {
          const chatVarId = agentChatInputVarId(targetStepId);
          const effectiveVars = getEffectiveStateVariables(agentDef, runState);
          if (!effectiveVars.some((v: { variableId: string }) => v.variableId === chatVarId)) {
            const overlay = ensureAgentChatInputOverlay(runState, targetStepId);
            runUpdates.variableDefsOverlay = serializeOverlay(overlay);
            getOrchestratorLogger().debug(
              `[resumeRun] Auto-created chatInput overlay for agent step ${targetStepId}`,
            );
          }
        }

        // Try to read resumeContract from the pause payload
        let resumeContract: ResumeInputContract | undefined;
        if (runState.requestedInputRef) {
          try {
            const pausePayload = (await payloadStore.retrieve(
              runState.requestedInputRef,
            )) as Record<string, unknown>;
            const rc = pausePayload['resumeContract'] as ResumeInputContract | undefined;
            if (rc?.mode) {
              resumeContract = rc;
            }
          } catch {
            /* best-effort — fall back to legacy */
          }
        }

        if (resumeContract) {
          const mapping = mapResumeInput(userInput, resumeContract);
          if ('error' in mapping) {
            console.warn(`[resumeRun] Resume input mapping failed: ${mapping.error}`);
          } else {
            for (const [varId, value] of Object.entries(mapping.variables)) {
              newVariables[varId] = {
                ref: { kind: 'inline' as const, value },
                updatedAtMs: now,
                updatedBy: {
                  stepExecutionId: params.stepExecutionId,
                  stepId: stepState.stepId,
                  actor: 'api' as const,
                },
                version: getVariableVersion(newVariables[varId]) + 1,
              };
              variablesChanged = true;
            }
            userMessageText = mapping.userMessage;

            if (mapping.configOverrides) {
              for (const [varId, value] of Object.entries(mapping.configOverrides)) {
                newVariables[varId] = {
                  ref: { kind: 'inline' as const, value },
                  updatedAtMs: now,
                  updatedBy: {
                    stepExecutionId: params.stepExecutionId,
                    stepId: stepState.stepId,
                    actor: 'api' as const,
                  },
                  version: getVariableVersion(newVariables[varId]) + 1,
                };
                variablesChanged = true;
              }
            }
          }
        } else {
          // Legacy fallback: match input keys against effective state variables
          const effectiveVars = getEffectiveStateVariables(agentDef, {
            ...runState,
            ...(runUpdates.variableDefsOverlay
              ? { variableDefsOverlay: runUpdates.variableDefsOverlay }
              : {}),
          });
          const inputObj =
            typeof userInput === 'object' && userInput !== null && !Array.isArray(userInput)
              ? (userInput as Record<string, unknown>)
              : {};

          for (const [key, value] of Object.entries(inputObj)) {
            const varDef = effectiveVars.find((v: { variableId: string }) => v.variableId === key);
            if (varDef) {
              newVariables[key] = {
                ref: { kind: 'inline' as const, value },
                updatedAtMs: now,
                updatedBy: {
                  stepExecutionId: params.stepExecutionId,
                  stepId: stepState.stepId,
                  actor: 'api' as const,
                },
                version: getVariableVersion(newVariables[key]) + 1,
              };
              variablesChanged = true;
            } else {
              console.warn(`[resumeRun] input key "${key}" not in effective variables — skipped`);
            }
          }

          userMessageText = extractUserMessageFromInput(inputObj, agentDef, runState);
        }

        if (variablesChanged) {
          runtimeState = {
            ...runtimeState,
            variables: newVariables,
            version: runtimeState.version + 1,
            updatedAtMs: now,
          };
          runUpdates.runtimeState = runtimeState;
        }
      } catch (err) {
        logOrchestratorError(`[resumeRun] error processing input:`, err, {
          tenantId: params.tenantId,
          runId: params.runId,
        });
      }
    }

    if (runtimeState) {
      const targetStepDef = agentDef.steps.find((s) => s.stepId === targetStepId);
      if (targetStepDef?.operation === 'ai.agent.turn') {
        const failuresVarKey = `ai.agent.toolFailures.${targetStepId}`;
        const signaturesVarKey = `ai.agent.recentCallSignatures.${targetStepId}`;
        const loopWarningVarKey = `ai.agent.loopWarning.${targetStepId}`;
        const hadCounters =
          runtimeState.variables[failuresVarKey] !== undefined ||
          runtimeState.variables[signaturesVarKey] !== undefined ||
          runtimeState.variables[loopWarningVarKey] !== undefined;
        if (hadCounters) {
          const newVars = { ...runtimeState.variables };
          delete newVars[failuresVarKey];
          delete newVars[signaturesVarKey];
          delete newVars[loopWarningVarKey];
          runtimeState = {
            ...runtimeState,
            variables: newVars,
            version: runtimeState.version + 1,
            updatedAtMs: now,
          };
          runUpdates.runtimeState = runtimeState;
        }
      }
    }

    if (wasInterrupted && runtimeState) {
      const targetStepDef = agentDef.steps.find((s) => s.stepId === targetStepId);
      if (targetStepDef?.operation === 'ai.agent.turn') {
        const interruptVarKey = `ai.agent.wasInterrupted.${targetStepId}`;
        const newVars = { ...runtimeState.variables };
        writeInlineVar(newVars, interruptVarKey, true, {
          nowMs: now,
          stepExecutionId: params.stepExecutionId,
          stepId: stepState.stepId,
        });
        runtimeState = {
          ...runtimeState,
          variables: newVars,
          version: runtimeState.version + 1,
          updatedAtMs: now,
        };
        runUpdates.runtimeState = runtimeState;
      }
    }

    // The same steer advances the conversation's clock. A resume carrying no
    // words — a tool result landing, a scheduled continuation — is execution
    // moving, not the conversation, and leaves the clock where it was.
    if (userMessageText) runUpdates.lastActivityAt = now;

    // A steer typed into the room is a message in it, so it takes the next
    // position — otherwise the person it was aimed at is never told it arrived.
    const resumeMessageSeq = userMessageText
      ? await takeRoomMessagePosition(
          redis,
          params.tenantId,
          params.runId,
          params.actorContext?.userId,
        )
      : undefined;

    // Authority is revalidated BEFORE the PAUSED→RUNNING transition commits:
    // refusing after it would leave a RUNNING session with no scheduled step —
    // a zombie — while the refusal tells the caller the run stayed paused.
    const authority =
      readEstablishedAuthority(runState) ??
      (params.actorContext
        ? buildAuthorityFromActor(params.actorContext, {
            spaceId: params.actorContext.spaceId ?? runState.spaceId ?? params.tenantId,
            establishedReason: 'start',
          })
        : undefined);
    if (authority) {
      const check = await revalidateAuthority(db, redis, params.tenantId, authority);
      if (!check.ok) {
        // The run genuinely stays paused. Refusing here leaves it exactly
        // where a human can restore access and resume, rather than failing
        // work that is still valid.
        throw new AuthorityLostError(check.reason, check.detail);
      }
    }

    const resumeRecoveryEvents = await buildRunStatusChangedRecoveryEvent(
      redis,
      params.tenantId,
      params.runId,
      'PAUSED',
      'RUNNING',
    );

    await atomicCompleteStep(
      redis,
      params.tenantId,
      { stepExecutionId: params.stepExecutionId },
      runUpdates,
      {
        eventId: generateEventId(),
        eventType: 'SessionResumed',
        timestamp: now,
        sessionId: params.runId,
        stepId: stepState.stepId,
        stepExecutionId: params.stepExecutionId,
        stepType: stepState.stepType,
        attempt: stepState.attempt,
        metadata: {
          ...(userMessageText ? { userMessage: userMessageText } : {}),
          ...(resumeMessageSeq !== undefined ? { messageSeq: resumeMessageSeq } : {}),
          ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
          // Control is asynchronous, so the outcome carries the id of the
          // command that caused it — otherwise a client watching the stream
          // cannot tell whether what it sees is its own action or someone
          // else's landing at the same moment.
          ...(params.idempotencyKey ? { commandId: params.idempotencyKey } : {}),
          ...(params.actorContext
            ? {
                actorUserId: params.actorContext.userId,
                ...(params.actorContext.displayName
                  ? { actorDisplayName: params.actorContext.displayName }
                  : {}),
              }
            : {}),
        },
      },
      undefined, // ttlSeconds
      resumeRecoveryEvents,
    );

    // The grant is short-lived and recompiled here, but it is recompiled for
    // the authority this run was established under — not for whoever happened
    // to resume it. Otherwise a shared run would silently execute with the
    // access of whoever last clicked, which is the confused deputy in both
    // directions: personal credentials borrowed, or capabilities widened.
    if (authority) {
      try {
        const { compileRunAccessGrant } = await import('@aflow/authz');
        const grant = await compileRunAccessGrant(
          {
            tenantId: params.tenantId,
            spaceId: authority.spaceId,
            spaceRole: authority.spaceRole,
            userId: authority.principalUserId,
            tenantRole: authority.tenantRole,
            grantReason: 'resume',
          },
          db,
        );
        await setRunAccessGrant(redis, params.tenantId, params.runId, grant);
      } catch (grantErr) {
        console.warn(
          `[SessionOrchestrator] Grant re-stamp failed on resume for run ${params.runId}:`,
          grantErr instanceof Error ? grantErr.message : String(grantErr),
        );
      }

      if (!runState.executionAuthorityJson) {
        await updateSessionState(redis, params.tenantId, params.runId, {
          executionAuthorityJson: JSON.stringify(authority),
        });
      }
    }

    // Who the agent is talking to now, which in a shared room is not
    // necessarily who opened it. Held apart from the execution authority
    // above: this changes with every turn, that one never does.
    if (params.actorContext) {
      await updateSessionState(redis, params.tenantId, params.runId, {
        actorContextJson: JSON.stringify(params.actorContext),
      });
    }

    manifestService?.updateStatus(params.runId, params.tenantId, 'RUNNING');

    const targetStepDef = agentDef.steps.find((s) => s.stepId === targetStepId);
    if (
      targetStepDef &&
      (targetStepDef.operation === 'user.input.request' ||
        targetStepDef.operation === 'user.interaction.ask' ||
        targetStepDef.operation === 'user.interaction.approve' ||
        targetStepDef.operation === 'agent.control.signal_blocked')
    ) {
      // Store the user's input as the step output
      const outputRef = params.inputRef || '';

      // Reset step status from PAUSED → STARTED so applyResult's idempotency
      // guard doesn't discard the SUCCEEDED result ("already PAUSED" check).
      const { updateStepState } = await import('@aflow/redis');
      await updateStepState(redis, params.tenantId, params.stepExecutionId, {
        sessionId: params.runId,
        status: 'STARTED',
      });

      // Resolve approval decision when this is an approve step. If the resume
      // payload is malformed or absent, fall back to SUCCEEDED (safer to let
      // the agent see the raw payload than to silently fail an approved call).
      let approvalRejected = false;
      let approvalComment: string | undefined;
      if (targetStepDef.operation === 'user.interaction.approve' && params.inputRef) {
        try {
          const data = await payloadStore.retrieve(params.inputRef);
          if (data && typeof data === 'object' && 'decision' in data) {
            const decision = (data as { decision?: unknown }).decision;
            if (decision === 'rejected') {
              approvalRejected = true;
              const comment = (data as { comment?: unknown }).comment;
              if (typeof comment === 'string') approvalComment = comment;
            }
          }
        } catch {
          /* malformed payload — treat as approved (legacy behavior) */
        }
      }

      if (approvalRejected) {
        const errorPayload = {
          code: 'approval_denied',
          message: approvalComment
            ? `User rejected approval: ${approvalComment}`
            : 'User rejected approval',
          timestamp: new Date().toISOString(),
        };
        const errorRef = `inline:${Buffer.from(JSON.stringify(errorPayload)).toString('base64')}`;
        await addStepResult(redis, {
          messageVersion: 1,
          tenantId: params.tenantId,
          sessionId: params.runId,
          stepExecutionId: params.stepExecutionId,
          parentStepExecutionId: null,
          stepId: targetStepId,
          stepType: targetStepDef.stepType,
          operationId: targetStepDef.operation as OperationId,
          attempt: stepState.attempt,
          idempotencyKey: `user-resume:${params.runId}:${params.stepExecutionId}` as IdempotencyKey,
          status: 'FAILED',
          errorRef,
          error: errorPayload,
          resolvedInputRef: stepState.inputRef || '',
          durationMs: 0,
          traceId: params.traceId,
          finishedAtMs: Date.now(),
        });
      } else {
        await addStepResult(redis, {
          messageVersion: 1,
          tenantId: params.tenantId,
          sessionId: params.runId,
          stepExecutionId: params.stepExecutionId,
          parentStepExecutionId: null,
          stepId: targetStepId,
          stepType: targetStepDef.stepType,
          operationId: targetStepDef.operation as OperationId,
          attempt: stepState.attempt,
          idempotencyKey: `user-resume:${params.runId}:${params.stepExecutionId}` as IdempotencyKey,
          status: 'SUCCEEDED',
          outputRef,
          resolvedInputRef: stepState.inputRef || '',
          durationMs: 0,
          traceId: params.traceId,
          finishedAtMs: Date.now(),
        });
      }

      return { status: 'RUNNING' as SessionStatus };
    }

    // Write-approval pause (Plan 253): a gated api-call step parked as a
    // `write_approval` PAUSE is driven ONLY by the grant the authenticated
    // Action Center resolve handler wrote — never by the resume input, which a
    // scheduled `{}` wake or an agent-driven resume could forge. Reading the
    // grant here (keyed by run + the exact call's requestHash) is the single
    // authority: approved → re-dispatch (the executor gate finds the same
    // grant and proceeds); denied → fail the step so the agent sees a tool
    // error; absent → this resume is not a human decision, so leave the step
    // paused rather than implicitly approving it.
    if (targetStepDef && runState.requestedInputRef) {
      const writeApprovalReq = await readWriteApprovalRequest(
        payloadStore,
        runState.requestedInputRef,
      );
      if (writeApprovalReq) {
        const grant = await getWriteApprovalGrant(
          redis,
          params.tenantId,
          params.runId,
          writeApprovalReq.requestHash,
        );

        if (!grant) {
          // No authenticated decision on record — do not re-dispatch (which
          // would re-gate anyway) and do not approve. Stay paused.
          return { status: 'PAUSED' as SessionStatus };
        }

        if (grant.decision === 'denied') {
          const errorPayload = {
            code: 'write_approval_denied',
            // `permission` classification is load-bearing: toAgentToolError maps
            // it to retry:false, so the calling agent sees a firm denial rather
            // than a retryable system error and does not re-issue the call. The
            // message is self-contained because the agent envelope is lossy, and
            // carries the operator's reason (the highest-signal part — it tells
            // the agent WHAT to change) when one was given.
            classification: 'permission' as const,
            retryable: false,
            message:
              'This write was denied by a human operator in the Action Center' +
              (grant.reason ? `. Operator's reason: "${grant.reason}"` : '') +
              '. It is not a system error and will NOT succeed on retry — do not call this ' +
              'endpoint again with the same request. Use the operator’s reason to decide what to ' +
              'do: adjust and propose a different action, or tell the user it was declined and ask ' +
              'how to proceed.',
            timestamp: new Date().toISOString(),
          };
          const errorRef = `inline:${Buffer.from(JSON.stringify(errorPayload)).toString('base64')}`;
          // Reset PAUSED → STARTED so applyResult's idempotency guard accepts
          // the synthetic FAILED result (a PAUSED step's result is discarded).
          const { updateStepState } = await import('@aflow/redis');
          await updateStepState(redis, params.tenantId, params.stepExecutionId, {
            sessionId: params.runId,
            status: 'STARTED',
          });
          await addStepResult(redis, {
            messageVersion: 1,
            tenantId: params.tenantId,
            sessionId: params.runId,
            stepExecutionId: params.stepExecutionId,
            parentStepExecutionId: null,
            stepId: targetStepId,
            stepType: targetStepDef.stepType,
            operationId: targetStepDef.operation as OperationId,
            attempt: stepState.attempt,
            idempotencyKey:
              `write-approval-resume:${params.runId}:${params.stepExecutionId}` as IdempotencyKey,
            status: 'FAILED',
            errorRef,
            error: errorPayload,
            resolvedInputRef: stepState.inputRef || '',
            durationMs: 0,
            traceId: params.traceId,
            finishedAtMs: Date.now(),
          });
          return { status: 'RUNNING' as SessionStatus };
        }
        // grant.decision === 'approved' → fall through to scheduleStep. The
        // re-dispatched executor reads the same run+requestHash grant and sends.
      }
    }

    const effectiveInputRef = chooseResumeInputRef({
      operation: targetStepDef?.operation,
      stepStatus: stepState.status,
      stepInputRef: stepState.inputRef,
      paramsInputRef: params.inputRef,
      runRequestedInputRef: runState.requestedInputRef,
    });

    await bindings.scheduleStep({
      context: {
        tenantId: params.tenantId,
        runId: params.runId,
        agentDefinition: agentDef,
        traceId: params.traceId,
      },
      stepId: targetStepId,
      inputRef: effectiveInputRef,
    });

    return { status: 'RUNNING' as SessionStatus };
  };
}
