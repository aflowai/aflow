/**
 * StepService — single place for the three core step outcomes.
 *
 * Every step execution eventually produces one of:
 *   complete → StepSucceeded event + output mapping + next-step resolution
 *   fail    → StepFailed event + retry/onFailure routing
 *   waitForInput → FlowRunPaused event with missingVariables
 *
 * This module is the ONLY place that translates outcomes into durable
 * state changes + run events. Handlers return StepOutcome; StepService
 * does the rest.
 */
import type { AflowError, SessionBlockedOn, StepUsageBreakdown } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../lib/orchestratorLogger.js';
import { toUserFacingError, fromUnknownError } from '@aflow/schemas';
import {
  atomicCompleteStep,
  type SessionHotState,
  type StepHotState,
  type SessionEvent,
} from '@aflow/redis';
import {
  buildStepCompletedRecoveryEvents,
  buildRunPausedAfterStepSucceededRecoveryEvents,
} from '../SessionOrchestrator/helpers/recoveryEmitter.js';
import type {
  StepContext,
  StepServiceDeps,
  RequiredVariable,
  ResultHandlerOutput,
  PostOutcomeAction,
} from './types.js';

function generateEventId(): string {
  return crypto.randomUUID();
}

// ============================================================================
// resolveAndGate — pre-execution input validation
// ============================================================================

/**
 * Check if all required state variables are present before executing a step.
 *
 * @returns `null` if all variables are resolved, or a `PostOutcomeAction`
 *          (paused) if the run was paused for missing input.
 */
export async function resolveAndGate(
  deps: StepServiceDeps,
  ctx: StepContext,
  unresolvedVarIds: string[],
): Promise<PostOutcomeAction | null> {
  if (unresolvedVarIds.length === 0) return null;

  const { getEffectiveStateVariables, buildRequiredVariables } =
    await import('../SessionOrchestrator/helpers/runtimeState.js');
  const effectiveVars = getEffectiveStateVariables(ctx.agentDef, ctx.runState);

  const requiredUnresolved = unresolvedVarIds.filter((varId) => {
    const varDef = effectiveVars.find((v: { variableId: string }) => v.variableId === varId);
    if (!varDef) return true;
    return (varDef as { required?: boolean }).required !== false;
  });

  if (requiredUnresolved.length === 0) return null;

  getOrchestratorLogger().debug(
    `[StepService] Step ${ctx.stepDef.stepId} has unresolved required state vars: ${requiredUnresolved.join(', ')} — pausing run`,
  );

  const requiredVars = buildRequiredVariables(requiredUnresolved, ctx.agentDef, ctx.runState);
  const varNames = requiredVars
    .map((v: { name?: string; variableId: string }) => v.name ?? v.variableId)
    .join(', ');

  return waitForInput(deps, ctx, requiredVars, {
    prompt: `Please provide: ${varNames}`,
  });
}

// ============================================================================
// waitForInput — the ONE canonical pause mechanism
// ============================================================================

/**
 * Pause the run because a step needs user input.
 *
 * This is the ONLY way to pause a run. All step types (agent, user, gating)
 * funnel through here. It:
 *   1. Builds the requestedInputRef payload (missingVariables + prompt)
 *   2. Updates run status to PAUSED with pauseReason='input_required'
 *   3. Emits a FlowRunPaused event with missingVariables in metadata
 */
