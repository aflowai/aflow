import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { setSessionState, SHARD_COUNT, type SessionHotState } from '@aflow/redis';
import { registerRuntimeValidator, RuntimeValidatorFault, StreamKeys } from '@aflow/schemas';
import type {
  IdempotencyKey,
  SessionId,
  StepDefinition,
  StepExecutionId,
  SystemRole,
  TenantId,
} from '@aflow/schemas';

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, getDatabase: () => ({}) };
});

const mockMaterialize = vi.fn();
vi.mock('../taskDraft.js', async () => {
  const actual = await vi.importActual<typeof import('../taskDraft.js')>('../taskDraft.js');
  return {
    ...actual,
    materializeDraftForSubmit: (...args: unknown[]) => mockMaterialize(...args),
  };
});

const { handleSubmitOutputInline } = await import('../runnerOutput.js');
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SESSION = '55555555-5555-5555-5555-555555555555' as SessionId;
const STEP_EXEC = '66666666-6666-6666-6666-666666666667' as StepExecutionId;
const SPACE = '44444444-4444-4444-4444-444444444444';

const FAULTING_REF = 'test.validator-input-fault';
const THROWING_REF = 'test.validator-defect';
registerRuntimeValidator(FAULTING_REF, () =>
  Promise.reject(new RuntimeValidatorFault(FAULTING_REF, new Error('connection terminated'))),
);
registerRuntimeValidator(THROWING_REF, () => Promise.reject(new Error('a validator defect')));

const SCHEMA = {
  type: 'object',
  required: ['tradingDay'],
  properties: { tradingDay: { type: 'string' } },
};

function runnerSession(validatorRef: string): SessionHotState {
  return {
    sessionId: SESSION,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-runner' as SystemRole },
    agentVersion: 'latest',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    spaceId: SPACE,
    workflowExecution: {
      runId: '33333333-3333-3333-3333-333333333333',
      taskId: 'gather-regime',
      attempt: 1,
    },
    finalOutputSchemaOverrideJson: JSON.stringify(SCHEMA),
    finalOutputValidatorRefs: [validatorRef],
  };
}

function makeArgs(redis: RedisType): InlineHandlerArgs {
  return {
    redis,
    payloadStore: {
      retrieve: async () => ({}),
      shouldStore: () => false,
      store: async () => {
        throw new Error('payloadStore.store should not be called');
      },
    } as never,
    context: {
      tenantId: TENANT,
      runId: SESSION,
      traceId: 'trace-validator-fault-1',
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'submit_output',
      stepType: 'agent',
      operation: 'agent.control.submit_output',
      name: 'Terminal',
      config: {},
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition,
    stepExecutionId: STEP_EXEC,
    idempotencyKey: 'idem-validator-fault-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: 1000,
  };
}

async function emitted(redis: RedisType): Promise<Array<{ status: string; errorRef?: string }>> {
  const results: Array<{ status: string; errorRef?: string }> = [];
  for (let shardId = 0; shardId < SHARD_COUNT; shardId++) {
    const entries = (await redis.xrange(StreamKeys.shardResultsStream(shardId), '-', '+')) as Array<
      [string, string[]]
    >;
    for (const [, fields] of entries) {
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
      if (map.get('stepExecutionId') !== STEP_EXEC) continue;
      results.push({
        status: map.get('status') ?? '',
        ...(map.has('errorRef') ? { errorRef: map.get('errorRef')! } : {}),
      });
    }
  }
  return results;
}

const decode = (ref: string) => Buffer.from(ref.replace(/^inline:/, ''), 'base64').toString('utf8');

describe('submit_output — a validator that cannot read its inputs', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as RedisType;
    await redis.flushall();
    mockMaterialize.mockReset();
    mockMaterialize.mockResolvedValue({ ok: true, content: { tradingDay: '2026-07-14' } });
  });

  it('refuses the output rather than passing it', async () => {
    await setSessionState(redis, runnerSession(FAULTING_REF));
    await handleSubmitOutputInline(makeArgs(redis));

    const results = await emitted(redis);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('FAILED');
    const error = decode(results[0]!.errorRef!);
    expect(error).toContain('OUTPUT_VALIDATOR_FAULT');
    expect(error).toContain('connection terminated');
  });

  it('still passes the output through on any other validator throw', async () => {
    await setSessionState(redis, runnerSession(THROWING_REF));
    await handleSubmitOutputInline(makeArgs(redis));

    const results = await emitted(redis);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SUCCEEDED');
  });
});
