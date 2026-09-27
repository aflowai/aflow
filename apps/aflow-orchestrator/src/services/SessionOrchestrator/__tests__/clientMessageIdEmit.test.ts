import { describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { readSessionEvents } from '@aflow/redis';
import {
  AgentDefinitionSchema,
  type IdempotencyKey,
  type SessionId,
  type StepExecutionId,
  type SystemRole,
  type TenantId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { pauseForMissingVariables } from '../helpers/inputPause.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;

const agentDef = AgentDefinitionSchema.parse({
  flowId: 'pause-at-creation-agent',
  version: '1.0.0',
  metadata: { name: 'Pause At Creation' },
  stateVariables: [
    {
      variableId: 'message',
      name: 'Message',
      typeSchema: { type: 'string' },
      semanticType: 'text',
      lifecycle: { isInput: true, isOutput: false },
      required: true,
    },
    {
      variableId: 'audience',
      name: 'Audience',
      typeSchema: { type: 'string' },
      lifecycle: { isInput: true, isOutput: false },
      required: true,
    },
  ],
  steps: [{ stepId: 'start', stepType: 'ai', operation: 'ai.generate' }],
  startStepId: 'start',
});

async function pauseAndReadStartEvent(
  runId: SessionId,
  stepExecutionId: StepExecutionId,
  clientMessageId: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  const redis = new RedisMock() as unknown as RedisType;
  const stepDef = agentDef.steps[0];
  if (!stepDef) throw new Error('fixture has no start step');

  const result = await pauseForMissingVariables(
    redis,
    {} as unknown as PayloadStore,
    TENANT,
    runId,
    stepExecutionId,
    agentDef.startStepId,
    { kind: 'platform-role', systemRole: 'cybernetic-helmsman' as SystemRole },
    '1',
    'inline:e30=',
    undefined, // createdBy
    undefined, // traceId
    `idem-${runId}` as IdempotencyKey,
    stepDef,
    undefined, // runtimeState
    ['audience'],
    agentDef,
    Date.now(),
    { message: 'hello from chat' },
    undefined, // spaceId
    clientMessageId,
  );
  expect(result.status).toBe('PAUSED');

  const { events } = await readSessionEvents(redis, TENANT, runId);
  const started = events.find((e) => e.eventType === 'SessionStarted');
  expect(started).toBeDefined();
  return started?.metadata;
}

describe('pauseForMissingVariables SessionStarted emit (Plan 192 Phase 1)', () => {
  it('carries clientMessageId beside userMessage when provided', async () => {
    const metadata = await pauseAndReadStartEvent(
      'b0000000-0000-4000-8000-000000000002' as SessionId,
      'c0000000-0000-4000-8000-000000000003' as StepExecutionId,
      '123e4567-e89b-12d3-a456-426614174000',
    );
    expect(metadata?.['userMessage']).toBe('hello from chat');
    expect(metadata?.['clientMessageId']).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('omits clientMessageId when the caller did not mint one (API/MCP path)', async () => {
    const metadata = await pauseAndReadStartEvent(
      'b0000000-0000-4000-8000-000000000012' as SessionId,
      'c0000000-0000-4000-8000-000000000013' as StepExecutionId,
      undefined,
    );
    expect(metadata?.['userMessage']).toBe('hello from chat');
    expect(metadata && 'clientMessageId' in metadata).toBe(false);
  });
});