export async function waitForInput(
  deps: StepServiceDeps,
  ctx: StepContext,
  requiredVariables: RequiredVariable[],
  opts?: {
    prompt?: string;
    eventMeta?: Record<string, unknown>;
    runStateUpdates?: Partial<SessionHotState>;
    runtimeState?: SessionHotState['runtimeState'];
    runtimeStatePatch?: SessionEvent['runtimeStatePatch'];
    additionalEvents?: SessionEvent[];
    /** Pre-built ref from executor — bypasses payload construction */
    preBuiltRequestedInputRef?: string;
    /** Extra step state updates (e.g. status already set by caller) */
    stepStateUpdates?: Partial<StepHotState>;
    pauseType?: string;
    resumeSchema?: Record<string, unknown>;
    blockedOn?: SessionBlockedOn;
  },
): Promise<PostOutcomeAction> {
  const now = Date.now();

  // The web app expects missingVariables as structured objects (with variableId, name, etc.)
  // so it can resume by sending `{ [variableId]: value }`. Never emit only string IDs.
  const normalizeMissingVariables = (vars: RequiredVariable[]) =>
    vars.map((v) => ({
      variableId: v.variableId,
      ...(v.name ? { name: v.name } : {}),
      ...(v.description ? { description: v.description } : {}),
      ...(v.typeSchema ? { typeSchema: v.typeSchema } : {}),
      ...(v.semanticType ? { semanticType: v.semanticType } : {}),
      ...(v.responseOptions ? { responseOptions: v.responseOptions } : {}),
      required: true,
    }));

  // If the executor supplied a pre-built requestedInputRef, attempt to hydrate it so
  // we can still populate FlowRunPaused metadata with structured missingVariables.
  let hydratedPrompt: string | undefined;
  let hydratedMissingVariables:
    | Array<{
        variableId: string;
        name?: string;
        description?: string;
        typeSchema?: Record<string, unknown>;
        semanticType?: string;
        required?: boolean;
      }>
    | undefined;
  let hydratedPayloadKind: string | undefined;
  let hydratedHitlFields:
    | {
        placement?: string;
        kind?: string;
        title?: string;
        description?: string;
        reviewData?: unknown;
        inputSchema?: Record<string, unknown>;
        uiHints?: Record<string, unknown>;
      }
    | undefined;

  if (opts?.preBuiltRequestedInputRef) {
    try {
      let parsed: Record<string, unknown> | null = null;
      if (opts.preBuiltRequestedInputRef.startsWith('inline:')) {
        const raw = Buffer.from(opts.preBuiltRequestedInputRef.slice('inline:'.length), 'base64')
          .toString('utf8')
          .trim();
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } else {
        parsed = (await deps.payloadStore.retrieve(opts.preBuiltRequestedInputRef)) as Record<
          string,
          unknown
        >;
      }
      if (parsed) {
        if (typeof parsed['prompt'] === 'string') hydratedPrompt = parsed['prompt'];
        if (Array.isArray(parsed['missingVariables'])) {
          hydratedMissingVariables = parsed['missingVariables'] as RequiredVariable[];
        }
        if (typeof parsed['payloadKind'] === 'string') {
          hydratedPayloadKind = parsed['payloadKind'];
        }
        const hitl: NonNullable<typeof hydratedHitlFields> = {};
        if (parsed['placement'] === 'chat_inline') hitl.placement = 'chat_inline';
        const kindRaw = parsed['kind'];
        if (kindRaw === 'input' || kindRaw === 'approval') hitl.kind = kindRaw;
        if (typeof parsed['title'] === 'string') hitl.title = parsed['title'];
        if (typeof parsed['description'] === 'string') {
          hitl.description = parsed['description'];
        }
        if (parsed['reviewData'] !== undefined) hitl.reviewData = parsed['reviewData'];
        const inputSchemaRaw = parsed['inputSchema'];
        if (inputSchemaRaw && typeof inputSchemaRaw === 'object') {
          hitl.inputSchema = inputSchemaRaw as Record<string, unknown>;
        }
        const uiHintsRaw = parsed['uiHints'];
        if (uiHintsRaw && typeof uiHintsRaw === 'object') {
          hitl.uiHints = uiHintsRaw as Record<string, unknown>;
        }
        if (Object.keys(hitl).length > 0) hydratedHitlFields = hitl;
      }
    } catch {
      // Best-effort hydration only
    }
  }

  const effectivePrompt = opts?.prompt ?? hydratedPrompt;
  const missingVariablesForEvent =
    requiredVariables.length > 0
      ? normalizeMissingVariables(requiredVariables)
      : hydratedMissingVariables;

  let requestedInputRef: string;
  if (opts?.preBuiltRequestedInputRef) {
    requestedInputRef = opts.preBuiltRequestedInputRef;
  } else {
    const normalizedMissing = normalizeMissingVariables(requiredVariables);

    const isSingleVar = requiredVariables.length === 1;
    const resumeContract = isSingleVar
      ? {
          reason: 'input_required' as const,
          mode: 'primary' as const,
          stepId: ctx.stepDef.stepId,
          targetVariableId: requiredVariables[0]?.variableId,
          requiredFields: normalizedMissing,
          ...(effectivePrompt ? { prompt: effectivePrompt } : {}),
        }
      : {
          reason: 'input_required' as const,
          mode: 'fields' as const,
          stepId: ctx.stepDef.stepId,
          requiredFields: normalizedMissing,
          ...(effectivePrompt ? { prompt: effectivePrompt } : {}),
        };

    const requestedInputPayload: Record<string, unknown> = {
      reason: 'input_required',
      stepId: ctx.stepDef.stepId,
      missingVariables: normalizedMissing, // legacy compat
      resumeContract,
      ...(effectivePrompt ? { prompt: effectivePrompt } : {}),
    };
    requestedInputRef = `inline:${Buffer.from(JSON.stringify(requestedInputPayload)).toString('base64')}`;
  }

  const runUpdates: Partial<SessionHotState> & { sessionId: string } = {
    sessionId: ctx.runId,
    status: 'PAUSED',
    currentStepId: ctx.stepDef.stepId,
    currentStepExecutionId: ctx.stepExecutionId,
    pauseReason: 'input_required' as SessionHotState['pauseReason'],
    requestedInputRef,
    ...(opts?.pauseType ? { pauseType: opts.pauseType } : {}),
    ...(opts?.pauseType
      ? {
          pauseMetadataJson: JSON.stringify({
            pauseType: opts.pauseType,
            ...(opts.resumeSchema ? { resumeSchema: { schema: opts.resumeSchema } } : {}),
          }),
        }
      : {}),
    ...opts?.runStateUpdates,
  };

  if (opts?.runtimeState) {
    runUpdates.runtimeState = opts.runtimeState;
  }

  const pauseEvent: SessionEvent = {
    eventId: generateEventId(),
    eventType: 'SessionPaused',
    timestamp: now,
    sessionId: ctx.runId,
    stepId: ctx.stepDef.stepId,
    stepExecutionId: ctx.stepExecutionId,
    stepType: ctx.stepDef.stepType,
    attempt: ctx.attempt,
    runtimeStatePatch: opts?.runtimeStatePatch,
    requestedInputRef,
    metadata: {
      stepName: ctx.stepDef.name ?? ctx.stepDef.stepId,
      operationId: ctx.stepDef.operation,
      pauseReason: 'input_required',
      ...(missingVariablesForEvent ? { missingVariables: missingVariablesForEvent } : {}),
      ...(effectivePrompt ? { prompt: effectivePrompt } : {}),
      ...(opts?.pauseType ? { pauseType: opts.pauseType } : {}),
      ...(opts?.resumeSchema ? { resumeSchema: opts.resumeSchema } : {}),
      ...(opts?.blockedOn ? { blockedOn: opts.blockedOn } : {}),
      ...(hydratedPayloadKind ? { payloadKind: hydratedPayloadKind } : {}),
      ...(hydratedHitlFields ?? {}),
      ...opts?.eventMeta,
    },
  };

  const allEvents: SessionEvent[] = [...(opts?.additionalEvents ?? []), pauseEvent];

  const pauseRunStatePatch: Record<string, unknown> = { status: 'PAUSED' };
  const pauseClearedFields: string[] = [];
  for (const [key, value] of Object.entries(runUpdates)) {
    if (key === 'sessionId' || key === 'status' || key === 'runtimeState') continue;
    if (value === undefined) {
      pauseClearedFields.push(key);
    } else {
      pauseRunStatePatch[key] = value;
    }
  }

  const stepStaysSucceeded = opts?.stepStateUpdates?.status === 'SUCCEEDED';
  const succeededOutputRef = opts?.stepStateUpdates?.outputRef;
  const recoveryEvents = stepStaysSucceeded
    ? await buildRunPausedAfterStepSucceededRecoveryEvents(
        deps.redis,
        ctx.tenantId,
        ctx.runId,
        ctx.stepExecutionId,
        succeededOutputRef !== undefined ? { outputRef: succeededOutputRef } : {},
        pauseRunStatePatch,
        pauseClearedFields,
      )
    : await buildStepCompletedRecoveryEvents(
        deps.redis,
        ctx.tenantId,
        ctx.runId,
        ctx.stepExecutionId,
        'PAUSED',
        { pauseReason: 'input_required', requestedInputRef },
        {
          from: 'RUNNING',
          to: 'PAUSED',
          runStatePatch: pauseRunStatePatch,
          ...(pauseClearedFields.length > 0 ? { clearedRunStateFields: pauseClearedFields } : {}),
        },
      );

  await atomicCompleteStep(
    deps.redis,
    ctx.tenantId,
    { stepExecutionId: ctx.stepExecutionId, ...opts?.stepStateUpdates },
    runUpdates,
    allEvents,
    undefined,
    recoveryEvents,
  );

  return { kind: 'paused', requestedInputRef };
}

