import {
  type TenantId,
  type StepExecutionId,
  type StepId,
  type OperationId,
  type TraceId,
  type StepDefinition,
  type AflowError,
  calculateRetryDelay,
  resolveNextStep,
  toFailedRunDisplay,
  toFailedRunDisplayFromUnknown,
  toAgentToolError,
  AflowErrorSchema,
  isMcpCredentialFailure,
  extractMcpCredentialBlock,
  type McpCredentialBlock,
} from '@aflow/schemas';
import { isDraftRepair } from '@aflow/schemas';
import {
  scheduleShardTimer,
  markSessionDirty,
  type StepHotState,
  type SessionEvent,
  getSessionState,
  getSessionStateSafe,
  getStepState,
  updateSessionState,
  isSessionCorrupt,
  atomicCompleteStep,
  markRunInactive,
  removeBarrierWatchdog,
} from '@aflow/redis';
import { removeBarrierWatchdogOnClear } from './barrierWatchdogCleanup.js';
import {
  clearSpaceContextCache,
  bumpSpaceContextGen,
  stepTypeInvalidatesSpaceContext,
} from '../helpers/spaceContext.js';
import { getVariableVersion, readInlineVar, writeInlineVar } from '../helpers/runtimeState.js';
import { failureIsAgentFacing } from './agentFacingFailure.js';
import { applyHistoryUpdate } from '../handlers/applyHistoryUpdate.js';
import { applyAgentDecision } from '../handlers/applyAgentDecision.js';
import { recoverFailedAgentDecision } from '../handlers/agentDecisionRecovery.js';
import { applyStepSucceeded } from '../handlers/applyStepSucceeded.js';
import { routeSessionPauseToSubscribers } from '../handlers/pausedSessionRouting.js';
import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
} from '../handlers/enqueueDelegationCompletion.js';
import { routeRunnerTerminalToHarness } from '../../cybernetic/WorkflowRunHarness.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestratorBindings } from '../lifecycle/context.js';
import {
  waitForInput as stepServiceWaitForInput,
  failStep as stepServiceFailStep,
} from '../../StepService/index.js';
import type { ScheduleStepParams, SessionOrchestrator, ToolResultSummary } from '../types.js';
import { generateEventId } from '../helpers/ids.js';
import { fetchAgentDef } from '../helpers/fetchAgentDef.js';
import { resolveMatchedToolCallIdForToolFailure } from '../helpers/resolveToolCallId.js';
import { simulatedFulfillmentEventMeta } from '../../simulatedStepMarking.js';
import { resolveOAuthConsentBlockedOn } from './oauthConsentPause.js';
import { resolveWriteApprovalBlockedOn } from './writeApprovalPause.js';

