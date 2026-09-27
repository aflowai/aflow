import { describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  IdempotencyKey,
  AgentDefinition,
  StepDefinition,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { getSessionState } from '@aflow/redis';
import { pauseForMissingVariables } from '../inputPause.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const RUN = '265a4135-2103-48f2-92ae-344c77c2c006' as SessionId;
const PARENT = '511c5fce-94b2-4347-ae8b-bdd532e6e3c4';
const PARENT_STEP = '6557a3ec-82db-4bef-8e36-2e05f1bfb861';

const stepDef = {
  stepId: 'execute' as StepId,
  stepType: 'ai',
  operation: 'ai.agent.turn',
  name: 'Execute',
  config: {},
  tags: [],
} as unknown as StepDefinition;

const agentDef = {
  startStepId: 'execute',
  steps: [stepDef],
  stateVariables: [
    {
      variableId: 'prompt',
      name: 'Prompt',
      lifecycle: { isInput: true, isOutput: false },
      required: true,
    },
  ],
} as unknown as AgentDefinition;

async function pauseWithLinkage(redis: Redis) {
  return pauseForMissingVariables(
    redis,
    {} as PayloadStore,
    TENANT,
    RUN,
    '92e4a368-d58d-4713-a12f-303fef860712' as StepExecutionId,
    'execute' as StepId,
    { kind: 'platform-role', systemRole: 'cybernetic-runner' },
    '1',
    undefined,
    'user-1',
    'trace-1',
    `${RUN}:92e4a368-d58d-4713-a12f-303fef860712:1` as IdempotencyKey,
    stepDef,
    { schemaVersion: 1, variables: {}, version: 0, updatedAtMs: Date.now() },
    ['prompt'],
    agentDef,
    Date.now(),
    undefined,
    undefined,
    undefined,
    {
      parentSessionId: PARENT,
      parentStepExecutionId: PARENT_STEP,
      workflowExecution: { runId: 'wf-run-1', taskId: 'decide', attempt: 1 },
    },
  );
}

describe('pauseForMissingVariables linkage carryover', () => {
  // The pause writes its session literal through atomicCreateSession, which
  // DELs the hash first — anything not in the literal is destroyed. A
  // delegated child or workflow-task runner that paused here used to lose its
  // parent/workflow linkage: contract intact, but no reconcile could ever
  // find the parent again.
  it('a delegated runner pausing at start keeps the linkage that makes it reachable', async () => {
    const redis = new RedisMock() as unknown as Redis;

    const result = await pauseWithLinkage(redis);
    expect(result.status).toBe('PAUSED');
    expect(result.requestedInputRef).toMatch(/^inline:/);

    const state = await getSessionState(redis, TENANT, RUN);
    expect(state?.parentSessionId).toBe(PARENT);
    expect(state?.parentStepExecutionId).toBe(PARENT_STEP);
    expect(state?.workflowExecution).toEqual({ runId: 'wf-run-1', taskId: 'decide', attempt: 1 });
    expect(state?.requestedInputRef).toBe(result.requestedInputRef);
    expect(state?.status).toBe('PAUSED');
  });
});