// ============================================================================
// completeStep — the ONE canonical completion mechanism
// ============================================================================

/**
 * Mark a step as successfully completed and emit events.
 *
 * This is the ONLY way to complete a step. It:
 *   1. Marks the step as SUCCEEDED in hot state
 *   2. Applies runtime state updates (output mapping done by handler/caller)
 *   3. Emits StepSucceeded event (+ any additional events)
 *   4. Returns the next-step resolution for FlowExecution to schedule
 */
export async function completeStep(
  deps: StepServiceDeps,
  ctx: StepContext,
  opts?: {
    outputRef?: string;
    runStateUpdates?: Partial<SessionHotState>;
    runtimeState?: SessionHotState['runtimeState'];
    runtimeStatePatch?: SessionEvent['runtimeStatePatch'];
    additionalEvents?: SessionEvent[];
    eventMeta?: Record<string, unknown>;
    usage?: StepUsageBreakdown;
  },
): Promise<void> {
  const now = Date.now();

  const stepUpdates: Partial<StepHotState> & { stepExecutionId: string } = {
    stepExecutionId: ctx.stepExecutionId,
    status: 'SUCCEEDED',
    endedAt: now,
    ...(opts?.outputRef ? { outputRef: opts.outputRef } : {}),
  };

  const runUpdates: Partial<SessionHotState> & { sessionId: string } = {
    sessionId: ctx.runId,
    ...opts?.runStateUpdates,
  };

  if (opts?.runtimeState) {
    runUpdates.runtimeState = opts.runtimeState;
  }

  const stepSucceededEvent: SessionEvent = {
    eventId: generateEventId(),
    eventType: 'StepSucceeded',
    timestamp: now,
    sessionId: ctx.runId,
    stepId: ctx.stepDef.stepId,
    stepExecutionId: ctx.stepExecutionId,
    stepType: ctx.stepDef.stepType,
    attempt: ctx.attempt,
    outputRef: opts?.outputRef,
    runtimeStatePatch: opts?.runtimeStatePatch,
    usage: opts?.usage,
    metadata: {
      stepName: ctx.stepDef.name ?? ctx.stepDef.stepId,
      operationId: ctx.stepDef.operation,
      ...opts?.eventMeta,
    },
  };

  const allEvents: SessionEvent[] = [...(opts?.additionalEvents ?? []), stepSucceededEvent];

  // Build recovery events for step completion
  const recoveryEvents = await buildStepCompletedRecoveryEvents(
    deps.redis,
    ctx.tenantId,
    ctx.runId,
    ctx.stepExecutionId,
    'SUCCEEDED',
    { outputRef: opts?.outputRef },
  );

  await atomicCompleteStep(
    deps.redis,
    ctx.tenantId,
    stepUpdates,
    runUpdates,
    allEvents,
    undefined,
    recoveryEvents,
  );
}

