import type { Redis } from 'ioredis';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  TraceId,
  AgentDefinition,
  CompletionPolicy,
  StepDefinition,
} from '@aflow/schemas';
import { getOperation, resolveNextStep } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { updateSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { readInlineVar, writeInlineVar } from '../helpers/runtimeState.js';
import { failStep as stepServiceFailStep } from '../../StepService/index.js';
import type { ScheduleStepParams } from '../types.js';
import { MAX_OUTPUT_CONTRACT_RETRIES } from './workflowRunnerCompleteValidation.js';

export function completionContinuationEdges(
  stepDef: StepDefinition,
  agentDef: AgentDefinition,
): StepDefinition['onSuccess']['next'] {
  return stepDef.onSuccess.next.filter((edge) => {
    const target = agentDef.steps.find((s) => s.stepId === edge.stepId);
    if (!target) return false;
    if (target.onSuccess.next.some((n) => n.stepId === stepDef.stepId)) return false;
    return !(getOperation(target.operation)?.tags?.includes('terminal') ?? false);
  });
}

/**
 * Resolve the graph step a subagent `complete` must hand off to instead of
 * ending the session.
 *
 * An agent step's onSuccess edges are overloaded: they declare the agent's
 * graph-tool surface (buildAvailableTools) and, for contract-bound agents,
 * the completion successor that validates/consumes the final result. Edges on
 * the agent's own verb surface are never completion successors: a tool edge's
 * target routes back to the agent step on success, and a registry-tagged
 * terminal agent verb (agent.control.submit_output / .end) is invoked by the
 * agent itself. The remaining continuation edges resolve by the normal
 * priority semantics, so a route-back tool edge can never shadow a declared
 * successor.
 *
 * Successor routing applies only under completionPolicy
 * 'must_complete_or_block' — the policy that binds completion to the graph's
 * contract. Open-ended subagents (e.g. the Runner) keep
 * complete-as-session-terminal.
 *
 * Exported for unit testing.
 */
export function resolveCompletionSuccessor(
  stepDef: StepDefinition | undefined,
  agentDef: AgentDefinition,
  completionPolicy: CompletionPolicy,
): StepId | null {
  if (completionPolicy !== 'must_complete_or_block' || !stepDef) return null;
  const continuationEdges = completionContinuationEdges(stepDef, agentDef);
  if (continuationEdges.length === 0) return null;
  return resolveNextStep({ ...stepDef, onSuccess: { next: continuationEdges } }, 'success');
}

/**
 * Decode a `complete.result` the model emitted as a JSON-stringified object.
 * Returns the decoded object/array, or undefined when the string is not a
 * JSON container. Only contract-bound completions run through this — a plain
 * string is a legitimate final result everywhere else.
 */
export function decodeStringifiedCompletionResult(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    // Not JSON — the caller loops the turn back with teaching feedback.
  }
  return undefined;
}

const MALFORMED_COMPLETION_RESULT_FEEDBACK =
  '[COMPLETION CONTRACT] Your `complete.result` was a string, but this graph validates the ' +
  'completion result as a structured object. Call `complete` again with `result` as a JSON ' +
  'object matching the completion contract — never a stringified or prose rendering of it.';

export interface RescheduleMalformedCompletionResultArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  result: {
    tenantId: string;
    sessionId: string;
    stepId: string;
    stepExecutionId: string;
    attempt: number;
    traceId: string;
  };
  outputRef: string;
  agentDef: AgentDefinition;
  stepDef: StepDefinition;
  currentRuntimeState: NonNullable<SessionHotState['runtimeState']>;
  updatedUsageSummary: SessionHotState['usageSummary'];
  scheduleStep: (params: ScheduleStepParams) => Promise<StepExecutionId>;
  now: number;
}

/**
 * Loop a contract-bound `complete` whose result cannot be decoded into a
 * structured value back to the agent turn with teaching feedback, instead of
 * persisting a payload the completion successor's input schema will reject.
 * Shares the retry budget with the workflow-runner complete gate; on
 * exhaustion the step fails with a legible validation error.
 */
export async function rescheduleMalformedCompletionResult(
  args: RescheduleMalformedCompletionResultArgs,
): Promise<boolean> {
  const {
    redis,
    payloadStore,
    result,
    outputRef,
    agentDef,
    stepDef,
    currentRuntimeState,
    updatedUsageSummary,
    scheduleStep,
    now,
  } = args;

  const retryVarKey = `ai.agent.outputContractRetries.${result.stepId}`;
  const priorRetries = readInlineVar(currentRuntimeState, retryVarKey, 0);
  const newRetryCount = priorRetries + 1;

  if (newRetryCount > MAX_OUTPUT_CONTRACT_RETRIES) {
    const message =
      `The agent emitted ${String(MAX_OUTPUT_CONTRACT_RETRIES)} consecutive \`complete\` decisions ` +
      `whose result was a string instead of the structured object the completion contract requires. ` +
      `The run has been failed — revisit the completion contract or start a new run.`;
    const errorRef = `inline:${Buffer.from(
      JSON.stringify({
        code: 'COMPLETION_RESULT_MALFORMED_PERSISTENT',
        message,
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
      { code: 'COMPLETION_RESULT_MALFORMED_PERSISTENT', message },
      {
        errorRef,
        classification: 'validation',
        retryable: false,
        runStateUpdates: { status: 'FAILED' as const, errorRef },
      },
    );
    return true;
  }

  const vars = { ...currentRuntimeState.variables };
  writeInlineVar(
    vars,
    `ai.agent.chatInput.${result.stepId}`,
    MALFORMED_COMPLETION_RESULT_FEEDBACK,
    {
      nowMs: now,
      stepExecutionId: result.stepExecutionId,
      stepId: result.stepId,
    },
  );
  writeInlineVar(vars, retryVarKey, newRetryCount, {
    nowMs: now,
    stepExecutionId: result.stepExecutionId,
    stepId: result.stepId,
    version: newRetryCount,
  });

  // Persist-or-abort: rescheduling on unpersisted retry state would loop the
  // agent unboundedly, so a persist failure propagates to the result consumer
  // instead of scheduling the turn.
  await updateSessionState(redis, result.tenantId as TenantId, result.sessionId as SessionId, {
    runtimeState: {
      ...currentRuntimeState,
      variables: vars,
      version: currentRuntimeState.version + 1,
      updatedAtMs: now,
    },
    usageSummary: updatedUsageSummary,
  });

  await scheduleStep({
    context: {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDefinition: agentDef,
      traceId: result.traceId as TraceId,
    },
    stepId: result.stepId as StepId,
    inputRef: outputRef,
  });

  console.warn(
    `[applyAgentDecision] contract-bound complete carried a non-decodable string result for run ${result.sessionId}; ` +
      `looped back to the agent turn (retry ${String(newRetryCount)}/${String(MAX_OUTPUT_CONTRACT_RETRIES)})`,
  );
  return true;
}
