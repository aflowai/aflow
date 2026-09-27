import type { Redis } from 'ioredis';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  StepType,
  TraceId,
  IdempotencyKey,
  OperationId,
  AgentDefinition,
  StepDefinition,
  SubagentHandoffPayload,
  SessionAgentTarget,
} from '@aflow/schemas';
import { isSubagentHandoffPayload } from '@aflow/schemas';
import {
  getSessionState,
  getStepState,
  addStepResult,
  removeWaitingChild,
  appendSessionEvent,
  markSessionDirty,
  type SessionEvent,
} from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { waitForInput } from '../../StepService/index.js';
import type { RequiredVariable, StepServiceDeps } from '../../StepService/index.js';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { getDatabase } from '@aflow/database';
import { surfaceWorkflowResumeContract } from '@aflow/cybernetic-runtime';

/**
 * Parse a `requestedInputRef` (inline or payload-store-backed) into a plain
 * object. Returns `null` if the ref is absent or unparseable. Errors are
 * logged at debug; callers handle the null case explicitly rather than
 * silently coalescing.
 */
async function parseRequestedInputRef(
  ref: string | undefined,
  payloadStore: PayloadStore,
): Promise<Record<string, unknown> | null> {
  if (!ref) return null;
  try {
    if (ref.startsWith('inline:')) {
      const raw = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8').trim();
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    }
    const fetched = await payloadStore.retrieve(ref);
    if (fetched && typeof fetched === 'object' && !Array.isArray(fetched)) {
      return fetched as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function bubbleChildPauseToParent(
  redis: Redis,
  payloadStore: PayloadStore,
  tenantId: string,
  childRunId: string,
  agentDefLoader: (
    tenantId: string,
    target: SessionAgentTarget,
    agentVersion: string,
  ) => Promise<AgentDefinition>,
): Promise<void> {
  const logger = getOrchestratorLogger();
  logger.info(`[bubbleChildPause] CALLED for child=${childRunId}`);

  // 1. Read child run state — must be PAUSED with parentRunId
  const childState = await getSessionState(redis, tenantId, childRunId);
  if (!childState?.parentSessionId || childState.status !== 'PAUSED') {
    logger.info(
      `[bubbleChildPause] skip kind=child-not-paused child=${childRunId} status=${childState?.status} parentSessionId=${childState?.parentSessionId}`,
    );
    return;
  }

  const parentRunId = childState.parentSessionId;
  const parentStepExecutionId = childState.parentStepExecutionId;
  if (!parentStepExecutionId) {
    logger.info(`[bubbleChildPause] skip kind=no-parent-step-exec child=${childRunId}`);
    return;
  }

  // 2. Read parent run state — must be waiting for this child
  const parentState = await getSessionState(redis, tenantId, parentRunId);
  if (!parentState) {
    logger.info(
      `[bubbleChildPause] skip kind=parent-not-found parent=${parentRunId} child=${childRunId}`,
    );
    return;
  }

  const waitingIds = parentState.waitingForChildSessionIds ?? [];
  if (!waitingIds.includes(childRunId)) {
    logger.info(
      `[bubbleChildPause] skip kind=child-not-tracked parent=${parentRunId} child=${childRunId} waitingIds=[${waitingIds.join(',')}]`,
    );
    return;
  }

  // 3. Idempotent: if parent already has a child pause bubbled, skip
  if (parentState.delegationPauseSource === 'child_input') {
    logger.info(
      `[bubbleChildPause] skip kind=already-bubbled parent=${parentRunId} child=${childRunId}`,
    );
    return;
  }

  if (childState.delegationPauseSource === 'child_running') {
    logger.info(`[bubbleChildPause] skip kind=internal-delegation-wait child=${childRunId}`);
    return;
  }

  // 4. Parse the child's requestedInputRef once and decide if it's a typed
  //    handoff payload (intended for the parent agent) or a plain user-input
  //    pause. The strict-validation step is deliberate — see the file
  //    docstring; without it the routing used to silently fall back to the
  //    wrong path on `delegationWaitMode` drift.
  const parsedRequestedInput = await parseRequestedInputRef(
    childState.requestedInputRef,
    payloadStore,
  );
  const handoffPayload: SubagentHandoffPayload | undefined = isSubagentHandoffPayload(
    parsedRequestedInput,
  )
    ? parsedRequestedInput
    : undefined;

  // 5. Anomaly check: the parent is tracking this child but has no
  //    `delegationWaitMode` set. This means `enterChildWait` either wasn't
  //    called or was called on a code path that didn't store the field. After
  if (handoffPayload && parentState.delegationWaitMode === undefined) {
    logger.warn(
      `[bubbleChildPause] anomaly kind=missing-wait-mode-on-handoff parent=${parentRunId} child=${childRunId} handoffSource=${handoffPayload.handoffSource}. ` +
        `Forcing until_pause routing so the structured handoff reaches the parent agent.`,
    );
  }

  // 6. Routing decision:
  //    - Handoff payload → always Path A (typed tool result to parent agent),
  //      regardless of delegationWaitMode. The handoff is structurally for
  //      the parent agent, not the user.
  //    - Plain user-input pause → Path A only if delegationWaitMode is
  //      'until_pause' (parent opted into pause supervision); otherwise
  //      Path B (waitForInput-on-parent).
  const useTypedToolResultPath =
    handoffPayload !== undefined || parentState.delegationWaitMode === 'until_pause';

  logger.info(
    `[bubbleChildPause] proceed parent=${parentRunId} child=${childRunId} ` +
      `delegationPauseSource=${childState.delegationPauseSource ?? 'undefined'} ` +
      `parentWaitMode=${parentState.delegationWaitMode ?? 'undefined'} ` +
      `isHandoff=${handoffPayload !== undefined} ` +
      `path=${useTypedToolResultPath ? 'typed-tool-result' : 'waitForInput-on-parent'}`,
  );

  if (useTypedToolResultPath) {
    await routeAsTypedToolResult({
      redis,
      payloadStore,
      tenantId,
      childRunId,
      childState,
      parentRunId,
      parentState,
      parentStepExecutionId,
      handoffPayload,
      parsedRequestedInput,
      logger,
    });
    return;
  }

  await routeAsParentInputPause({
    redis,
    payloadStore,
    tenantId,
    childRunId,
    childState,
    parentRunId,
    parentState,
    parentStepExecutionId,
    parsedRequestedInput,
    agentDefLoader,
  });
}

// ============================================================================
// Path A — typed tool result to parent agent (was: until_pause branch)
// ============================================================================

interface TypedToolResultArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  tenantId: string;
  childRunId: string;
  childState: NonNullable<Awaited<ReturnType<typeof getSessionState>>>;
  parentRunId: string;
  parentState: NonNullable<Awaited<ReturnType<typeof getSessionState>>>;
  parentStepExecutionId: string;
  handoffPayload: SubagentHandoffPayload | undefined;
  parsedRequestedInput: Record<string, unknown> | null;
  logger: ReturnType<typeof getOrchestratorLogger>;
}

async function routeAsTypedToolResult(args: TypedToolResultArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    tenantId,
    childRunId,
    childState,
    parentRunId,
    parentState,
    parentStepExecutionId,
    handoffPayload,
    parsedRequestedInput,
    logger,
  } = args;

  let workflowResumeContract: unknown;
  const childRunRunId = childState.workflowExecution?.runId;
  if (!childRunRunId) {
    logger.info(
      `[bubbleChildPause] resume-contract surfacing skipped child=${childRunId}: no workflowExecution on childState`,
    );
  } else {
    try {
      const db = getDatabase();
      const surfaced = await surfaceWorkflowResumeContract(
        db,
        payloadStore,
        tenantId,
        childRunRunId,
      );
      if (surfaced) {
        workflowResumeContract = surfaced.contract;
        logger.info(
          `[bubbleChildPause] surfaced resume contract child=${childRunId} runId=${childRunRunId} pauseCause=${surfaced.contract.pauseCause} pauseVersion=${String(surfaced.pauseVersion)}`,
        );
      } else {
        logger.info(
          `[bubbleChildPause] surfaceWorkflowResumeContract returned null child=${childRunId} runId=${childRunRunId} (see [surfaceWorkflowResumeContract] log for which guard tripped)`,
        );
      }
    } catch (err) {
      logger.warn(
        `[bubbleChildPause] surfaceWorkflowResumeContract failed for run=${childRunRunId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Build pausePrompt and forwarded handoffPayload from the parsed input.
  // For strict handoff payloads we forward the whole validated object. For
  // legacy/non-handoff paused payloads we still extract the prompt and
  // duck-type any extra structured fields onto a back-compat `handoffPayload`
  // shape (kept for parent agents already pattern-matching on it).
  let pausePrompt = 'Sub-agent needs input';
  let forwardedHandoffPayload: Record<string, unknown> | undefined;

  if (handoffPayload) {
    pausePrompt = handoffPayload.prompt;
    forwardedHandoffPayload = {
      // Forward the entire validated object so the parent agent has full
      // structure. The schema's `.passthrough()` means source-specific extras
      // (e.g. compose-skill-handoff's `missing[]`) come along for the ride.
      ...handoffPayload,
    };
  } else if (parsedRequestedInput) {
    const parsed = parsedRequestedInput;
    if (typeof parsed['prompt'] === 'string') {
      pausePrompt = parsed['prompt'];
    }
    // Legacy duck-typed surface — older paused payloads predating the
    // SubagentHandoffPayload schema. Kept for graceful degradation; new
    // emitters set `payloadKind: 'subagent_handoff'` and hit the branch above.
    if (parsed['kind'] || parsed['handoff'] || parsed['missing'] || parsed['reason']) {
      forwardedHandoffPayload = {
        ...(parsed['kind'] !== undefined ? { kind: parsed['kind'] } : {}),
        ...(parsed['status'] !== undefined ? { status: parsed['status'] } : {}),
        ...(parsed['reason'] !== undefined ? { reason: parsed['reason'] } : {}),
        ...(parsed['missing'] !== undefined ? { missing: parsed['missing'] } : {}),
        ...(parsed['handoff'] !== undefined ? { handoff: parsed['handoff'] } : {}),
        ...(parsed['blockingCategory'] !== undefined
          ? { blockingCategory: parsed['blockingCategory'] }
          : {}),
      };
    }
  }

  // Build a guidance message that reflects the handoff. When the child
  // gave us a `handoff.skillSlug`, tell the parent agent which skill to
  // run; otherwise fall back to the generic resume/cancel/ignore message.
  let guidance =
    `Sub-agent paused: "${pausePrompt}". You can resume with agent.control.resume, ` +
    'cancel the child, or ignore and move on.';
  const handoffField = forwardedHandoffPayload?.['handoff'] as Record<string, unknown> | undefined;
  if (handoffField && typeof handoffField['skillSlug'] === 'string') {
    const targetSkill = handoffField['skillSlug'];
    guidance =
      `Sub-agent paused with a structured handoff: run \`${targetSkill}\` ` +
      `(via workflow.run.start with slug \`${targetSkill}\` and the prefill below) to resolve, ` +
      `then call agent.control.resume on childSessionId="${childRunId}" to continue ` +
      `the original procedure. Pause prompt: "${pausePrompt}".`;
  }
  if (
    workflowResumeContract &&
    typeof workflowResumeContract === 'object' &&
    !Array.isArray(workflowResumeContract)
  ) {
    const c = workflowResumeContract as Record<string, unknown>;
    const prompt = typeof c['resumePrompt'] === 'string' ? c['resumePrompt'] : undefined;
    const cause = typeof c['pauseCause'] === 'string' ? c['pauseCause'] : undefined;
    const suggested = c['suggestedResumeCall'] as Record<string, unknown> | undefined;
    const opFromContract = typeof suggested?.['op'] === 'string' ? suggested['op'] : undefined;
    const suggestedArgs = suggested?.['args'] as Record<string, unknown> | undefined;
    const suggestedResolution = suggestedArgs?.['resolution'] as
      Record<string, unknown> | undefined;
    const resolutionMode =
      typeof suggestedResolution?.['mode'] === 'string' ? suggestedResolution['mode'] : undefined;
    if (prompt && opFromContract) {
      // Op-specific "what to fill" hint. The agent's algorithm is the same
      // regardless: copy `suggestedResumeCall.args` verbatim, fill the one
      // free-text field. We just spell it out so it's unambiguous.
      let fillHint: string;
      if (opFromContract === 'workflow.run.resume') {
        if (resolutionMode === 'provide_input') {
          fillHint =
            'Fill `args.resolution.inputs` (keyed by `bindAs`) to match ' +
            '`workflowResumeContract.pausedTaskInputContract.schema` ' +
            '(read its `properties` for required keys and per-slot types). ' +
            'Each value is the parent-provided run input the runner was ' +
            'blocked on.';
        } else if (resolutionMode === 'acknowledge') {
          fillHint =
            'Send `args` verbatim — `resolution: { mode: "acknowledge" }` has ' +
            'no shaped body. Use this when the external state was fixed ' +
            'out-of-band (creds added, capability re-enabled, etc.).';
        } else if (resolutionMode === 're_execute') {
          fillHint =
            'Copy `args` from the contract, then add optional `instructions` ' +
            '(PRIOR FAILURE GUIDANCE) and, when `pausedTaskInputContract.schema` ' +
            'requires `remediationConfirmed: true`, obtain operator confirmation ' +
            'before setting `remediationConfirmed: true` on `resolution`.';
        } else if (resolutionMode === 'fail') {
          fillHint =
            'Copy `args` from the contract and replace `resolution.reason` with ' +
            'the operator-facing rejection text before invoking.';
        } else {
          // Default: `replace_output` (contract violations, human tasks).
          fillHint =
            'Fill `args.resolution.output` to match ' +
            '`workflowResumeContract.pausedTaskInputContract.schema` ' +
            '(fall back to `workflowResumeContract.replaceOutputSchema.properties` ' +
            'on pre-Plan-149 contracts that lack the inline schema). The ' +
            "user's input becomes the structured output.";
        }
      } else if (opFromContract === 'agent.control.resume') {
        fillHint =
          "Fill `args.message` with the user's reply (verbatim or briefly " +
          'paraphrased). The Driver wakes, interprets the message, and ' +
          'completes the task.';
      } else {
        fillHint =
          'Copy `args` verbatim from the contract; fill any blank free-text ' +
          "field with the user's input.";
      }
      guidance =
        `Workflow run paused (${cause ?? 'unknown cause'}): ${prompt}\n\n` +
        `ACTION — invoke \`${opFromContract}\` using ` +
        '`workflowResumeContract.suggestedResumeCall.args` as your starting ' +
        `point. ${fillHint}\n\n` +
        'DO NOT pick a different op or invent IDs — the platform picked ' +
        '`' +
        opFromContract +
        '` for this pause cause and pre-armed every ID you need. Use the ' +
        'contract verbatim.';
    }
  }

  // Emit SUCCEEDED step result with pause info — parent agent sees this as a tool result
  const outputData: Record<string, unknown> = {
    childSessionId: childRunId,
    status: 'PAUSED' as const,
    pausePrompt,
    message: guidance,
    ...(forwardedHandoffPayload ? { handoffPayload: forwardedHandoffPayload } : {}),
    ...(workflowResumeContract ? { workflowResumeContract } : {}),
  };
  const outputRef = `inline:${Buffer.from(JSON.stringify(outputData)).toString('base64')}`;

  const parentStepState = await getStepState(redis, tenantId, parentStepExecutionId);
  if (!parentStepState) return;

  // Remove child from waiting list (parent is getting control back)
  await removeWaitingChild(redis, tenantId, parentRunId, childRunId);

  // Canonical leave-child-wait → RUNNING. Clears ALL delegation fields
  // so stale metadata doesn't block future bubbling or confuse guards.
  //
  const { leaveChildWaitToRunning } = await import('../helpers/delegationState.js');
  await leaveChildWaitToRunning(redis, tenantId, parentRunId, {
    fromStatus: parentState.status,
  });

  // Reset step status PAUSED → STARTED so applyResult's idempotency check
  // doesn't reject the synthetic result (same pattern as resumeParentOnChildComplete)
  const { updateStepState } = await import('@aflow/redis');
  await updateStepState(redis, tenantId, parentStepExecutionId, {
    sessionId: parentRunId,
    status: 'STARTED',
  });

  // Emit resume event
  const resumeEvent: SessionEvent = {
    eventId: crypto.randomUUID(),
    eventType: 'SessionResumed',
    timestamp: Date.now(),
    sessionId: parentRunId,
    metadata: {
      childRunId,
      childStatus: 'PAUSED',
      stepId: parentStepState.stepId,
      stepType: parentStepState.stepType,
      attempt: (parentStepState.attempt as number | undefined) ?? 1,
    },
  };
  await appendSessionEvent(redis, tenantId, parentRunId as SessionId, resumeEvent);
  await markSessionDirty(redis, tenantId, parentRunId as SessionId);

  // Emit step result — routes through applyResult → onSuccess normally
  await addStepResult(redis, {
    messageVersion: 1,
    tenantId: tenantId as TenantId,
    sessionId: parentRunId as SessionId,
    stepExecutionId: parentStepExecutionId as StepExecutionId,
    parentStepExecutionId: null,
    stepId: parentStepState.stepId as StepId,
    stepType: (parentStepState.stepType as StepType | undefined) ?? 'agent',
    operationId: ((parentStepState.operationId as OperationId | undefined) ??
      'agent.control.delegate') as OperationId,
    attempt: (parentStepState.attempt as number | undefined) ?? 1,
    idempotencyKey: `pause-return:${parentRunId}:${childRunId}` as IdempotencyKey,
    status: 'SUCCEEDED',
    outputRef,
    resolvedInputRef: (parentStepState.inputRef as string | undefined) ?? '',
    durationMs: 0,
    traceId: ((parentState.traceId as TraceId | undefined) ?? '') as TraceId,
    finishedAtMs: Date.now(),
  });

  logger.info(
    `[bubbleChildPause] emitted typed-tool-result parent=${parentRunId} child=${childRunId} ` +
      `handoffSource=${handoffPayload?.handoffSource ?? 'legacy-or-none'}`,
  );
}

// ============================================================================
// Path B — pause the parent for user input (was: waitForInput branch)
// ============================================================================

interface ParentInputPauseArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  tenantId: string;
  childRunId: string;
  childState: NonNullable<Awaited<ReturnType<typeof getSessionState>>>;
  parentRunId: string;
  parentState: NonNullable<Awaited<ReturnType<typeof getSessionState>>>;
  parentStepExecutionId: string;
  parsedRequestedInput: Record<string, unknown> | null;
  agentDefLoader: (
    tenantId: string,
    target: SessionAgentTarget,
    agentVersion: string,
  ) => Promise<AgentDefinition>;
}

async function routeAsParentInputPause(args: ParentInputPauseArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    tenantId,
    childRunId,
    childState,
    parentRunId,
    parentState,
    parentStepExecutionId,
    parsedRequestedInput,
    agentDefLoader,
  } = args;

  // Extract prompt + missingVariables from the already-parsed input.
  let childPrompt: string | undefined;
  let childMissingVars: RequiredVariable[] = [];
  if (parsedRequestedInput) {
    if (typeof parsedRequestedInput['prompt'] === 'string') {
      childPrompt = parsedRequestedInput['prompt'];
    }
    if (Array.isArray(parsedRequestedInput['missingVariables'])) {
      childMissingVars = (parsedRequestedInput['missingVariables'] as unknown[]).map(
        (v: unknown) => {
          const obj = v as Record<string, unknown>;
          const result: RequiredVariable = {
            variableId:
              typeof obj['variableId'] === 'object' && obj['variableId'] !== null
                ? JSON.stringify(obj['variableId'])
                : String((obj['variableId'] ?? '') as string | number | boolean),
            required: true as const,
          };
          if (typeof obj['name'] === 'string') result.name = obj['name'];
          if (typeof obj['description'] === 'string') result.description = obj['description'];
          if (typeof obj['typeSchema'] === 'object' && obj['typeSchema'] !== null) {
            result.typeSchema = obj['typeSchema'] as Record<string, unknown>;
          }
          if (typeof obj['semanticType'] === 'string') {
            result.semanticType = obj['semanticType'];
          }
          return result;
        },
      );
    }
  }

  // Build StepContext for the parent's subflow step.
  const parentStepState = await getStepState(redis, tenantId, parentStepExecutionId);
  if (!parentStepState) {
    logOrchestratorError(
      `[bubbleChildPause] Parent step ${parentStepExecutionId} not found — cannot bubble`,
      new Error('Parent step state missing'),
      { tenantId, parentRunId, parentStepExecutionId, childRunId },
    );
    return;
  }

  const parentAgentDef = await agentDefLoader(
    tenantId,
    parentState.target,
    parentState.agentVersion,
  );

  const parentStepDef =
    parentAgentDef.steps.find((s) => s.stepId === parentStepState.stepId) ??
    ({
      stepId: parentStepState.stepId as StepId,
      stepType: (parentStepState.stepType as StepType | undefined) ?? 'agent',
      operation:
        (parentStepState.operationId as OperationId | undefined) ?? 'agent.control.delegate',
      name: parentStepState.stepId,
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition);

  const deps: StepServiceDeps = { redis, payloadStore };

  const subflowStepName = parentStepDef.name ?? parentStepState.stepId;
  const waitOpts: Parameters<typeof waitForInput>[3] = {
    prompt: childPrompt ?? 'Subflow needs input',
    eventMeta: {
      childRunId,
      subflowPause: true,
      subflowStepName,
    },
    runStateUpdates: {
      delegationPauseSource: 'child_input' as const,
      pausedChildSessionId: childRunId,
      childPausedStepExecutionId: childState.currentStepExecutionId,
    },
    pauseType: 'subflow_waiting',
  };
  if (childState.requestedInputRef) {
    waitOpts.preBuiltRequestedInputRef = childState.requestedInputRef;
  }

  await waitForInput(
    deps,
    {
      tenantId: tenantId as TenantId,
      runId: parentRunId as SessionId,
      agentDef: parentAgentDef,
      traceId: (parentState.traceId ?? '') as TraceId,
      stepDef: parentStepDef,
      stepExecutionId: parentStepExecutionId as StepExecutionId,
      attempt: (parentStepState.attempt as number | undefined) ?? 1,
      runState: parentState,
    },
    childMissingVars,
    waitOpts,
  );

  // Cascade upward: the parent we just paused may itself have a parent
  // (e.g. Helmsman → Driver → Runner). Without this, a Driver paused via
  // child_input would never bubble to a Helmsman delegating with
  // wait='until_pause', leaving the Helmsman wedged in WAITING_ON_CHILD.
  // Path A above doesn't need this — it routes through addStepResult →
  // applyResult, which already calls reconcile.
  if (parentState.parentSessionId) {
    const { enqueuePendingAndReconcile } = await import('./enqueueDelegationCompletion.js');
    await enqueuePendingAndReconcile({
      redis,
      payloadStore,
      tenantId,
      childRunId: parentRunId,
      reason: 'bubbleChildPause:cascade',
      ...(parentState.parentStepExecutionId
        ? {
            parentRunId: parentState.parentSessionId,
            parentStepExecutionId: parentState.parentStepExecutionId,
          }
        : {}),
      agentDefLoader,
    });
  }
}