// ============================================================================
// failStep — the ONE canonical failure mechanism
// ============================================================================

/**
 * Mark a step as failed and emit events.
 *
 * This is the ONLY way to fail a step. It:
 *   1. Marks the step as FAILED in hot state
 *   2. Emits StepFailed event
 *   3. Optionally emits FlowRunFailed if this is a terminal failure
 */
export async function failStep(
  deps: StepServiceDeps,
  ctx: StepContext,
  error: { code: string; message: string; details?: unknown },
  opts?: {
    errorRef?: string;
    willRetry?: boolean;
    nextAttempt?: number;
    classification?: AflowError['classification'];
    retryable?: boolean;
    runStateUpdates?: Partial<SessionHotState>;
    additionalEvents?: SessionEvent[];
    eventMeta?: Record<string, unknown>;
  },
): Promise<void> {
  const now = Date.now();

  const stepUpdates: Partial<StepHotState> & { stepExecutionId: string } = {
    stepExecutionId: ctx.stepExecutionId,
    status: 'FAILED',
    endedAt: now,
    ...(opts?.errorRef ? { errorRef: opts.errorRef } : {}),
  };

  const runUpdates: Partial<SessionHotState> & { sessionId: string } = {
    sessionId: ctx.runId,
    ...opts?.runStateUpdates,
  };

  const userError = buildUserError(error, opts?.classification, opts?.retryable, {
    runId: ctx.runId,
    stepId: ctx.stepDef.stepId,
    attempt: ctx.attempt,
  });

  const stepFailedEvent: SessionEvent = {
    eventId: generateEventId(),
    eventType: 'StepFailed',
    timestamp: now,
    sessionId: ctx.runId,
    stepId: ctx.stepDef.stepId,
    stepExecutionId: ctx.stepExecutionId,
    stepType: ctx.stepDef.stepType,
    attempt: ctx.attempt,
    ...(opts?.errorRef ? { errorRef: opts.errorRef } : {}),
    metadata: {
      stepName: ctx.stepDef.name ?? ctx.stepDef.stepId,
      operationId: ctx.stepDef.operation,
      errorCode: error.code,
      errorMessage: error.message,
      userError,
      ...(opts?.willRetry ? { willRetry: true, nextAttempt: opts.nextAttempt } : {}),
      ...opts?.eventMeta,
    },
  };

  const allEvents: SessionEvent[] = [...(opts?.additionalEvents ?? []), stepFailedEvent];

  // Build recovery events for step failure
  // Check if run status is changing (terminal failure)
  const runStatusChanged = opts?.runStateUpdates?.status
    ? { from: 'RUNNING', to: opts.runStateUpdates.status }
    : undefined;
  const recoveryEvents = await buildStepCompletedRecoveryEvents(
    deps.redis,
    ctx.tenantId,
    ctx.runId,
    ctx.stepExecutionId,
    'FAILED',
    { errorRef: opts?.errorRef },
    runStatusChanged,
  );

  await atomicCompleteStep(
    deps.redis,
    ctx.tenantId,
    stepUpdates,
    runUpdates,
    allEvents,
    undefined,
    recoveryEvents,
  );

  // Forward StepFailed to parent for unified timeline rendering
  try {
    const { forwardEventToParent } =
      await import('../SessionOrchestrator/handlers/forwardChildEvent.js');
    await forwardEventToParent(deps.redis, ctx.tenantId, ctx.runId, stepFailedEvent);
  } catch {
    // Best-effort forwarding
  }
}

