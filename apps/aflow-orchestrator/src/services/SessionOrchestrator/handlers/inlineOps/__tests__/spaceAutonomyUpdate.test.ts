/**
 * space.autonomy.update (Plan 345 D): the Helmsman's write of its own space's
 * autonomy setting. It writes only the run's space, through the route's write
 * path, and only for a session whose user is an admin of that space. A raise
 * to `full` also needs a message the platform attests the operator sent, and
 * each such message authorises one raise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceAutonomyPolicy, StepDefinition } from '@aflow/schemas';
import type { SpaceAutonomyDirectiveRecordRow } from '@aflow/cybernetic-runtime';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { SpaceAutonomyUpdateOutputSchema, WAIT_OUTCOME_ACTOR_ID } from '@aflow/schemas';

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
  records: [] as SpaceAutonomyDirectiveRecordRow[],
}));
const mockReadRecords = vi.hoisted(() => vi.fn());
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
    readSpaceAutonomyDirectiveRecords: async (...args: unknown[]) => {
      mockReadRecords(...args);
      return state.records;
    },
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
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const WORDS = 'Full autonomy please.. nothing waits on me.';
// The whole message, with case and spacing set aside.
const QUOTE = '  full autonomy   please..\nNothing waits on me. ';

function record(
  eventId: string,
  at: string,
  metadata: Record<string, unknown>,
  eventType = 'SessionResumed',
  parentSessionId: string | null = null,
): SpaceAutonomyDirectiveRecordRow {
  return {
    eventId,
    sessionId: CONVERSATION,
    eventType,
    timestamp: new Date(at),
    envelope: { eventId, eventType, metadata },
    parentSessionId,
  };
}

const OPERATOR_MESSAGE = record('44444444-4444-4444-8444-444444444444', '2026-11-21T19:15:00Z', {
  userMessage: WORDS,
  actorUserId: USER,
});

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

const RAISE = { autonomy: 'full', directiveQuote: QUOTE };

beforeEach(() => {
  vi.clearAllMocks();
  state.user = USER;
  state.admins = new Set([USER]);
  state.stored = null;
  state.found = true;
  state.records = [OPERATOR_MESSAGE];
});

describe('space.autonomy.update', () => {
  it("raises the run's own space to full on a message the operator sent, and records it as spent", async () => {
    const result = await run(RAISE);

    expect(result['status']).toBe('SUCCEEDED');
    const output = SpaceAutonomyUpdateOutputSchema.parse(decodeRef(result['outputRef'] as string));
    expect(output.resolved).toEqual({ autonomy: 'full', storeUpdates: 'follow-catalog' });
    expect(output.autonomyPolicy).toEqual({
      autonomy: 'full',
      directive: {
        sessionId: CONVERSATION,
        eventId: OPERATOR_MESSAGE.eventId,
        eventType: 'SessionResumed',
        authorUserId: USER,
        postedAt: '2026-11-21T19:15:00.000Z',
        words: WORDS,
        spentAt: expect.any(String),
      },
    });
    expect(mockReadRecords).toHaveBeenCalledWith({}, TENANT, SPACE);
    expect(mockIsSpaceAdmin).toHaveBeenCalledWith({}, TENANT, SPACE, USER);
    expect(mockWrite.mock.calls[0]![0]).toMatchObject({
      db: {},
      redis: { tag: 'redis' },
      tenantId: TENANT,
      spaceId: SPACE,
    });
  });

  it('raises on a room message the operator posted for the Helmsman', async () => {
    state.records = [
      record(
        '55555555-5555-4555-8555-555555555555',
        '2026-11-21T19:20:00Z',
        { messageSeq: 4, actorUserId: USER, body: WORDS, wakeHelmsman: true },
        'RoomMessage',
      ),
    ];
    expect((await run(RAISE))['status']).toBe('SUCCEEDED');
    expect(state.stored?.directive).toMatchObject({ eventType: 'RoomMessage', authorUserId: USER });
  });

  it('refuses a raise that quotes no directive, and writes nothing', async () => {
    const result = await run({ autonomy: 'full' });

    expect(result['status']).toBe('FAILED');
    expect(result['error']).toMatchObject({ code: 'SPACE_AUTONOMY_RAISE_NEEDS_DIRECTIVE' });
    expect(mockReadRecords).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a raise on words an agent session wrote, and writes nothing', async () => {
    // The Helmsman resuming a session with its own message: no author is stamped.
    const agentResume = record('66666666-6666-4666-8666-666666666666', '2026-11-22T08:00:00Z', {
      userMessage: WORDS,
    });
    // A delegated session's opening prompt, which carries the parent's actor.
    const delegatedStart = record(
      '77777777-7777-4777-8777-777777777777',
      '2026-11-22T07:00:00Z',
      { userMessage: WORDS, actorUserId: USER },
      'SessionStarted',
      RUN,
    );
    for (const agentRecord of [agentResume, delegatedStart]) {
      state.records = [agentRecord];
      const result = await run(RAISE);
      expect(result['status']).toBe('FAILED');
      expect(result['error']).toMatchObject({
        code: 'SPACE_AUTONOMY_DIRECTIVE_AGENT_AUTHORED',
        message: expect.stringContaining(agentRecord.eventId),
      });
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a raise on a record whose authorship cannot be attested, and writes nothing', async () => {
    const unattestable = [
      // An opening message carries whoever started the conversation.
      record(
        '88888888-8888-4888-8888-888888888888',
        '2026-11-22T06:00:00Z',
        { userMessage: WORDS, actorUserId: USER },
        'SessionStarted',
      ),
      // A room line not sent to the Helmsman, as an applet action posts.
      record(
        '99999999-9999-4999-8999-999999999999',
        '2026-11-22T06:00:00Z',
        { messageSeq: 2, actorUserId: USER, body: WORDS, wakeHelmsman: false },
        'RoomMessage',
      ),
      // The platform's notice of a wait's outcome.
      record(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '2026-11-22T06:00:00Z',
        { messageSeq: 3, actorUserId: WAIT_OUTCOME_ACTOR_ID, body: WORDS, wakeHelmsman: true },
        'RoomMessage',
      ),
    ];
    for (const unattested of unattestable) {
      state.records = [unattested];
      expect((await run(RAISE))['error']).toMatchObject({
        code: 'SPACE_AUTONOMY_DIRECTIVE_UNATTESTED',
        message: expect.stringContaining(unattested.eventId),
      });
    }

    // Words no message of the conversation record holds, such as the agent's summary.
    state.records = [OPERATOR_MESSAGE];
    const summary = await run({
      autonomy: 'full',
      directiveQuote: 'raise this space to full autonomy',
    });
    expect(summary['error']).toMatchObject({ code: 'SPACE_AUTONOMY_DIRECTIVE_UNATTESTED' });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('raises on the whole of a message that asks for full autonomy', async () => {
    const asks = record('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2026-11-22T09:00:00Z', {
      userMessage: 'Please set full autonomy for this space.',
      actorUserId: USER,
    });
    state.records = [asks];
    const result = await run({
      autonomy: 'full',
      directiveQuote: 'please set FULL autonomy for this space.',
    });
    expect(result['status']).toBe('SUCCEEDED');
    expect(state.stored?.directive).toMatchObject({
      eventId: asks.eventId,
      words: 'Please set full autonomy for this space.',
    });
  });

  it('refuses a raise on a part of a longer message, even one that asks, and writes nothing', async () => {
    const refusing = record('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '2026-11-22T09:00:00Z', {
      userMessage: 'please do not set full autonomy',
      actorUserId: USER,
    });
    state.records = [refusing, OPERATOR_MESSAGE];
    for (const directiveQuote of ['set full autonomy', 'full autonomy please']) {
      const result = await run({ autonomy: 'full', directiveQuote });
      expect(result['status']).toBe('FAILED');
      expect(result['error']).toMatchObject({ code: 'SPACE_AUTONOMY_DIRECTIVE_PARTIAL_QUOTE' });
    }
    expect(
      (await run({ autonomy: 'full', directiveQuote: 'set full autonomy' }))['error'],
    ).toMatchObject({
      message: expect.stringContaining(refusing.eventId),
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a raise on a whole message that refuses full autonomy, and writes nothing', async () => {
    const refusals = [
      'please do not set full autonomy',
      "Don't set full autonomy yet.",
      'Full autonomy? No.',
      'Keep ratify, not full autonomy.',
      'stop full autonomy',
    ];
    for (const words of refusals) {
      state.records = [
        record('ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-11-22T09:00:00Z', {
          userMessage: words,
          actorUserId: USER,
        }),
      ];
      const result = await run({ autonomy: 'full', directiveQuote: words });
      expect(result['status']).toBe('FAILED');
      expect(result['error']).toMatchObject({ code: 'SPACE_AUTONOMY_DIRECTIVE_REFUSES_RAISE' });
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a raise on a whole message that does not name full autonomy, and writes nothing', async () => {
    for (const words of ['yes', 'the', 'ple', 'absolute autonomy please', 'go full speed']) {
      state.records = [
        record('12121212-1212-4212-8212-121212121212', '2026-11-22T09:00:00Z', {
          userMessage: words,
          actorUserId: USER,
        }),
      ];
      const result = await run({ autonomy: 'full', directiveQuote: words });
      expect(result['status']).toBe('FAILED');
      expect(result['error']).toMatchObject({ code: 'SPACE_AUTONOMY_DIRECTIVE_NAMES_NO_RAISE' });
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a raise on a message whose author is not an admin of the space', async () => {
    state.records = [
      record('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-11-22T06:00:00Z', {
        userMessage: WORDS,
        actorUserId: '00000000-0000-4000-8000-0000000000bb',
      }),
    ];
    expect((await run(RAISE))['error']).toMatchObject({
      code: 'SPACE_AUTONOMY_DIRECTIVE_NOT_OPERATOR',
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('spends a directive on its raise: after a lowering, the next raise needs a later message', async () => {
    expect((await run(RAISE))['status']).toBe('SUCCEEDED');
    const spent = state.stored?.directive;
    expect(spent?.eventId).toBe(OPERATOR_MESSAGE.eventId);

    expect((await run({ autonomy: 'ratify' }))['status']).toBe('SUCCEEDED');
    expect(state.stored).toEqual({ autonomy: 'ratify', directive: spent });

    const again = await run(RAISE);
    expect(again['status']).toBe('FAILED');
    expect(again['error']).toMatchObject({ code: 'SPACE_AUTONOMY_DIRECTIVE_SPENT' });
    expect(state.stored?.autonomy).toBe('ratify');

    const later = record('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-11-23T10:00:00Z', {
      userMessage: `${WORDS} Raise it again.`,
      actorUserId: USER,
    });
    state.records = [later, OPERATOR_MESSAGE];
    expect(
      (await run({ autonomy: 'full', directiveQuote: `${WORDS} Raise it again.` }))['status'],
    ).toBe('SUCCEEDED');
    expect(state.stored).toMatchObject({
      autonomy: 'full',
      directive: { eventId: later.eventId, postedAt: '2026-11-23T10:00:00.000Z' },
    });
  });

  it('changes storeUpdates alone with no directive, and keeps a stored full and its directive', async () => {
    expect((await run({ storeUpdates: 'manual' }))['status']).toBe('SUCCEEDED');
    expect(mockWrite.mock.calls[0]![0]).toMatchObject({ policy: { storeUpdates: 'manual' } });

    expect((await run(RAISE))['status']).toBe('SUCCEEDED');
    const directive = state.stored?.directive;
    mockReadRecords.mockClear();
    expect((await run({ storeUpdates: 'follow-catalog' }))['status']).toBe('SUCCEEDED');
    expect(state.stored).toEqual({ autonomy: 'full', storeUpdates: 'follow-catalog', directive });
    expect(mockReadRecords).not.toHaveBeenCalled();
  });

  it('writes full on a space already at full with no directive, and reads no record', async () => {
    state.stored = { autonomy: 'full' };
    expect((await run({ autonomy: 'full' }))['status']).toBe('SUCCEEDED');
    expect(mockReadRecords).not.toHaveBeenCalled();
  });

  it('refuses a session whose user is not an admin of the space, and writes nothing', async () => {
    state.admins = new Set();
    const result = await run(RAISE);

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

  it('refuses an input that names neither field, names a space, or quotes a directive without a raise', async () => {
    for (const input of [
      {},
      { autonomy: 'full', spaceId: SPACE },
      { autonomy: 'ratify', directiveQuote: QUOTE },
      { autonomy: 'full', directive: { eventId: OPERATOR_MESSAGE.eventId } },
    ]) {
      expect((await run(input))['error']).toMatchObject({
        code: 'SPACE_AUTONOMY_UPDATE_INVALID_INPUT',
      });
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