export function createApplyResult(bindings: SessionOrchestratorBindings) {
  const { deps, harnessDeps, failRunWithCleanup } = bindings;
  const { db, redis, payloadStore, guardrailGate, manifestService, snapshotService } = deps;
  return async function applyResult(
    params: Parameters<SessionOrchestrator['applyResult']>[0],
  ): Promise<void> {
    const { result } = params;
    const now = Date.now();
    const fulfillmentMeta = simulatedFulfillmentEventMeta(result.simulatedFulfillment);

    if (!result.sessionId) {
      throw new Error(
        `[SessionOrchestrator] applyResult received a result without sessionId (workflowExecution=${JSON.stringify(result.workflowExecution)}). ` +
          'Workflow-task results should be routed by the harness intercept, not through applyResult. This indicates a missed Phase 2 wire-up.',
      );
    }
    // From here on, sessionId is guaranteed present.
    const sessionId = result.sessionId;

    if (await isSessionCorrupt(redis, result.tenantId, result.sessionId)) {
      console.warn(
        `[SessionOrchestrator] Run ${result.sessionId} is corrupt — cascading as FAILED to parent`,
      );
      try {
        const { failCorruptSessionAndCascade } = await import('../handlers/failCorruptSession.js');
        await failCorruptSessionAndCascade(redis, result.tenantId, result.sessionId);
      } catch (cascadeErr) {
        logOrchestratorError(
          `[applyResult] Failed to cascade corrupt run ${result.sessionId}:`,
          cascadeErr,
          { tenantId: result.tenantId, sessionId: result.sessionId },
        );
      }
      return; // Result discarded; cascade has fired (or failed loudly).
    }

    const stepState = await getStepState(redis, result.tenantId, result.stepExecutionId);
    if (!stepState) throw new Error(`Step execution ${result.stepExecutionId} not found in Redis`);

    const runResult = await getSessionStateSafe(redis, result.tenantId, result.sessionId);
    if (!runResult.ok) {
      if (runResult.kind === 'corrupt') return; // Already handled above
      throw new Error(`Run ${result.sessionId} not found in Redis`);
    }
    const runState = runResult.state;

    if (runState.status === 'PAUSED' && runState.pauseReason === 'interrupted') {
      getOrchestratorLogger().info(
        `[applyResult] Run ${result.sessionId} is PAUSED+interrupted — dropping late result for step ${result.stepExecutionId}`,
      );
      // Redelivery lands here when the crash window hit between the interrupt
      // pause committing and the ack — the only retry this pause will ever get,
      // so route it (idempotent for a subscriber that already heard it).
      await routeSessionPauseToSubscribers(
        {
          redis,
          payloadStore,
          db,
          ...(guardrailGate ? { guardrailGate } : {}),
          ...(manifestService ? { manifestService } : {}),
        },
        {
          tenantId: result.tenantId,
          runId: result.sessionId,
          traceId: result.traceId,
          runState,
          contractRef: runState.requestedInputRef ?? null,
          pauseReason: 'Session was interrupted mid-flow',
        },
      );
      return;
    }

    // Idempotency: skip if already terminal.
    if (
      stepState.status === 'SUCCEEDED' ||
      stepState.status === 'FAILED' ||
      stepState.status === 'PAUSED'
    ) {
      getOrchestratorLogger().info(
        `[applyResult] Step ${result.stepExecutionId} already ${stepState.status}, discarding late result`,
      );
      if (runState.parentSessionId) {
        try {
          await enqueuePendingAndReconcile({
            redis,
            payloadStore,
            tenantId: result.tenantId,
            childRunId: result.sessionId,
            reason: `applyResult:late_${stepState.status.toLowerCase()}`,
            ...(runState.parentStepExecutionId
              ? {
                  parentRunId: runState.parentSessionId,
                  parentStepExecutionId: runState.parentStepExecutionId,
                }
              : {}),
            ...(result.error
              ? {
                  childError: {
                    code: result.error.code,
                    message: result.error.message,
                    ...(result.error.classification
                      ? { classification: result.error.classification }
                      : {}),
                    ...(result.error.retryable !== undefined
                      ? { retryable: result.error.retryable }
                      : {}),
                  },
                }
              : {}),
            agentDefLoader: (tenantId, target, agentVersion) =>
              fetchAgentDef(db, payloadStore, tenantId, target, agentVersion),
          });
        } catch (reconcileErr) {
          if (isDelegationUpsertFailure(reconcileErr)) throw reconcileErr;
          logOrchestratorError(
            `[applyResult] Failed late-result delegation reconciliation for child ${result.sessionId}:`,
            reconcileErr,
            { tenantId: result.tenantId, sessionId: result.sessionId },
          );
        }
      }
      return;
    }

    // Early-exit: if the run is already terminal or cancelled, skip processing.
    // This prevents redundant work on retries and ensures cancelled runs stop immediately.
    if (
      runState.status === 'FAILED' ||
      runState.status === 'SUCCEEDED' ||
      runState.status === 'CANCELLED'
    ) {
      return;
    }

    const stepUpdates: Partial<StepHotState> & { stepExecutionId: string } = {
      stepExecutionId: result.stepExecutionId,
      status: result.status as StepHotState['status'],
      endedAt: now,
      outputRef: result.outputRef ?? undefined,
      errorRef: result.errorRef ?? undefined,
    };

    if (stepTypeInvalidatesSpaceContext(result.stepType)) {
      await clearSpaceContextCache(redis, result.tenantId, result.sessionId).catch(() => {});
      // Bump the per-space generation so OTHER live runs rebuild their cached
      // context on the next turn (this run already cleared its own above).
      if (runState.spaceId) await bumpSpaceContextGen(redis, result.tenantId, runState.spaceId);
    }

    // ── Safety boundary ────────────────────────────────────────────────────────
    // All result processing is wrapped in a categorical try/catch. If ANY error
    // escapes the specific handlers below, we fail the run rather than leaving
    // it silently stuck in RUNNING forever.
    try {
      // ── PAUSED ────────────────────────────────────────────────────────────────

      if (result.status === 'PAUSED') {
        const agentDef = await fetchAgentDef(
          db,
          payloadStore,
          result.tenantId,
          runState.target,
          runState.agentVersion,
        );

        // Merge dynamic steps for PAUSED path (agent-invoked steps may not be in flow def)
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
            getOrchestratorLogger().debug(
              '[SessionOrchestrator] Failed to parse dynamicSteps from Redis',
              {
                tenantId: result.tenantId,
                sessionId: result.sessionId,
              },
            );
          }
        }

        const stepDef =
          agentDef.steps.find((s) => s.stepId === result.stepId) ??
          ({
            stepId: result.stepId as StepId,
            stepType: result.stepType,
            operation: result.operationId,
            name: result.stepId,
            config: {},
            tags: [],
            optional: false,
            onSuccess: { next: [] },
            onFailure: { next: [] },
          } as StepDefinition);
        // For PAUSED results, prefer deriving required variables from the step definition
        // (especially for user.interaction.ask) so the UI can resume by variableId.
        const pauseRequiredVars: Array<{
          variableId: string;
          name?: string;
          description?: string;
          typeSchema?: Record<string, unknown>;
          semanticType?: string;
          required: true;
        }> = [];
        let pausePrompt: string | undefined;

        if (stepDef.operation === 'user.interaction.ask') {
          const cfg = stepDef.config as { prompt?: unknown; fields?: unknown };
          if (typeof cfg.prompt === 'string') pausePrompt = cfg.prompt;
          if (Array.isArray(cfg.fields)) {
            for (const f of cfg.fields as unknown[]) {
              const field = f as Record<string, unknown> | null | undefined;
              const fieldName = typeof field?.['name'] === 'string' ? field['name'] : undefined;
              if (!fieldName) continue;
              const fieldType = typeof field?.['type'] === 'string' ? field['type'] : undefined;
              const typeSchema =
                fieldType === 'string'
                  ? { type: 'string' }
                  : fieldType === 'number'
                    ? { type: 'number' }
                    : fieldType === 'boolean'
                      ? { type: 'boolean' }
                      : undefined;
              pauseRequiredVars.push({
                variableId: fieldName,
                name: typeof field?.['label'] === 'string' ? field['label'] : fieldName,
                ...(typeof field?.['description'] === 'string'
                  ? { description: field['description'] }
                  : {}),
                ...(typeSchema ? { typeSchema } : {}),
                ...(fieldType !== undefined ? { semanticType: fieldType } : {}),
                required: true,
              });
            }
          }
        }

        // OAuth consent pause (Plan 185 §9.3, Plane A): an executor that cannot
        // resolve a pinned OAuth owner/token parks the step with an
        // `oauth_consent` request payload. Carry the typed `needs_oauth_consent`
        // cause into the session so the Action Center surfaces a recoverable
        // "connect your account" prompt instead of a FAILED step.
        const consentBlockedOn = await resolveOAuthConsentBlockedOn(
          payloadStore,
          result.requestedInputRef,
        );

        // Write-approval pause (Plan 253): an executor that resolved a gated
        // write endpoint with no approval on record parks the step with a
        // `write_approval` request payload. Carry the typed
        // `needs_write_approval` cause so the Action Center surfaces an
        // "approve this write" prompt instead of a FAILED step.
        const writeApprovalBlockedOn = await resolveWriteApprovalBlockedOn(
          payloadStore,
          result.requestedInputRef,
          result.stepExecutionId,
        );

        // First-class subflow-wait: when the session is already WAITING_ON_CHILD
        // (set by handleResumeInline / handleDelegateInline), skip waitForInput
        // entirely — the session state is already correct and routing through
        // waitForInput would overwrite it with pauseReason='input_required',
        // making the web UI think it can resume the parent (the root cause of
        // the "Tool execution was interrupted" bug).
        const isSubflowWaiting = runState.status === 'WAITING_ON_CHILD';

        if (isSubflowWaiting) {
          // Update step state to PAUSED and emit a SessionPaused event so
          // SSE consumers know the session entered WAITING_ON_CHILD. Without
          // this event, the UI stays visually RUNNING after the inline handler
          // sets the status directly.
          const waitingEvent: SessionEvent = {
            eventId: generateEventId(),
            eventType: 'SessionPaused',
            timestamp: now,
            sessionId: result.sessionId,
            stepId: result.stepId,
            stepExecutionId: result.stepExecutionId,
            stepType: result.stepType,
            attempt: result.attempt,
            metadata: {
              stepName: stepDef.name ?? stepDef.stepId,
              operationId: stepDef.operation,
              pauseType: 'subflow_waiting',
              subflowWaiting: true,
            },
          };
          await atomicCompleteStep(
            redis,
            result.tenantId,
            {
              stepExecutionId: result.stepExecutionId,
              status: 'PAUSED' as const,
              endedAt: now,
              ...(result.outputRef ? { outputRef: result.outputRef } : {}),
              ...(result.errorRef ? { errorRef: result.errorRef } : {}),
            },
            { sessionId: result.sessionId }, // no session state changes — already WAITING_ON_CHILD
            [waitingEvent],
          );
          await markSessionDirty(redis, result.tenantId, result.sessionId);
        } else {
          await stepServiceWaitForInput(
            { redis, payloadStore },
            {
              tenantId: result.tenantId as TenantId,
              runId: result.sessionId,
              agentDef,
              traceId: result.traceId as TraceId,
              stepDef,
              stepExecutionId: result.stepExecutionId as StepExecutionId,
              attempt: result.attempt,
              runState,
            },
            pauseRequiredVars,
            {
              ...(pausePrompt ? { prompt: pausePrompt } : {}),
              ...(result.requestedInputRef
                ? { preBuiltRequestedInputRef: result.requestedInputRef }
                : {}),
              ...(consentBlockedOn
                ? { pauseType: 'oauth_consent', blockedOn: consentBlockedOn }
                : writeApprovalBlockedOn
                  ? { pauseType: 'approval', blockedOn: writeApprovalBlockedOn }
                  : {}),
              stepStateUpdates: {
                status: 'PAUSED' as const,
                endedAt: now,
                ...(result.outputRef ? { outputRef: result.outputRef } : {}),
                ...(result.errorRef ? { errorRef: result.errorRef } : {}),
              },
            },
          );
        }

        await routeSessionPauseToSubscribers(
          { redis, payloadStore, db },
          {
            tenantId: result.tenantId,
            runId: result.sessionId,
            traceId: result.traceId,
            runState,
            contractRef: result.requestedInputRef ?? null,
            pauseReason: pausePrompt ?? `Step ${result.stepId} paused awaiting input`,
          },
        );
        return;
      }

      // ── FAILED ────────────────────────────────────────────────────────────────

      if (result.status === 'FAILED') {
        const agentDef = await fetchAgentDef(
          db,
          payloadStore,
          result.tenantId,
          runState.target,
          runState.agentVersion,
        );

        // Merge dynamic steps from Redis (same as SUCCEEDED path)
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
            getOrchestratorLogger().debug(
              '[SessionOrchestrator] Failed to parse dynamicSteps from Redis',
              {
                tenantId: result.tenantId,
                sessionId: result.sessionId,
              },
            );
          }
        }

        // Use find (not getStepDefinition which throws) — agent-invoked dynamic
        // steps may not be in dynamicSteps or the flow definition (e.g., subflow
        // steps created by applyAgentDecision). Fall back to a minimal def so the
        // result can still be processed and routed.
        const stepDef = agentDef.steps.find((s) => s.stepId === result.stepId) ?? {
          stepId: result.stepId as StepId,
          stepType: result.stepType,
          operation: result.operationId,
          name: result.stepId,
          config: {},
          tags: [],
          optional: false,
          onSuccess: { next: [] },
          onFailure: { next: [] },
        };

        // Recover an agent-fixable invalid decision (tool-args violation) as
        // bounded guided-retry-then-pause; a subagent falls through to onFailure.
        if (
          await recoverFailedAgentDecision({
            redis,
            payloadStore,
            db,
            result,
            stepDef,
            agentDef,
            runState,
            stepState,
            scheduleStep: bindings.scheduleStep,
            now,
          })
        ) {
          return;
        }

        const retryPolicy = stepDef.retryPolicy ?? {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 30000,
          backoffStrategy: 'exponential' as const,
          backoffMultiplier: 2,
          jitterFraction: 0.1,
          retryableErrorCodes: [],
          retryableClassifications: ['timeout', 'rate_limit', 'provider', 'transient'],
        };

        const err = result.error as
          { retryable?: boolean; classification?: string } | null | undefined;
        const shouldRetry =
          result.attempt < retryPolicy.maxAttempts &&
          err?.retryable === true &&
          (retryPolicy.retryableClassifications as readonly string[]).includes(
            err.classification ?? 'internal',
          );

        if (shouldRetry) {
          const stepErrorObj = result.error as
            { code?: string; message?: string } | null | undefined;
          // shouldRetry requires err?.retryable === true, so err is non-null here
          const retryErr = err;
          await stepServiceFailStep(
            { redis, payloadStore },
            {
              tenantId: result.tenantId as TenantId,
              runId: result.sessionId,
              agentDef,
              traceId: result.traceId as TraceId,
              stepDef,
              stepExecutionId: result.stepExecutionId as StepExecutionId,
              attempt: result.attempt,
              runState: runState,
            },
            {
              code: stepErrorObj?.code ?? 'STEP_FAILED',
              message: stepErrorObj?.message ?? 'Step failed (retrying)',
            },
            {
              ...(result.errorRef ? { errorRef: result.errorRef } : {}),
              ...(retryErr.classification != null
                ? { classification: retryErr.classification as AflowError['classification'] }
                : {}),
              retryable: true,
              willRetry: true,
              nextAttempt: result.attempt + 1,
              ...(fulfillmentMeta ? { eventMeta: fulfillmentMeta } : {}),
            },
          );
          await scheduleShardTimer(redis, {
            tenantId: result.tenantId,
            sessionId: result.sessionId,
            stepExecutionId: result.stepExecutionId,
            stepId: result.stepId as StepId,
            operationId: result.operationId as OperationId,
            stepType: result.stepType,
            reason: 'retry',
            attempt: result.attempt + 1,
            inputRef: stepState.inputRef,
            traceId: result.traceId,
            dueAtMs: now + calculateRetryDelay(retryPolicy, result.attempt),
          });
          return;
        }

        const errorObj = result.error as
          | {
              code?: string;
              message?: string;
              classification?: string;
              retryable?: boolean;
              details?: unknown;
            }
          | null
          | undefined;

        const failStepCtx = {
          tenantId: result.tenantId as TenantId,
          runId: result.sessionId,
          agentDef,
          traceId: result.traceId as TraceId,
          stepDef,
          stepExecutionId: result.stepExecutionId as StepExecutionId,
          attempt: result.attempt,
          runState: runState,
        };
        const failError = {
          code: errorObj?.code ?? 'STEP_FAILED',
          message: errorObj?.message ?? 'Step failed',
        };

        // Check if this step has an onFailure route — if so, continue to the next
        // step instead of failing the entire run.
        let failureNextStepId = resolveNextStep(stepDef, 'failure');
        // Guard against accidental self-loops (e.g. ai-1 -> ai-1) which can cause
        // infinite rescheduling on persistent failures.
        if (failureNextStepId === result.stepId) {
          getOrchestratorLogger().warn(
            `Step ${result.stepId} onFailure resolved to itself; treating as terminal failure`,
          );
          failureNextStepId = null;
        }

        if (failureNextStepId) {
          getOrchestratorLogger().debug(
            `Step ${result.stepId} failed but has onFailure route → ${failureNextStepId}`,
          );

          const errorSummary = {
            failedStepId: result.stepId,
            failedOperation: result.operationId,
            errorCode: errorObj?.code,
            errorMessage: errorObj?.message,
            errorClassification: errorObj?.classification,
          };
          const errorInputRef = `inline:${Buffer.from(JSON.stringify(errorSummary)).toString('base64')}`;

          let toolResultsForAgent: ToolResultSummary[] | undefined;
          const nextStepDef = agentDef.steps.find((s) => s.stepId === failureNextStepId);
          if (failureIsAgentFacing(nextStepDef)) {
            const isDynamic = stepDef.tags.includes('dynamic');
            const toolIdTag = isDynamic
              ? stepDef.tags.find((t) => t.startsWith('_toolId:'))
              : undefined;
            const parentTag = isDynamic
              ? stepDef.tags.find((t) => t.startsWith('parent:'))
              : undefined;
            const attributionStepId = toolIdTag
              ? toolIdTag.slice('_toolId:'.length)
              : parentTag
                ? parentTag.slice('parent:'.length)
                : stepDef.stepId;

            const matchedToolCallId = await resolveMatchedToolCallIdForToolFailure({
              payloadStore,
              stepDef,
              stepExecutionId: result.stepExecutionId,
              tenantId: result.tenantId,
              sessionId: result.sessionId,
              failureNextStepId,
              attributionStepId,
              runtimeState: runState.runtimeState,
              nextStepDef,
            });

            const aflowError: AflowError = {
              code: errorObj?.code ?? 'STEP_FAILED',
              message: errorObj?.message ?? 'Step failed',
              classification: (errorObj?.classification ??
                'internal') as AflowError['classification'],
              retryable: false,
              // Structured recovery data (availableActions, currentVersion, …)
              // must survive this re-projection — toAgentToolError bounds it.
              ...(errorObj?.details !== undefined
                ? { details: errorObj.details as NonNullable<AflowError['details']> }
                : {}),
              timestamp: new Date().toISOString(),
            };
            const agentError = toAgentToolError(aflowError);

            if (isMcpCredentialFailure({ code: errorObj?.code })) {
              let credentialBlock: McpCredentialBlock | null = null;
              if (result.errorRef) {
                try {
                  const fullError = await payloadStore.retrieve(result.errorRef);
                  const parsed = AflowErrorSchema.safeParse(fullError);
                  if (parsed.success) credentialBlock = extractMcpCredentialBlock(parsed.data);
                } catch {
                  // Best-effort: a missing/unreadable error payload still yields
                  // a marker (reason-only) so the pause reclassifies.
                }
              }
              await updateSessionState(redis, result.tenantId as TenantId, result.sessionId, {
                pendingCredentialBlock: credentialBlock ?? {
                  reason: errorObj?.message ?? 'MCP credential or binding could not be resolved.',
                },
              });
            }

            toolResultsForAgent = [
              {
                toolCallId: matchedToolCallId,
                toolId: attributionStepId,
                name: attributionStepId,
                status: 'FAILED',
                operationId: stepDef.operation,
                error: agentError,
              },
            ];

            const runtimeState = runState.runtimeState;
            if (runtimeState) {
              const failuresVarKey = `ai.agent.toolFailures.${failureNextStepId}`;
              const failureMsgsVarKey = `ai.agent.toolFailureMessages.${failureNextStepId}`;
              const totalFailuresVarKey = `ai.agent.toolTotalFailures.${failureNextStepId}`;
              const toolFailures = readInlineVar(
                runtimeState,
                failuresVarKey,
                {} as Record<string, number>,
              );
              const toolFailureMessages = readInlineVar(
                runtimeState,
                failureMsgsVarKey,
                {} as Record<string, string>,
              );
              const toolTotalFailures = readInlineVar(
                runtimeState,
                totalFailuresVarKey,
                {} as Record<string, number>,
              );
              const prevCount = toolFailures[attributionStepId] ?? 0;
              const prevMessage = toolFailureMessages[attributionStepId];
              // Consecutive counter: resets when the error message changes so a
              // sequence of distinct validation errors (agent making progress) does
              // not trigger the identical-failure hard pause.
              const currentMessage =
                typeof agentError?.message === 'string' ? agentError.message.slice(0, 500) : '';
              const isNewError = prevMessage !== undefined && prevMessage !== currentMessage;
              toolFailures[attributionStepId] = isNewError ? 1 : prevCount + 1;
              toolFailureMessages[attributionStepId] = currentMessage;
              // Total counter: never resets — guards against cycling between a set
              // of errors (A→B→A→B…) which would otherwise bypass the consecutive check.
              // A submission built on a later draft that fails on strictly fewer
              // counts is not cycling, it is converging, and charging it here
              // ends a run that is getting closer with every turn. Repetition
              // still pays: same revision, or no fewer problems, is not repair.
              const repairing = isDraftRepair(prevMessage, currentMessage);
              if (!repairing) {
                toolTotalFailures[attributionStepId] =
                  (toolTotalFailures[attributionStepId] ?? 0) + 1;
              }
              const newVars = { ...runtimeState.variables };
              writeInlineVar(newVars, failuresVarKey, toolFailures, {
                nowMs: now,
                stepExecutionId: result.stepExecutionId,
                stepId: result.stepId,
              });
              writeInlineVar(newVars, failureMsgsVarKey, toolFailureMessages, {
                nowMs: now,
                stepExecutionId: result.stepExecutionId,
                stepId: result.stepId,
              });
              writeInlineVar(newVars, totalFailuresVarKey, toolTotalFailures, {
                nowMs: now,
                stepExecutionId: result.stepExecutionId,
                stepId: result.stepId,
              });
              const updatedRuntimeState = {
                ...runtimeState,
                variables: newVars,
                version: runtimeState.version + 1,
                updatedAtMs: now,
              };
              await updateSessionState(redis, result.tenantId as TenantId, result.sessionId, {
                runtimeState: updatedRuntimeState,
              });
            }
          }

          await stepServiceFailStep({ redis, payloadStore }, failStepCtx, failError, {
            ...(result.errorRef ? { errorRef: result.errorRef } : {}),
            // Carry the typed error class through to the step event — without
            // it, buildUserError falls back to "System Error / try again",
            // mislabeling deterministic validation rejects as transient
            // (e.g. the Coach's propose-gate teaching errors would render
            // as system errors in the operator timeline).
            ...(errorObj?.classification != null
              ? { classification: errorObj.classification as AflowError['classification'] }
              : {}),
            ...(errorObj?.retryable != null ? { retryable: errorObj.retryable } : {}),
            ...(fulfillmentMeta ? { eventMeta: fulfillmentMeta } : {}),
          });

          // ── Parallel barrier (failure path) ──────────────────────────────
          // Same logic as the success path: if there's a pending count for
          // the agent step, decrement and accumulate the failure result.
          // Only schedule the agent turn when the last result arrives.
          let barrierHold = false;
          let allResults: ToolResultSummary[] | undefined;
          if (toolResultsForAgent && nextStepDef?.operation === 'ai.agent.turn') {
            const pendingCountKey = `ai.agent.pendingToolCallCount.${failureNextStepId}`;
            const pendingResultsKey = `ai.agent.pendingToolResults.${failureNextStepId}`;
            let runtimeState = runState.runtimeState;
            const countVar = runtimeState?.variables[pendingCountKey] as
              { ref?: { kind: string; value?: unknown } } | undefined;
            const currentCount =
              countVar?.ref?.kind === 'inline' && typeof countVar.ref.value === 'number'
                ? countVar.ref.value
                : 0;

            if (currentCount > 0 && runtimeState) {
              const newCount = currentCount - 1;
              const resultsVar = runtimeState.variables[pendingResultsKey] as
                { ref?: { kind: string; value?: unknown } } | undefined;
              const accumulated: ToolResultSummary[] =
                resultsVar?.ref?.kind === 'inline' && Array.isArray(resultsVar.ref.value)
                  ? (resultsVar.ref.value as ToolResultSummary[])
                  : [];
              accumulated.push(...toolResultsForAgent);

              const newVars = { ...runtimeState.variables };
              newVars[pendingCountKey] = {
                ref: { kind: 'inline', value: newCount },
                updatedAtMs: now,
                updatedBy: { actor: 'orchestrator', stepId: result.stepId },
                version: (countVar ? getVariableVersion(countVar) : 0) + 1,
              };
              newVars[pendingResultsKey] = {
                ref: { kind: 'inline', value: accumulated },
                updatedAtMs: now,
                updatedBy: { actor: 'orchestrator', stepId: result.stepId },
                version: accumulated.length,
              };
              runtimeState = {
                ...runtimeState,
                variables: newVars,
                version: runtimeState.version + 1,
                updatedAtMs: now,
              };
              await updateSessionState(redis, result.tenantId, result.sessionId, {
                runtimeState,
              });

              if (newCount > 0) {
                barrierHold = true;
              } else {
                allResults = accumulated;
                await removeBarrierWatchdogOnClear(redis, removeBarrierWatchdog, {
                  tenantId: result.tenantId,
                  runId: result.sessionId,
                  agentStepId: failureNextStepId,
                  newCount,
                });
              }
            }
          }

          if (barrierHold) {
            return;
          }

          const scheduleParams: ScheduleStepParams = {
            context: {
              tenantId: result.tenantId,
              runId: result.sessionId,
              agentDefinition: agentDef,
              traceId: result.traceId,
              ...(runState.spaceId ? { spaceId: runState.spaceId } : {}),
            },
            stepId: failureNextStepId,
            inputRef: errorInputRef,
          };
          if (allResults) {
            scheduleParams.lastToolResults = allResults;
          } else if (toolResultsForAgent) {
            scheduleParams.lastToolResults = toolResultsForAgent;
          }
          try {
            await bindings.scheduleStep(scheduleParams);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logOrchestratorError(
              `[SessionOrchestrator] Failed to schedule onFailure route ${failureNextStepId} ` +
                `for run ${result.sessionId}: ${errMsg}`,
              new Error(errMsg),
              { tenantId: result.tenantId, sessionId: result.sessionId, failureNextStepId },
            );
            await failRunWithCleanup(
              result.tenantId,
              result.sessionId,
              'ONFAILURE_SCHEDULING_ERROR',
              `Step ${result.stepId} failed and its onFailure route could not be scheduled: ${errMsg}`,
            );
          }
          return;
        }

        // No onFailure route — fail the entire run
        const classification = errorObj?.classification as AflowError['classification'] | undefined;
        const runFailure = classification
          ? toFailedRunDisplay(
              {
                code: errorObj?.code ?? 'STEP_FAILED',
                message: errorObj?.message ?? 'Step failed',
                classification,
                retryable: false,
                timestamp: new Date().toISOString(),
              },
              {
                runId: result.sessionId,
                traceId: result.traceId,
                stepId: result.stepId,
                attempt: result.attempt,
                includeDebug: true,
              },
            )
          : toFailedRunDisplayFromUnknown(new Error(errorObj?.message ?? 'Step failed'), {
              runId: result.sessionId,
              traceId: result.traceId,
              stepId: result.stepId,
              attempt: result.attempt,
              includeDebug: true,
            });

        const failureLogError = errorObj ?? new Error(failError.message);

        logOrchestratorError(
          `[SessionOrchestrator] Run ${result.sessionId} failed at step ${result.stepId} (${result.operationId})`,
          failureLogError,
          {
            tenantId: result.tenantId,
            sessionId: result.sessionId,
            stepExecutionId: result.stepExecutionId,
            stepId: result.stepId,
            operationId: result.operationId,
            ...(classification ? { errorClassification: classification } : {}),
          },
        );

        const flowRunFailedEvent: SessionEvent = {
          eventId: generateEventId(),
          eventType: 'SessionFailed',
          timestamp: now,
          sessionId: result.sessionId,
          stepId: result.stepId,
          stepExecutionId: result.stepExecutionId,
          stepType: result.stepType,
          attempt: result.attempt,
          errorRef: result.errorRef ?? undefined,
          metadata: {
            stepName: stepDef.name ?? result.stepId,
            operationId: result.operationId,
            errorCode: errorObj?.code,
            errorMessage: runFailure.errorMessage,
            errorClassification: errorObj?.classification,
            ...(runFailure.userError ? { userError: runFailure.userError } : {}),
          },
        };

        await stepServiceFailStep({ redis, payloadStore }, failStepCtx, failError, {
          ...(result.errorRef ? { errorRef: result.errorRef } : {}),
          ...(classification != null ? { classification } : {}),
          runStateUpdates: {
            status: 'FAILED' as const,
            endedAt: now,
            ...(result.errorRef ? { errorRef: result.errorRef } : {}),
          },
          additionalEvents: [flowRunFailedEvent],
          eventMeta: {
            errorClassification: errorObj?.classification,
            ...fulfillmentMeta,
          },
        });

        await markRunInactive(redis, result.tenantId, result.sessionId).catch(() => {});
        manifestService?.updateStatus(result.sessionId, result.tenantId, 'FAILED');

        if (runState.workflowExecution !== undefined) {
          try {
            await routeRunnerTerminalToHarness(
              harnessDeps,
              {
                tenantId: result.tenantId,
                traceId: result.traceId,
                workflowExecution: runState.workflowExecution,
              },
              'FAILED',
              {
                errorRef: result.errorRef ?? null,
                ...(errorObj?.message ? { failureReason: errorObj.message } : {}),
              },
            );
          } catch (harnessErr) {
            logOrchestratorError(
              `[applyResult] Runner-terminal FAILED harness route failed for ${result.sessionId}:`,
              harnessErr,
              {
                tenantId: result.tenantId,
                sessionId: result.sessionId,
                workflowExecution: runState.workflowExecution,
              },
            );
          }
          return;
        }

        if (runState.parentSessionId) {
          try {
            await enqueuePendingAndReconcile({
              redis,
              tenantId: result.tenantId,
              childRunId: result.sessionId,
              reason: 'applyResult:failed',
              ...(runState.parentStepExecutionId
                ? {
                    parentRunId: runState.parentSessionId,
                    parentStepExecutionId: runState.parentStepExecutionId,
                  }
                : {}),
              childError: {
                code: errorObj?.code ?? 'STEP_FAILED',
                message: errorObj?.message ?? 'Step failed',
                classification: errorObj?.classification ?? 'internal',
                ...(errorObj?.retryable !== undefined ? { retryable: errorObj.retryable } : {}),
              },
            });
          } catch (resumeErr) {
            if (isDelegationUpsertFailure(resumeErr)) throw resumeErr;
            logOrchestratorError(
              `[applyResult] Failed to resume parent after child ${result.sessionId} failed:`,
              resumeErr,
              { tenantId: result.tenantId, sessionId: result.sessionId },
            );
          }
        }
        return;
      }

      // ── SUCCEEDED ─────────────────────────────────────────────────────────────

      const agentDef = await fetchAgentDef(
        db,
        payloadStore,
        result.tenantId,
        runState.target,
        runState.agentVersion,
      );

      // Merge dynamic steps (from agent.control.run_step) stored in Redis hot state.
      // These are not persisted to Postgres, so they must be re-injected on every
      // result consumer iteration. Dynamic entries may override static steps
      // (e.g., run_step's patched onSuccess routing to a dynamic step).
      if (runState.dynamicSteps) {
        try {
          const dynamicSteps = JSON.parse(runState.dynamicSteps) as StepDefinition[];
          for (const ds of dynamicSteps) {
            const existingIdx = agentDef.steps.findIndex((s) => s.stepId === ds.stepId);
            if (existingIdx >= 0) {
              agentDef.steps[existingIdx] = ds; // Override static def
            } else {
              agentDef.steps.push(ds); // New dynamic step
            }
          }
        } catch {
          getOrchestratorLogger().debug(
            '[SessionOrchestrator] Failed to parse dynamicSteps from Redis',
            {
              tenantId: result.tenantId,
              sessionId: result.sessionId,
            },
          );
        }
      }

      const stepDef = agentDef.steps.find((s) => s.stepId === result.stepId);

      let currentRuntimeState = runState.runtimeState ?? {
        schemaVersion: 1 as const,
        variables: {},
        version: 0,
        updatedAtMs: now,
      };

      if (stepDef && result.outputRef) {
        currentRuntimeState = await applyHistoryUpdate(
          payloadStore,
          stepDef,
          stepState,
          result.outputRef,
          result.tenantId,
          result.sessionId,
          result.stepExecutionId,
          currentRuntimeState,
          now,
        );
      }

      if (stepDef?.operation === 'ai.agent.turn' && result.outputRef) {
        let handled: boolean;
        try {
          handled = await applyAgentDecision({
            redis,
            payloadStore,
            db,
            result: {
              ...result,
              sessionId,
              outputRef: result.outputRef ?? null,
              nowMs: now,
              usage: result.usage ?? undefined,
            },
            runHotState: runState,
            stepDef,
            stepState,
            agentDef,
            stepUpdates,
            currentRuntimeState,
            scheduleStep: bindings.scheduleStep,
            ...(guardrailGate ? { guardrailGate } : {}),
          });
        } catch (err) {
          // A durable delegation-upsert failure must reach ResultConsumer
          // un-acked so redelivery retries it — failing the run here would
          // destroy a pause that replay can still deliver.
          if (isDelegationUpsertFailure(err)) throw err;
          const errMsg = err instanceof Error ? err.message : String(err);
          logOrchestratorError(
            `[SessionOrchestrator] Agent decision failed for run ${result.sessionId}: ${errMsg}`,
            err instanceof Error ? err : new Error(errMsg),
            {
              tenantId: result.tenantId,
              sessionId: result.sessionId,
              stepExecutionId: result.stepExecutionId,
            },
          );
          const errorCode =
            errMsg.includes('validation failed') || errMsg.includes('Invalid enum')
              ? 'INVALID_TOOL_CALL'
              : 'AGENT_SCHEDULING_ERROR';
          await failRunWithCleanup(
            result.tenantId,
            result.sessionId,
            errorCode,
            `Agent tool scheduling failed: ${errMsg}`,
          );
          return;
        }
        if (handled) {
          const freshState = await getSessionState(redis, result.tenantId, result.sessionId);
          if (freshState?.status === 'PAUSED') {
            // One routing pass for every pause a handled agent decision can
            // produce (guardrail escalation, budget, pause_for_input, the
            // decision-side interrupt) — the producers themselves do not route.
            await routeSessionPauseToSubscribers(
              {
                redis,
                payloadStore,
                db,
                ...(guardrailGate ? { guardrailGate } : {}),
                ...(manifestService ? { manifestService } : {}),
              },
              {
                tenantId: result.tenantId,
                runId: result.sessionId,
                traceId: result.traceId,
                runState: freshState,
                contractRef: freshState.requestedInputRef ?? null,
                pauseReason: freshState.pauseReason ?? 'Agent paused awaiting input',
              },
            );
            return;
          }
          if (runState.workflowExecution !== undefined) {
            try {
              if (freshState?.status === 'FAILED') {
                // Harness blocked the agent (TOOL_FAILURE_LIMIT, AGENT_LOOP_DETECTED, etc.).
                // Propagate as a failed task so the workflow run fails with a descriptive error
                // rather than appearing as a mysterious pause to Helmsman.
                let failureReason: string | undefined;
                if (freshState.errorRef?.startsWith('inline:')) {
                  try {
                    const decoded = JSON.parse(
                      Buffer.from(freshState.errorRef.slice('inline:'.length), 'base64').toString(
                        'utf8',
                      ),
                    ) as Record<string, unknown>;
                    if (typeof decoded['message'] === 'string') failureReason = decoded['message'];
                  } catch {
                    // best-effort decode
                  }
                }
                await routeRunnerTerminalToHarness(
                  harnessDeps,
                  {
                    tenantId: result.tenantId,
                    traceId: result.traceId,
                    workflowExecution: runState.workflowExecution,
                  },
                  'FAILED',
                  {
                    errorRef: freshState.errorRef ?? null,
                    ...(failureReason !== undefined ? { failureReason } : {}),
                  },
                );
              }
            } catch (harnessErr) {
              logOrchestratorError(
                `[applyResult] Runner-terminal agent_pause harness route failed for ${result.sessionId}:`,
                harnessErr,
                {
                  tenantId: result.tenantId,
                  sessionId: result.sessionId,
                  workflowExecution: runState.workflowExecution,
                },
              );
            }
            return;
          }
          return;
        }
      }

      // Normal step success
      try {
        await applyStepSucceeded({
          redis,
          payloadStore,
          db,
          result: {
            ...result,
            sessionId,
            outputRef: result.outputRef ?? null,
            nowMs: now,
            usage: result.usage ?? undefined,
            simulatedFulfillment: result.simulatedFulfillment,
          },
          runHotState: runState,
          stepDef,
          stepState,
          agentDef,
          stepUpdates,
          currentRuntimeState,
          scheduleStep: bindings.scheduleStep,
          ...(guardrailGate ? { guardrailGate } : {}),
        });
      } catch (err) {
        if (isDelegationUpsertFailure(err)) throw err;
        const errMsg = err instanceof Error ? err.message : String(err);
        logOrchestratorError(
          `[SessionOrchestrator] Step succeeded but next-step scheduling failed ` +
            `for run ${result.sessionId}, step ${result.stepId}: ${errMsg}`,
          err instanceof Error ? err : new Error(errMsg),
          { tenantId: result.tenantId, sessionId: result.sessionId, stepId: result.stepId },
        );
        const errorCode =
          errMsg.includes('validation failed') || errMsg.includes('Invalid enum')
            ? 'STEP_INPUT_VALIDATION_ERROR'
            : 'NEXT_STEP_SCHEDULING_ERROR';
        await failRunWithCleanup(
          result.tenantId,
          result.sessionId,
          errorCode,
          `Step ${result.stepId} succeeded but scheduling the next step failed: ${errMsg}`,
        );
      }
    } catch (unhandledErr) {
      if (isDelegationUpsertFailure(unhandledErr)) throw unhandledErr;
      // Categorical safety net: if anything above threw without being caught
      // by the specific handlers, fail the run rather than leaving it stuck.
      const errMsg = unhandledErr instanceof Error ? unhandledErr.message : String(unhandledErr);
      logOrchestratorError(
        `[SessionOrchestrator] CRITICAL: Unhandled error in applyResult for ` +
          `run ${result.sessionId}, step ${result.stepExecutionId} (${result.operationId}): ${errMsg}`,
        unhandledErr,
        {
          tenantId: result.tenantId,
          sessionId: result.sessionId,
          stepExecutionId: result.stepExecutionId,
          operationId: result.operationId,
        },
      );
      // failRun is best-effort here — if Redis is also down, the error propagates
      // to ResultConsumer which will not ack (allowing retry when Redis recovers).
      await failRunWithCleanup(
        result.tenantId,
        result.sessionId,
        'ORCHESTRATOR_INTERNAL_ERROR',
        `Orchestrator failed to process result for step ${result.stepId}: ${errMsg}`,
      );
    }

    if (manifestService || snapshotService) {
      let postStatus: string | undefined;
      try {
        const postResult = await getSessionStateSafe(redis, result.tenantId, result.sessionId);
        if (postResult.ok) {
          postStatus = postResult.state.status;
        }
      } catch {
        // Best-effort — both manifest and snapshot are eventually consistent
      }

      // Manifest sync: catch SUCCEEDED/PAUSED transitions not handled at call site
      if (manifestService && postStatus) {
        if (postStatus === 'SUCCEEDED' || postStatus === 'PAUSED') {
          manifestService.updateStatus(result.sessionId, result.tenantId, postStatus);
        }
      }

      // Snapshot trigger: force on major transitions, periodic otherwise
      if (snapshotService) {
        if (postStatus === 'PAUSED') {
          // PAUSED is a natural quiescence point — force snapshot regardless of event count
          snapshotService.forceSnapshot(result.tenantId, result.sessionId);
        } else {
          snapshotService.maybeSnapshot(result.tenantId, result.sessionId);
        }
      }
    }
  };
}
