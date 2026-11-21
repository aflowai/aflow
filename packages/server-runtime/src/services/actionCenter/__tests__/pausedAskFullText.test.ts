/**
 * An ask longer than any preview reaches the conversation whole.
 *
 * The chat's copy of a `user.interaction.ask` and its Action Center item are
 * built from the same pause request. The snapshot's assistant message carries
 * the full prompt, and the Action Center item keeps its own summary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionEvent, SessionId, TenantId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

const mockWithTenantSchema = vi.fn();

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: (...args: unknown[]) => mockWithTenantSchema(...args),
  sessions: {
    sessionId: 'sessionId',
    spaceId: 'spaceId',
    status: 'status',
    currentStepExecutionId: 'currentStepExecutionId',
    requestedInputRef: 'requestedInputRef',
    pauseReason: 'pauseReason',
    startedAt: 'startedAt',
    hotStateSnapshot: 'hotStateSnapshot',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  isNotNull: (...args: unknown[]) => args,
  desc: (col: unknown) => col,
}));

import { createPausedStepSource, type PausedStepSourceDeps } from '../sources/pausedStepSource.js';
import type { ActionCenterContext } from '../types.js';
import { foldEventsToSnapshot } from '../../foldSessionEvents.js';

const TENANT = '00000000-0000-4000-8000-000000000001' as unknown as TenantId;
const SPACE = '00000000-0000-4000-8000-000000000002';
const STEP_EXEC = '00000000-0000-4000-8000-00000000dddd';
const SESSION = '00000000-0000-4000-8000-00000000eeee';

const HEAD =
  'Before I start the migration I need you to confirm three things about the billing tables. ' +
  'First, whether the archived invoices from the old provider still need to be readable by finance';
const TAIL =
  ' after the cutover, because keeping them means a second schema. Second, whether the nightly ' +
  'export can move from midnight to two in the morning. Third, whether the reconciliation ' +
  'report should keep its current column order or follow the new ledger layout described in the plan.';
const PROMPT = HEAD + TAIL;

/** The pause request as the user executor writes it for a chat-inline ask. */
const ASK_REQUEST = {
  kind: 'input',
  prompt: PROMPT,
  placement: 'chat_inline',
  requestedAt: '2026-11-21T09:00:00.000Z',
  stepExecutionId: STEP_EXEC,
};

function inlineRef(payload: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

/** The SessionPaused event the orchestrator records for that request. */
function askPausedEvent(): ApiSessionEvent {
  return {
    eventId: 'evt-ask-1',
    eventType: 'SessionPaused',
    sessionId: SESSION as SessionId,
    stepExecutionId: STEP_EXEC,
    timestamp: '2026-11-21T09:00:00.000Z',
    sequenceNumber: 1,
    eventVersion: 1,
    data: {},
    metadata: {
      stepName: '↪ Ask user (in chat)',
      operationId: 'user.interaction.ask',
      pauseReason: 'input_required',
      prompt: PROMPT,
      placement: 'chat_inline',
      kind: 'input',
    },
  };
}

function makeDeps(payload: unknown): PausedStepSourceDeps {
  const rows = [
    {
      sessionId: SESSION,
      spaceId: SPACE,
      status: 'PAUSED',
      currentStepExecutionId: STEP_EXEC,
      requestedInputRef: inlineRef(payload),
      pauseReason: 'input_required',
      startedAt: new Date('2026-11-21T08:59:00.000Z'),
      hotStateSnapshot: null,
    },
  ];
  mockWithTenantSchema.mockImplementation(async (_db, _ctx, cb: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: () => Promise.resolve(rows),
    };
    return cb(builder);
  });
  const payloadStore: Pick<PayloadStore, 'retrieve'> = {
    retrieve: async (ref) => {
      const raw = (ref as string).slice('inline:'.length);
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as never;
    },
  };
  return {
    db: {} as never,
    redis: null as never,
    payloadStore: payloadStore as PayloadStore,
    sessionService: { resumeSession: vi.fn() } as never,
  };
}

function ctx(): ActionCenterContext {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    actorUserId: 'user-1',
    actorSpaceRole: 'editor',
    actorIsTenantAdmin: false,
  };
}

beforeEach(() => {
  mockWithTenantSchema.mockReset();
});

describe('a chat-inline ask longer than 200 characters', () => {
  it('is shaped so a 200-character cut lands mid-word', () => {
    expect(PROMPT.length).toBeGreaterThan(400);
    expect(PROMPT.indexOf(' ', 200)).toBeGreaterThan(200);
    expect(PROMPT.slice(199, 201)).toMatch(/^\w\w$/);
  });

  it('appears in the snapshot assistant message content in full', () => {
    const { snapshot } = foldEventsToSnapshot([askPausedEvent()], []);
    const ask = snapshot.messages.find((m) => m.id === `inline-hitl-${STEP_EXEC}`);

    expect(ask?.role).toBe('assistant');
    expect(ask?.content).toBe(PROMPT);
    expect(ask?.richContent).toMatchObject({ hitlKind: 'human_input', body: PROMPT });
  });

  it('leaves the Action Center item as it was', async () => {
    const [item] = await createPausedStepSource(makeDeps(ASK_REQUEST)).listOpen(ctx());

    expect(item).toMatchObject({
      id: `step:${STEP_EXEC}`,
      kind: 'human_input',
      title: 'Information requested',
      summary: PROMPT,
    });
  });
});
