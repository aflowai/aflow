import type { Redis } from 'ioredis';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  TraceId,
  AgentDefinition,
  StepDefinition,
  AgentTurnDecision,
  AgentRole,
} from '@aflow/schemas';
import { createMessage } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { updateSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { readInlineVar, writeInlineVar } from '../helpers/runtimeState.js';
import { failStep as stepServiceFailStep } from '../../StepService/index.js';
import { loadOrCreateConversation, storeConversation } from '../helpers/aiHistory.js';
import type { ScheduleStepParams } from '../types.js';

/**
 * Cap aligned with `MAX_CONSECUTIVE_TOOL_FAILURES` (the tool-failure guard
 * in `applyAgentDecision.ts`) so workflow runners have symmetric recovery
 * budgets for "wrong-terminal violations" and "tool-call failures." Beyond
 * this, the run pauses for user input rather than looping silently.
 */
export const MAX_OUTPUT_CONTRACT_RETRIES = 5;

/**
 * The teaching feedback the LLM sees on its next turn. Schema-first: the
 * `submit_output` tool schema (result contract + required condition fields)
 * carries the full rule; this message only redirects to it.
 */
const COMPLETE_TERMINAL_FEEDBACK =
  '[TASK TERMINAL CONTRACT] Workflow tasks do not finish via the `complete` action. ' +
  'Call the `submit_output` tool, which takes no result — it submits whatever ' +
  '`draft_patch` has built, so build the output there first. ' +
  'If you cannot produce the required output, call `signal_blocked` with a reason.';

export interface MaybeFailWorkflowRunnerCompleteArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  result: {
    tenantId: string;
    sessionId: string;
    stepId: string;
    stepExecutionId: string;
    attempt: number;
    outputRef: string | null | undefined;
    traceId: string;
  };
  agentDef: AgentDefinition;
  runtimeState: NonNullable<SessionHotState['runtimeState']>;
  /** Full session hot state — provides the `workflowExecution` gate. */
  runHotState: SessionHotState;
  agentRoleConfig: {
    agentRole: AgentRole;
  };
  decision: AgentTurnDecision;
  now: number;
  scheduleStep: (params: ScheduleStepParams) => Promise<StepExecutionId>;
  stepDef: StepDefinition;
}

export type MaybeFailWorkflowRunnerCompleteResult = 'retried' | 'failed' | null;

/**
 * Reject a workflow-runner `complete` decision as a terminal-contract
 * violation. No-op (returns `null`) when:
 *
 *  - Not a `complete` decision.
 *  - Not a workflow runner (`runHotState.workflowExecution === undefined`).
 *  - Not a subagent role (assistant `complete`s pause; not subject to enforcement).
 *
 * Otherwise returns:
 *  - `'retried'` — turn re-scheduled with teaching feedback (retry budget not exhausted).
 *  - `'paused'`  — run paused for user guidance (retry budget exhausted, or
 *                  retry state could not be persisted).
 */
