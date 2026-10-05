import type { SessionId, StepExecutionId, IdempotencyKey } from '@aflow/schemas';
import { AgentResumeInputSchema } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import {
  addStepResult,
  addControlMessage,
  getSessionState,
  updateSessionState,
  addWaitingChild,
  abortDelegationLifecycle,
} from '@aflow/redis';
import type { InlineHandlerArgs } from './types.js';
import { attendedAsActingRun } from './actingRun.js';

export async function handleResumeInline(args: InlineHandlerArgs): Promise<void> {
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

    // Parse via the schema so defaults (`wait: 'until_pause'`) and the
    // 'true'/'false' string preprocessor fire consistently. Reading raw input
    // bypasses these guarantees and surfaced as a real bug: when the LLM
    // omitted `wait` (or passed `wait: true`), the parent's
    // `delegationWaitMode` was never set to `'until_pause'`, so when the
    // child paused the bubble fell through to the user-input pause path
    // instead of returning a structured handoff result to the parent agent.
    const parsed = AgentResumeInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`agent.control.resume input failed schema validation: ${issues}`);
    }
    const { childSessionId, message, wait } = parsed.data;

    // After parsing, `wait` is `boolean | 'until_pause'`. Map onto the
    // 3-valued waitMode the delegation helpers accept.
    const waitMode: 'true' | 'until_pause' | 'false' =
      wait === 'until_pause' ? 'until_pause' : !wait ? 'false' : 'true';

    // Verify child session exists and belongs to this parent
    const childState = await getSessionState(redis, context.tenantId, childSessionId);
    if (!childState) {
      throw new Error(`Child session "${childSessionId}" not found or has expired.`);
    }

    // Don't try to resume sessions that are already terminal or running.
    // Return a descriptive error so the agent knows to stop retrying.
    if (
      childState.status === 'SUCCEEDED' ||
      childState.status === 'FAILED' ||
      childState.status === 'CANCELLED'
    ) {
      throw new Error(
        `Child session "${childSessionId}" is already ${childState.status} — nothing to resume.`,
      );
    }
    if (childState.status === 'RUNNING' || childState.status === 'QUEUED') {
      throw new Error(
        `Child session "${childSessionId}" is ${childState.status}, not paused — it may still be processing.`,
      );
    }

    // Re-parent and ALWAYS update parentStepExecutionId.
    //
    // Cross-session: a new Executive session picking up a Driver from a
    // previous conversation needs both fields updated for cross-session
    // continuity.
    //
    const reparentUpdates: Parameters<typeof updateSessionState>[3] = {
      parentStepExecutionId: stepExecutionId,
    };
    if (childState.parentSessionId !== context.runId) {
      reparentUpdates.parentSessionId = context.runId;
    }
    await updateSessionState(redis, context.tenantId, childSessionId, reparentUpdates);

    // The child must have a current step execution ID (the paused step)
    const childStepExecId = childState.currentStepExecutionId;
    if (!childStepExecId) {
      throw new Error(
        `Child session "${childSessionId}" has no current step — it may have already completed.`,
      );
    }

    // Send resume control message to child with the follow-up message
    const resumeInputRef = `inline:${Buffer.from(JSON.stringify({ prompt: message })).toString('base64')}`;
    const actingRun = await getSessionState(redis, context.tenantId, context.runId);

    await addControlMessage(redis, {
      messageVersion: 1,
      type: 'resume_run',
      tenantId: context.tenantId,
      runId: childSessionId as SessionId,
      stepExecutionId: childStepExecId as StepExecutionId,
      inputRef: resumeInputRef,
      traceId: context.traceId,
      idempotencyKey: `resume:${context.runId}:${stepExecutionId}` as IdempotencyKey,
      requestedAtMs: Date.now(),
      activatedByPerson: attendedAsActingRun(actingRun),
    });

    await abortDelegationLifecycle(redis, context.tenantId, childSessionId);

    await addWaitingChild(redis, context.tenantId, context.runId, stepExecutionId, childSessionId);
    const { enterChildWait } = await import('../../helpers/delegationState.js');
    await enterChildWait(redis, context.tenantId, context.runId, { waitMode });

    getOrchestratorLogger().debug(
      `[SessionOrchestrator] agent.control.resume: resuming child session ${childSessionId} ` +
        `with message (wait=${waitMode})`,
    );

    // Emit PAUSED — parent waits for child to respond
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
      stepType: stepDef.stepType,
      operationId: stepDef.operation,
      attempt,
      idempotencyKey,
      status: 'PAUSED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  } catch (err) {
    const errorData = {
      code: 'RESUME_FAILED',
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
      stepType: stepDef.stepType,
      operationId: stepDef.operation,
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
