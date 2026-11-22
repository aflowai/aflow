/**
 * space.autonomy.update (Plan 345 D): the Helmsman's write of its own space's
 * autonomy setting. It writes only the run's space, through the route's write
 * path, and only for a session whose user is an admin of that space.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceAutonomyPolicy, StepDefinition } from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { SpaceAutonomyUpdateOutputSchema } from '@aflow/schemas';

const mockAddStepResult = vi.hoisted(() => vi.fn());
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@aflow/database')>();
  return { ...orig, getDatabase: () => ({}) as never };
});

const state = vi.hoisted(() => ({
  user: '00000000-0000-4000-8000-0000000000aa' as string | undefined,
  admin: true,
  stored: null as SpaceAutonomyPolicy | null,
  found: true,
}));
const mockIsSpaceAdmin = vi.hoisted(() => vi.fn());
const mockWrite = vi.hoisted(() => vi.fn());
vi.mock('../sessionUser.js', () => ({ sessionUser: async () => state.user }));
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...orig,
    isSpaceAdmin: async (...args: unknown[]) => {
      mockIsSpaceAdmin(...args);
      return state.admin;
    },
    readStoredSpaceAutonomyPolicy: async () => state.stored,
    writeSpaceAutonomyPolicy: async (args: { policy: SpaceAutonomyPolicy | null }) => {
      mockWrite(args);
      return state.found ? { autonomyPolicy: args.policy } : undefined;
    },
  };
});

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const RUN = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeRef(ref: string): unknown {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
}

function makeArgs(resolvedInput: unknown) {
  return {
    redis: { tag: 'redis' } as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      traceId: 'trace-1',
      agentDefinition: { steps: [] } as never,
    },
    stepDef: {
      stepId: 'step-1',
      stepType: 'space',
      operation: 'space.autonomy.update',
      tags: [],
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition,
    stepExecutionId: 'step-exec-1',
    idempotencyKey: 'idempotent-1' as never,
    resolvedInputRef: inlineRef(resolvedInput),
    attempt: 1,
    scheduledAtMs: Date.now(),
  } as never;
}

function lastStepResult(): Record<string, unknown> {
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  return mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
}

const { handleSpaceAutonomyUpdateInline } = await import('../spaceAutonomy.js');

beforeEach(() => {
  vi.clearAllMocks();
  state.user = USER;
  state.admin = true;
  state.stored = null;
  state.found = true;
});

describe('space.autonomy.update', () => {
  it("writes the run's own space for an admin, on the route's write path", async () => {
    await handleSpaceAutonomyUpdateInline(makeArgs({ autonomy: 'full' }));

    const result = lastStepResult();
    expect(result['status']).toBe('SUCCEEDED');
    const output = SpaceAutonomyUpdateOutputSchema.parse(decodeRef(result['outputRef'] as string));
    expect(output).toEqual({
      autonomyPolicy: { autonomy: 'full' },
      resolved: { autonomy: 'full', storeUpdates: 'follow-catalog' },
    });
    expect(mockIsSpaceAdmin).toHaveBeenCalledWith({}, TENANT, SPACE, USER);
    expect(mockWrite).toHaveBeenCalledWith({
      db: {},
      redis: { tag: 'redis' },
      tenantId: TENANT,
      spaceId: SPACE,
      policy: { autonomy: 'full' },
    });
  });

  it('keeps a stored field the input leaves out, and writes no default in', async () => {
    state.stored = { storeUpdates: 'manual' };
    await handleSpaceAutonomyUpdateInline(makeArgs({ autonomy: 'full' }));

    expect(lastStepResult()['status']).toBe('SUCCEEDED');
    expect(mockWrite.mock.calls[0]![0]).toMatchObject({
      policy: { autonomy: 'full', storeUpdates: 'manual' },
    });
  });

  it('refuses a session whose user is not an admin of the space, and writes nothing', async () => {
    state.admin = false;
    await handleSpaceAutonomyUpdateInline(makeArgs({ autonomy: 'full' }));

    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect(result['error']).toMatchObject({ code: 'SPACE_AUTONOMY_UPDATE_FORBIDDEN' });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a session that names no user, and writes nothing', async () => {
    state.user = undefined;
    await handleSpaceAutonomyUpdateInline(makeArgs({ autonomy: 'ratify' }));

    expect(lastStepResult()['error']).toMatchObject({ code: 'SPACE_AUTONOMY_UPDATE_FORBIDDEN' });
    expect(mockIsSpaceAdmin).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses an input that names neither field, or names a space', async () => {
    await handleSpaceAutonomyUpdateInline(makeArgs({}));
    expect(lastStepResult()['error']).toMatchObject({
      code: 'SPACE_AUTONOMY_UPDATE_INVALID_INPUT',
    });

    mockAddStepResult.mockClear();
    await handleSpaceAutonomyUpdateInline(makeArgs({ autonomy: 'full', spaceId: SPACE }));
    expect(lastStepResult()['error']).toMatchObject({
      code: 'SPACE_AUTONOMY_UPDATE_INVALID_INPUT',
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