// ============================================================================
// applyOutputAndComplete — output mapping + completion in one shot
// ============================================================================

/**
 * Apply output mapping for a completed step and then mark it complete.
 *
 * Convenience function that:
 *   1. Calls applyOutputMapping from runtimeState helpers
 *   2. Builds the runtime state patch for events
 *   3. Delegates to completeStep
 */
export async function applyOutputAndComplete(
  deps: StepServiceDeps,
  ctx: StepContext,
  currentRuntimeState: NonNullable<SessionHotState['runtimeState']>,
  opts?: {
    outputRef?: string;
    skipOutputMapping?: boolean;
    isTerminalStep?: boolean;
    runStateUpdates?: Partial<SessionHotState>;
    additionalEvents?: SessionEvent[];
    eventMeta?: Record<string, unknown>;
  },
): Promise<{
  updatedRuntimeState: NonNullable<SessionHotState['runtimeState']>;
}> {
  const { applyOutputMapping } = await import('../SessionOrchestrator/helpers/runtimeState.js');

  const now = Date.now();
  let updatedState = currentRuntimeState;
  let patch: { version: number; changed: Array<{ key: string; value: unknown }> } = {
    version: currentRuntimeState.version,
    changed: [],
  };

  if (!opts?.skipOutputMapping) {
    const result = await applyOutputMapping(
      deps.payloadStore,
      currentRuntimeState,
      ctx.agentDef,
      ctx.stepDef.stepId,
      ctx.stepExecutionId,
      opts?.outputRef,
      opts?.isTerminalStep ?? false,
      now,
    );
    updatedState = result.updatedState;
    patch = result.patch;
  }

  await completeStep(deps, ctx, {
    ...(opts?.outputRef ? { outputRef: opts.outputRef } : {}),
    ...(opts?.runStateUpdates ? { runStateUpdates: opts.runStateUpdates } : {}),
    runtimeState: updatedState,
    ...(patch.changed.length > 0 ? { runtimeStatePatch: patch } : {}),
    ...(opts?.additionalEvents ? { additionalEvents: opts.additionalEvents } : {}),
    ...(opts?.eventMeta ? { eventMeta: opts.eventMeta } : {}),
  });

  return { updatedRuntimeState: updatedState };
}