export async function maybeFailWorkflowRunnerComplete(
  args: MaybeFailWorkflowRunnerCompleteArgs,
): Promise<MaybeFailWorkflowRunnerCompleteResult> {
  const {
    redis,
    payloadStore,
    result,
    agentDef,
    runtimeState,
    runHotState,
    agentRoleConfig,
    decision,
    now,
    scheduleStep,
    stepDef,
  } = args;

  // Gate: only act on workflow runners emitting `complete`. Non-workflow
  // subagents (Coach, ad-hoc delegations) legitimately complete via the
  // `complete` meta-function and are untouched.
  if (decision.action !== 'complete') return null;
  if (runHotState.workflowExecution === undefined) return null;
  if (agentRoleConfig.agentRole !== 'subagent') return null;

  // Increment retry counter on runtime state.
  const retryVarKey = `ai.agent.outputContractRetries.${result.stepId}`;
  const priorRetries = readInlineVar(runtimeState, retryVarKey, 0);
  const newRetryCount = priorRetries + 1;

  if (newRetryCount > MAX_OUTPUT_CONTRACT_RETRIES) {
    return await pauseForUserGuidance({
      redis,
      payloadStore,
      result,
      agentDef,
      stepDef,
      priorRetries,
    });
  }

  // Under budget — append feedback to conversation history and persist
  // the retry counter BEFORE rescheduling.
  //
  // Invariant: rescheduling without a persisted retry counter is unsafe.
  // The next turn would re-read `priorRetries` from unchanged runtime
  // state, the cap (MAX_OUTPUT_CONTRACT_RETRIES) would never be hit, and
  // the off-contract `complete` could loop indefinitely — burning tokens
  // and pinning the agent on a guaranteed-to-fail terminal.
  //
  // So this block is "persist or pause," not "best-effort + reschedule."
  // If any of loadOrCreateConversation / storeConversation /
  // updateSessionState throws, fall through to the persist-failure pause
  // so the operator sees the underlying infra problem and intervenes.
  let persisted = false;
  try {
    const conversation = await loadOrCreateConversation(
      payloadStore,
      result.tenantId,
      result.sessionId,
      result.stepId,
      runtimeState,
    );
    conversation.messages.push(createMessage('system', COMPLETE_TERMINAL_FEEDBACK));
    conversation.updatedAtMs = now;

    const stored = await storeConversation(
      payloadStore,
      conversation,
      runtimeState,
      result.stepId,
      result.stepExecutionId,
      now,
    );

    // Bump retry counter on the updated runtime state.
    const vars = { ...stored.updatedState.variables };
    writeInlineVar(vars, retryVarKey, newRetryCount, {
      nowMs: now,
      stepExecutionId: result.stepExecutionId,
      stepId: result.stepId,
      version: newRetryCount,
    });
    const nextRuntimeState = {
      ...stored.updatedState,
      variables: vars,
      version: stored.updatedState.version + 1,
      updatedAtMs: now,
    };
    await updateSessionState(redis, result.tenantId as TenantId, result.sessionId as SessionId, {
      runtimeState: nextRuntimeState,
    });
    persisted = true;
  } catch (err) {
    logOrchestratorError(
      `[wfRunnerComplete] failed to persist retry state for ${result.sessionId}; pausing instead of looping:`,
      err,
      { tenantId: result.tenantId, sessionId: result.sessionId },
    );
  }

  if (!persisted) {
    // Retry counter could not be persisted — pause for operator instead
    // of risking an unbounded loop on stale state.
    return await pauseForRetryPersistFailure({
      redis,
      payloadStore,
      result,
      agentDef,
      stepDef,
    });
  }

  if (!result.outputRef) {
    // Defensive: caller (`applyAgentDecision`) early-returns when
    // `result.outputRef` is missing, but the type-level narrowing doesn't
    // survive crossing into this helper. If we do somehow hit this, log
    // and bail rather than crashing scheduleStep.
    logOrchestratorError(
      `[wfRunnerComplete] missing outputRef on retry for ${result.sessionId}`,
      new Error('missing outputRef'),
      { tenantId: result.tenantId, sessionId: result.sessionId },
    );
    return null;
  }

  await scheduleStep({
    context: {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDefinition: agentDef,
      traceId: result.traceId as TraceId,
    },
    stepId: result.stepId as StepId,
    inputRef: result.outputRef,
  });

  console.warn(
    `[wfRunnerComplete] workflow runner emitted \`complete\` for run ${result.sessionId}; redirected to submit_output (retry ${String(newRetryCount)}/${String(MAX_OUTPUT_CONTRACT_RETRIES)})`,
  );
  return 'retried';
}

