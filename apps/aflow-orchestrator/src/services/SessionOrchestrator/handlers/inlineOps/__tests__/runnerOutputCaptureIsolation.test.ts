import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { setSessionState, SHARD_COUNT, type SessionHotState } from '@aflow/redis';
import { readReflectionCompleteness } from '@aflow/cybernetic-runtime';
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

// Submission takes its value from the draft, and these tests mock getDatabase
// into failure — which would fail materialization too and mask the capture
// behaviour they exist to pin. The draft store has its own tests; here it is
// stubbed so the subject stays the capture path.
const mockMaterialize = vi.fn();
vi.mock('../taskDraft.js', async () => {
  const actual = await vi.importActual<typeof import('../taskDraft.js')>('../taskDraft.js');
  return {
    ...actual,
    materializeDraftForSubmit: (...args: unknown[]) => mockMaterialize(...args),
  };
});

const { handleSubmitOutputInline, handleSignalBlockedInline } = await import('../runnerOutput.js');
import type { InlineHandlerArgs } from '../types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SESSION = '11111111-1111-1111-1111-111111111111' as SessionId;
const STEP_EXEC = '22222222-2222-2222-2222-222222222222' as StepExecutionId;
const WORKFLOW_RUN = '33333333-3333-3333-3333-333333333333';
const SPACE = '44444444-4444-4444-4444-444444444444';

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

function runnerSession(): SessionHotState {
  return {
    sessionId: SESSION,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-runner' as SystemRole },
    agentVersion: 'latest',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    spaceId: SPACE,
    workflowExecution: { runId: WORKFLOW_RUN, taskId: 'synthesize', attempt: 1 },
    finalOutputSchemaOverrideJson: JSON.stringify(OUTPUT_SCHEMA),
    delegationDisplayWorkflowSlug: 'test-skill',
  };
}

/**
 * A DB stub whose every access yields a never-resolving promise — pins the
 * async capture at its first DB touch without rejecting it.
 */
function hangingDb(): unknown {
  const hang = () => new Promise(() => undefined);
  return new Proxy(
    {},
    {
      get: () => hang,
    },
  );
}

function makeArgs(
  redis: RedisType,
  input: Record<string, unknown>,
  operation: 'agent.control.submit_output' | 'agent.control.signal_blocked',
): InlineHandlerArgs {
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
      traceId: 'trace-capture-1',
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: operation === 'agent.control.submit_output' ? 'submit_output' : 'signal_blocked',
      stepType: 'agent',
      operation,
      name: 'Terminal',
      config: {},
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition,
    stepExecutionId: STEP_EXEC,
    idempotencyKey: 'idem-capture-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: 1000,
  };
}

interface EmittedResult {
  status: string;
  errorRef?: string;
  requestedInputRef?: string;
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
        ...(map.has('errorRef') ? { errorRef: map.get('errorRef')! } : {}),
        ...(map.has('requestedInputRef')
          ? { requestedInputRef: map.get('requestedInputRef')! }
          : {}),
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

const VALID_SUBMIT_INPUT = {
  result: { summary: 'done' },
};

describe('runnerOutput — reflection capture never blocks or fails completion', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as RedisType;
    // ioredis-mock shares the emulated store across instances — isolate tests.
    await redis.flushall();
    mockGetDatabase.mockReset();
    mockMaterialize.mockReset();
    mockMaterialize.mockResolvedValue({ ok: true, content: { summary: 'done' }, revision: 2 });
    await setSessionState(redis, runnerSession());
  });

  it('(a1) submit_output: getDatabase throwing does not block or fail the SUCCEEDED result', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('database unavailable');
    });

    await expect(
      handleSubmitOutputInline(makeArgs(redis, VALID_SUBMIT_INPUT, 'agent.control.submit_output')),
    ).resolves.toBeUndefined();

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SUCCEEDED');
    // The expected-marker INCR ran BEFORE the completion result (the
    // barrier contract) even though the capture launch itself failed.
    const counts = await readReflectionCompleteness(redis, TENANT, WORKFLOW_RUN);
    expect(counts.expected).toBe(1);
    expect(counts.captured).toBe(0);
  });

  it('(a2) submit_output: a redis whose incr rejects (expected-marker failure) is isolated', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    (redis as { incr: (...args: unknown[]) => Promise<never> }).incr = () =>
      Promise.reject(new Error('redis ECONNRESET'));

    await expect(
      handleSubmitOutputInline(makeArgs(redis, VALID_SUBMIT_INPUT, 'agent.control.submit_output')),
    ).resolves.toBeUndefined();

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SUCCEEDED');
  });

  it('(b) submit_output: SUCCEEDED is emitted even when the capture promise never settles', async () => {
    // Capture pins forever at its first DB touch — if a refactor awaited the
    // capture, this handler call would never resolve and the test would
    // time out.
    mockGetDatabase.mockReturnValue(hangingDb());

    await expect(
      handleSubmitOutputInline(makeArgs(redis, VALID_SUBMIT_INPUT, 'agent.control.submit_output')),
    ).resolves.toBeUndefined();

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SUCCEEDED');
    // Marker math stays balanced for the finalize barrier: expected=1,
    // captured=0 (the pinned capture never lands) — the barrier timeout
    // knob, not the handler, owns that wait.
    const counts = await readReflectionCompleteness(redis, TENANT, WORKFLOW_RUN);
    expect(counts.expected).toBe(1);
    expect(counts.captured).toBe(0);
  });

  it('(c) signal_blocked: capture failures do not block or fail the PAUSED result', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('database unavailable');
    });

    await expect(
      handleSignalBlockedInline(
        makeArgs(
          redis,
          { reason: 'missing the input file', category: 'missing_input', needed: 'input.csv' },
          'agent.control.signal_blocked',
        ),
      ),
    ).resolves.toBeUndefined();

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('PAUSED');
    expect(results[0]!.requestedInputRef).toBeDefined();
    const pausePayload = decodeInlineRef(results[0]!.requestedInputRef!);
    expect(pausePayload['blockingCategory']).toBe('missing_input');
    const counts = await readReflectionCompleteness(redis, TENANT, WORKFLOW_RUN);
    expect(counts.expected).toBe(1);
  });

  it('(c2) signal_blocked: incr rejection is isolated from the PAUSED result', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    (redis as { incr: (...args: unknown[]) => Promise<never> }).incr = () =>
      Promise.reject(new Error('redis ECONNRESET'));

    await expect(
      handleSignalBlockedInline(
        makeArgs(redis, { reason: 'blocked', category: 'other' }, 'agent.control.signal_blocked'),
      ),
    ).resolves.toBeUndefined();

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('PAUSED');
  });

  it('(d) submit_output with no draft: rejected, and no expected-marker INCR', async () => {
    mockMaterialize.mockResolvedValue({
      ok: false,
      detail: 'No draft has been built for this task attempt.',
    });

    await handleSubmitOutputInline(
      makeArgs(redis, { summary: 'nothing built' }, 'agent.control.submit_output'),
    );

    const results = await readEmittedResults(redis, STEP_EXEC);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('FAILED');
    const error = decodeInlineRef(results[0]!.errorRef!);
    expect(error['code']).toBe('SUBMIT_OUTPUT_DRAFT_UNAVAILABLE');
    // A submission that never produced an output must not claim a reflection
    // slot, or the finalize barrier waits on a capture that cannot arrive.
    const counts = await readReflectionCompleteness(redis, TENANT, WORKFLOW_RUN);
    expect(counts.expected).toBe(0);
  });
});