// ============================================================================
// buildUserError — construct a UserFacingError from available error info
// ============================================================================

function buildUserError(
  error: { code: string; message: string },
  classification?: AflowError['classification'],
  retryable?: boolean,
  context?: { runId?: string; traceId?: string; stepId?: string; attempt?: number },
) {
  if (classification) {
    const aflowError: AflowError = {
      code: error.code,
      message: error.message,
      classification,
      retryable: retryable ?? false,
      timestamp: new Date().toISOString(),
    };
    return toUserFacingError(aflowError, {
      ...context,
      includeDebug: true,
    });
  }
  return fromUnknownError(new Error(error.message), {
    ...context,
    includeDebug: true,
  });
}

// ============================================================================
// processOutcome — route a handler's StepOutcome through the canonical paths
// ============================================================================

/**
 * Process a ResultHandler's output through the canonical paths.
 * This is the main entry point after a handler interprets a step result.
 */
export async function processOutcome(
  deps: StepServiceDeps,
  ctx: StepContext,
  handlerOutput: ResultHandlerOutput,
): Promise<PostOutcomeAction> {
  const { outcome } = handlerOutput;

  switch (outcome.kind) {
    case 'waitForInput':
      return waitForInput(deps, ctx, outcome.requiredVariables, {
        ...(outcome.prompt ? { prompt: outcome.prompt } : {}),
        ...(outcome.eventMeta ? { eventMeta: outcome.eventMeta } : {}),
        ...(handlerOutput.runStateUpdates
          ? { runStateUpdates: handlerOutput.runStateUpdates }
          : {}),
        ...(handlerOutput.runtimeState ? { runtimeState: handlerOutput.runtimeState } : {}),
        ...(handlerOutput.runtimeStatePatch
          ? { runtimeStatePatch: handlerOutput.runtimeStatePatch }
          : {}),
        ...(handlerOutput.additionalEvents
          ? { additionalEvents: handlerOutput.additionalEvents }
          : {}),
      });

    case 'complete': {
      await completeStep(deps, ctx, {
        ...(outcome.outputRef ? { outputRef: outcome.outputRef } : {}),
        ...(handlerOutput.runStateUpdates
          ? { runStateUpdates: handlerOutput.runStateUpdates }
          : {}),
        ...(handlerOutput.runtimeState ? { runtimeState: handlerOutput.runtimeState } : {}),
        ...(handlerOutput.runtimeStatePatch
          ? { runtimeStatePatch: handlerOutput.runtimeStatePatch }
          : {}),
        ...(handlerOutput.additionalEvents
          ? { additionalEvents: handlerOutput.additionalEvents }
          : {}),
      });

      if (handlerOutput.scheduleRequests && handlerOutput.scheduleRequests.length > 0) {
        return {
          kind: 'schedule_steps',
          steps: handlerOutput.scheduleRequests,
        };
      }
      return { kind: 'completed' };
    }

    case 'fail': {
      const errorRef = `inline:${Buffer.from(JSON.stringify({ code: outcome.error.code, message: outcome.error.message, ...(outcome.error.details ? { details: outcome.error.details } : {}) })).toString('base64')}`;
      await failStep(deps, ctx, outcome.error, {
        errorRef,
        ...(handlerOutput.additionalEvents
          ? { additionalEvents: handlerOutput.additionalEvents }
          : {}),
      });
      return { kind: 'failed_terminal' };
    }
  }
}