async function pauseForUserGuidance(args: {
  redis: Redis;
  payloadStore: PayloadStore;
  result: MaybeFailWorkflowRunnerCompleteArgs['result'];
  agentDef: AgentDefinition;
  stepDef: StepDefinition;
  priorRetries: number;
}): Promise<'failed'> {
  const { redis, payloadStore, result, agentDef, stepDef, priorRetries } = args;
  const failureMessage =
    `The agent emitted ${String(MAX_OUTPUT_CONTRACT_RETRIES)} consecutive \`complete\` decisions instead of calling ` +
    `\`submit_output\` (the required terminal for workflow tasks — it carries the output contract). ` +
    `The run has been failed — revisit the task definition or start a new run.`;
  const failureErrorRef = `inline:${Buffer.from(
    JSON.stringify({
      code: 'OUTPUT_CONTRACT_VIOLATION_PERSISTENT',
      message: failureMessage,
      classification: 'validation',
      retryable: false,
      timestamp: new Date().toISOString(),
      details: { retries: priorRetries },
    }),
  ).toString('base64')}`;

  await stepServiceFailStep(
    { redis, payloadStore },
    {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDef,
      traceId: result.traceId as TraceId,
      stepDef,
      stepExecutionId: result.stepExecutionId as StepExecutionId,
      attempt: result.attempt,
      runState: {} as SessionHotState,
    },
    { code: 'OUTPUT_CONTRACT_VIOLATION_PERSISTENT', message: failureMessage },
    {
      errorRef: failureErrorRef,
      classification: 'validation',
      retryable: false,
      runStateUpdates: { status: 'FAILED' as const, errorRef: failureErrorRef },
    },
  );

  console.warn(
    `[wfRunnerComplete] retry budget exhausted for run ${result.sessionId}: agent never called submit_output — failing run`,
  );
  return 'failed';
}

/**
 * Pause the run when the retry counter / conversation feedback could not
 * be persisted. Without persistence, rescheduling would re-enter the
 * decision handler with `priorRetries` unchanged, defeating the
 * MAX_OUTPUT_CONTRACT_RETRIES cap and looping the agent indefinitely.
 *
 * Surfaces as `OUTPUT_CONTRACT_RETRY_PERSIST_FAILED` so the operator can
 * inspect the underlying infra failure (Redis / payload-store) and
 * decide whether to resume manually or retry the upstream task.
 */
async function pauseForRetryPersistFailure(args: {
  redis: Redis;
  payloadStore: PayloadStore;
  result: MaybeFailWorkflowRunnerCompleteArgs['result'];
  agentDef: AgentDefinition;
  stepDef: StepDefinition;
}): Promise<'failed'> {
  const { redis, payloadStore, result, agentDef, stepDef } = args;
  const fullMessage =
    `The agent finished via \`complete\` instead of the required \`submit_output\` tool, and the orchestrator ` +
    `could not persist retry state (Redis/payload-store write failure). Failing to avoid an unbounded retry loop.`;
  const failureErrorRef = `inline:${Buffer.from(
    JSON.stringify({
      code: 'OUTPUT_CONTRACT_RETRY_PERSIST_FAILED',
      message: fullMessage,
      classification: 'internal',
      retryable: false,
      timestamp: new Date().toISOString(),
    }),
  ).toString('base64')}`;

  await stepServiceFailStep(
    { redis, payloadStore },
    {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDef,
      traceId: result.traceId as TraceId,
      stepDef,
      stepExecutionId: result.stepExecutionId as StepExecutionId,
      attempt: result.attempt,
      runState: {} as SessionHotState,
    },
    { code: 'OUTPUT_CONTRACT_RETRY_PERSIST_FAILED', message: fullMessage },
    {
      errorRef: failureErrorRef,
      classification: 'internal',
      retryable: false,
      runStateUpdates: { status: 'FAILED' as const, errorRef: failureErrorRef },
    },
  );

  console.warn(
    `[wfRunnerComplete] retry-state persist failed for run ${result.sessionId}; failing run`,
  );
  return 'failed';
}
