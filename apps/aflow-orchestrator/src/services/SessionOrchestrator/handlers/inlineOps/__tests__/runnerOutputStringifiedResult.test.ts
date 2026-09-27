import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { setSessionState, SHARD_COUNT, type SessionHotState } from '@aflow/redis';
import { StreamKeys } from '@aflow/schemas';
import type {
  IdempotencyKey,
  SessionId,
  StepDefinition,
  StepExecutionId,
  SystemRole,
  TenantId,
} from '@aflow/schemas';

const mockGetDatabase = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
  };
});

// The value under test now reaches submit through the draft, not the tool
// input. These tests are about what submit DOES with a materialized value —
// the store that produces it is covered by taskDraftStore.test.ts.
const mockMaterialize = vi.fn();
vi.mock('../taskDraft.js', async () => {
  const actual = await vi.importActual<typeof import('../taskDraft.js')>('../taskDraft.js');
  return {
    ...actual,
    materializeDraftForSubmit: (...args: unknown[]) => mockMaterialize(...args),
  };
});

function draftHolding(content: unknown): void {
  mockMaterialize.mockResolvedValue({ ok: true, content, revision: 3 });
}

const { handleSubmitOutputInline } = await import('../runnerOutput.js');
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SESSION = '55555555-5555-5555-5555-555555555555' as SessionId;
const STEP_EXEC = '66666666-6666-6666-6666-666666666666' as StepExecutionId;
const SPACE = '44444444-4444-4444-4444-444444444444';

const OBJECT_SCHEMA = {
  type: 'object',
  required: ['apiDefinition'],
  additionalProperties: false,
  properties: {
    apiDefinition: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
};

function runnerSession(outputSchema?: Record<string, unknown>): SessionHotState {
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
      taskId: 'draft',
      attempt: 1,
    },
    ...(outputSchema ? { finalOutputSchemaOverrideJson: JSON.stringify(outputSchema) } : {}),
    delegationDisplayWorkflowSlug: 'bind-capability',
  };
}

function makeArgs(redis: RedisType, input: Record<string, unknown>): InlineHandlerArgs {
  return {
    redis,
    payloadStore: {
      retrieve: async () => input,
      shouldStore: () => false,
      store: async () => {
        throw new Error('payloadStore.store should not be called');
      },
    } as never,
    context: {
      tenantId: TENANT,
      runId: SESSION,
      traceId: 'trace-stringified-1',
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
    idempotencyKey: 'idem-stringified-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: 1000,
  };
}

interface EmittedResult {
  status: string;
  outputRef?: string;
  errorRef?: string;
}

async function readEmittedResults(
  redis: RedisType,
  stepExecutionId: string,
): Promise<EmittedResult[]> {
  const results: EmittedResult[] = [];
  for (let shardId = 0; shardId < SHARD_COUNT; shardId++) {
    const key = StreamKeys.shardResultsStream(shardId);
    const entries = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
    for (const [, fields] of entries) {
      const map = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) {
        const k = fields[i];
        const v = fields[i + 1];
        if (k !== undefined && v !== undefined) map.set(k, v);
      }
      if (map.get('stepExecutionId') !== stepExecutionId) continue;
      results.push({
        status: map.get('status') ?? '',
        ...(map.has('outputRef') ? { outputRef: map.get('outputRef')! } : {}),
        ...(map.has('errorRef') ? { errorRef: map.get('errorRef')! } : {}),
      });
    }
  }
  return results;
}

function decodeInlineRef(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.replace(/^inline:/, ''), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('submit_output — JSON-stringified result decoding', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as RedisType;
    await redis.flushall();
    mockGetDatabase.mockReset();
    mockMaterialize.mockReset();
    mockGetDatabase.mockImplementation(() => {
      throw new Error('no db in this test');
    });
  });

  it('accepts a stringified object that validates after decode, emitting the OBJECT form', async () => {
    await setSessionState(redis, runnerSession(OBJECT_SCHEMA));
    draftHolding(JSON.stringify({ apiDefinition: { name: 'Vercel' } }));

    await handleSubmitOutputInline(makeArgs(redis, {}));

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SUCCEEDED');
    const output = decodeInlineRef(results[0]!.outputRef!);
    expect(output['apiDefinition']).toEqual({ name: 'Vercel' });
  });

  it('fails a stringified object whose decoded form also violates the contract, with the string hint', async () => {
    await setSessionState(redis, runnerSession(OBJECT_SCHEMA));
    draftHolding(JSON.stringify({ wrongField: true }));

    await handleSubmitOutputInline(makeArgs(redis, {}));

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('FAILED');
    const error = decodeInlineRef(results[0]!.errorRef!);
    // The repair is a draft operation now: there is no `result` parameter to
    // re-send a decoded object through.
    const text = JSON.stringify(error);
    expect(text).toContain('JSON string whose decoded form also fails');
    expect(text).toContain('replace the draft root');
    expect(text).not.toContain('pass `result`');
  });

  it('decodes a stringified container on a contract-less task so bindings see the object', async () => {
    await setSessionState(redis, runnerSession());
    draftHolding(JSON.stringify({ catalogId: 'vercel', expectedVersion: 1 }));

    await handleSubmitOutputInline(makeArgs(redis, {}));

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SUCCEEDED');
    const output = decodeInlineRef(results[0]!.outputRef!);
    expect(output['catalogId']).toBe('vercel');
  });

  it('leaves a plain string result untouched when the contract accepts a string', async () => {
    await setSessionState(
      redis,
      runnerSession({
        type: 'object',
        required: ['result'],
        properties: { result: { type: 'string' } },
      }),
    );

    draftHolding({ result: '{"looks":"like json"}' });

    await handleSubmitOutputInline(makeArgs(redis, {}));

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SUCCEEDED');
    const output = decodeInlineRef(results[0]!.outputRef!);
    expect(output['result']).toBe('{"looks":"like json"}');
  });
});
