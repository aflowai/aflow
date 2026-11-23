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
  admins: new Set<string>(['00000000-0000-4000-8000-0000000000aa']),
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
      return state.admins.has(args[3] as string);
    },
    readStoredSpaceAutonomyPolicy: async () => state.stored,
    writeSpaceAutonomyPolicy: async (args: { policy: SpaceAutonomyPolicy | null }) => {
      mockWrite(args);
      if (!state.found) return undefined;
      state.stored = args.policy;
      return { autonomyPolicy: args.policy };
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

const { handleSpaceAutonomyUpdateInline } = await import('../spaceAutonomy.js');

async function run(input: unknown): Promise<Record<string, unknown>> {
  mockAddStepResult.mockClear();
  await handleSpaceAutonomyUpdateInline(makeArgs(input));
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  return mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = USER;
  state.admins = new Set([USER]);
  state.stored = null;
  state.found = true;
});

describe('space.autonomy.update', () => {
  it("raises the run's own space to full for an admin session", async () => {
    const result = await run({ autonomy: 'full' });

    expect(result['status']).toBe('SUCCEEDED');
    const output = SpaceAutonomyUpdateOutputSchema.parse(decodeRef(result['outputRef'] as string));
    expect(output.resolved).toEqual({ autonomy: 'full', storeUpdates: 'follow-catalog' });
    expect(output.autonomyPolicy).toEqual({ autonomy: 'full' });
    expect(mockIsSpaceAdmin).toHaveBeenCalledWith({}, TENANT, SPACE, USER);
    expect(mockWrite.mock.calls[0]![0]).toMatchObject({
      db: {},
      redis: { tag: 'redis' },
      tenantId: TENANT,
      spaceId: SPACE,
      policy: { autonomy: 'full' },
    });
  });

  it('replaces the field it names and keeps the one it leaves out', async () => {
    state.stored = { autonomy: 'full', storeUpdates: 'manual' };
    expect((await run({ autonomy: 'ratify' }))['status']).toBe('SUCCEEDED');
    expect(state.stored).toEqual({ autonomy: 'ratify', storeUpdates: 'manual' });

    expect((await run({ storeUpdates: 'follow-catalog' }))['status']).toBe('SUCCEEDED');
    expect(state.stored).toEqual({ autonomy: 'ratify', storeUpdates: 'follow-catalog' });
  });

  it('refuses a session whose user is not an admin of the space, and writes nothing', async () => {
    state.admins = new Set();
    const result = await run({ autonomy: 'full' });

    expect(result['status']).toBe('FAILED');
    expect(result['error']).toMatchObject({ code: 'SPACE_AUTONOMY_UPDATE_FORBIDDEN' });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a session that names no user, and writes nothing', async () => {
    state.user = undefined;
    expect((await run({ autonomy: 'ratify' }))['error']).toMatchObject({
      code: 'SPACE_AUTONOMY_UPDATE_FORBIDDEN',
    });
    expect(mockIsSpaceAdmin).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('fails where the space is not found, and reports it as such', async () => {
    state.found = false;
    expect((await run({ autonomy: 'full' }))['error']).toMatchObject({
      code: 'SPACE_AUTONOMY_UPDATE_SPACE_NOT_FOUND',
    });
  });

  it('refuses an input that names neither field, names a space, or carries a directive', async () => {
    for (const input of [
      {},
      { autonomy: 'full', spaceId: SPACE },
      { autonomy: 'full', directiveQuote: 'set full autonomy' },
      { autonomy: 'sometimes' },
    ]) {
      expect((await run(input))['error']).toMatchObject({
        code: 'SPACE_AUTONOMY_UPDATE_INVALID_INPUT',
      });
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
