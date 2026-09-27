/**
 * learner.learning.resolve — op parity with the REST resolve route: the
 * handler delegates to the shared resolveLearning authority, attributes the
 * resolution to the session's initiating user, and maps the shared result
 * codes onto step success/error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';

const mockAddStepResult = vi.fn();
const mockGetSessionStateSafe = vi.fn();

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
    getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
  };
});

const mockResolveLearning = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    resolveLearning: (...args: unknown[]) => mockResolveLearning(...args),
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, getDatabase: () => ({}) };
});

vi.mock('../coachCrudMemory.js', () => ({
  getCoachCrudRepos: () => ({ db: {}, tenantCtx: {}, docRepo: {}, dirRepo: {} }),
  writeCoachJsonDoc: vi.fn(),
}));

const { handleCoachCrudInline } = await import('../coachCrud.js');
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const LEARNING_ID = '00000000-0000-0000-0000-0000000000b1';
const OPERATOR = 'user-42';

function makeArgs(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      shouldStore: vi.fn(() => false),
      store: vi.fn(),
      retrieve: vi.fn(async (ref: string) =>
        JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')),
      ),
    } as never,
    context: {
      tenantId: TENANT,
      runId: 'session-1',
      traceId: 'trace-learning-resolve',
      spaceId: SPACE,
    } as never,
    stepDef: {
      stepId: 'resolve-learning',
      stepType: 'learner',
      operation: 'learner.learning.resolve',
    } as unknown as StepDefinition,
    stepExecutionId: 'exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: inputRef,
    attempt: 1,
    scheduledAtMs: 0,
  };
}

function resultMessage(): Record<string, unknown> {
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  return mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
}

function decodedOutput(): Record<string, unknown> {
  const ref = resultMessage()['outputRef'] as string;
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveLearning.mockResolvedValue({ ok: true });
  mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { createdBy: OPERATOR } });
});

describe('learner.learning.resolve op handler', () => {
  it('ratifies through the shared authority, attributed to the initiating user', async () => {
    await handleCoachCrudInline(makeArgs({ learningId: LEARNING_ID, action: 'ratify' }));

    expect(mockResolveLearning).toHaveBeenCalledOnce();
    expect(mockResolveLearning.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      learningId: LEARNING_ID,
      action: 'ratify',
      operatorUserId: OPERATOR,
    });

    expect(resultMessage()['status']).toBe('SUCCEEDED');
    expect(decodedOutput()).toEqual({ learningId: LEARNING_ID, status: 'ratified' });
  });

  it('rejects through the same authority', async () => {
    await handleCoachCrudInline(makeArgs({ learningId: LEARNING_ID, action: 'reject' }));

    expect(mockResolveLearning.mock.calls[0]![0]).toMatchObject({ action: 'reject' });
    expect(decodedOutput()).toEqual({ learningId: LEARNING_ID, status: 'rejected' });
  });

  it('falls back to the session id when hot state has no initiator', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: false });

    await handleCoachCrudInline(makeArgs({ learningId: LEARNING_ID, action: 'ratify' }));

    expect(mockResolveLearning.mock.calls[0]![0]).toMatchObject({ operatorUserId: 'session-1' });
  });

  it('maps 404 to LEARNING_NOT_FOUND', async () => {
    mockResolveLearning.mockResolvedValue({
      ok: false,
      status: 404,
      detail: 'Learning not found.',
    });

    await handleCoachCrudInline(makeArgs({ learningId: LEARNING_ID, action: 'ratify' }));

    const msg = resultMessage();
    expect(msg['status']).toBe('FAILED');
    expect((msg['error'] as { code: string }).code).toBe('LEARNING_NOT_FOUND');
  });

  it('maps 409 to LEARNING_NOT_RESOLVABLE with the teaching detail', async () => {
    mockResolveLearning.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Only a staged (proposed) learning can be ratified.',
    });

    await handleCoachCrudInline(makeArgs({ learningId: LEARNING_ID, action: 'ratify' }));

    const msg = resultMessage();
    expect(msg['status']).toBe('FAILED');
    const error = msg['error'] as { code: string; message: string };
    expect(error.code).toBe('LEARNING_NOT_RESOLVABLE');
    expect(error.message).toContain('staged (proposed)');
  });
});
