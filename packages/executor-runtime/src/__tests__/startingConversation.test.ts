/**
 * The conversation that started a workflow task's run reaches the handler as
 * the orchestrator stamped it on the job, and only so: a job carrying none
 * gives the handler none, whatever its run is, so nothing downstream can take
 * the run for a conversation.
 */
import { describe, expect, it } from 'vitest';
import type { StepJobMessage } from '@aflow/schemas';
import { buildExecutionContext } from '../executor/buildContext.js';
import type { ExecutorDependencies, ExecutorLogger } from '../types.js';

const RUN = 'e0000000-0000-4000-8000-000000000005';
const CONVERSATION = 'f0000000-0000-4000-8000-000000000006';

const log: ExecutorLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const deps = { payloadStore: {} as never, redis: {} as never } as ExecutorDependencies;

function workflowJob(overrides: Partial<StepJobMessage> = {}): StepJobMessage {
  return {
    messageVersion: 1,
    tenantId: 'a0000000-0000-4000-8000-000000000001',
    workflowExecution: {
      runId: RUN,
      taskId: 'commission',
      attempt: 1,
      dispatchAttemptToken: `dispatch:${RUN}:commission:1`,
    },
    stepExecutionId: 'c0000000-0000-4000-8000-000000000003',
    stepId: 'commission',
    stepType: 'host',
    operationId: 'host.harness.run',
    attempt: 1,
    idempotencyKey: 'idem-1',
    inputRef: 'inline:e30=',
    traceId: 'trace-1',
    scheduledAtMs: 1,
    ...overrides,
  } as StepJobMessage;
}

describe('the conversation that started a workflow task’s run', () => {
  it('is on the context as the job carries it, beside the run', async () => {
    const ctx = await buildExecutionContext(
      deps,
      workflowJob({ startingConversationId: CONVERSATION as never }),
      log,
    );
    expect(ctx.startingConversationId).toBe(CONVERSATION);
    expect(ctx.runId).toBe(RUN);
  });

  it('is absent from the context when the job carries none', async () => {
    const ctx = await buildExecutionContext(deps, workflowJob(), log);
    expect('startingConversationId' in ctx).toBe(false);
    expect(ctx.runId).toBe(RUN);
  });
});
