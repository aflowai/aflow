/**
 * The space hears `entity.session.status` when a conversation's turn begins,
 * rests or ends — once the move is durable, and only for a move: the
 * projection runs on every step, and a turn of forty tool calls is two signals,
 * not forty. It is what lets the Workbench's conversation list say which
 * conversations are live without a subscription per row (Plan 315 F75).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHotState } from '@aflow/redis';

const TENANT = 'a0000000-0000-4000-8000-000000000915';
const SPACE = '5e1d0000-0000-4000-8000-000000000915';
const SESSION = 'c01d0000-0000-4000-8000-000000000915';
const PARENT = 'c01d0000-0000-4000-8000-0000000009aa';

const hot = vi.hoisted(() => ({
  state: undefined as SessionHotState | undefined,
  /** The event types in the stream past the projection's cursor. */
  pending: [] as string[],
  signals: [] as Array<{ spaceId: string; eventType: string; payload: unknown }>,
}));

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    claimProjectionCandidates: () =>
      Promise.resolve([
        { tenantId: TENANT, runId: SESSION, version: 1, leaseUntilMs: Date.now() + 30_000 },
      ]),
    getSessionStateSafe: () => Promise.resolve({ ok: true, state: hot.state }),
    readDurableEventEntries: (_r: unknown, _t: string, _s: string, cursor: string) =>
      Promise.resolve(
        cursor === '0' && hot.pending.length > 0
          ? {
              entries: hot.pending.map((eventType, i) => ({
                id: `${String(i + 1)}-0`,
                event: {
                  eventId: `e${String(i)}`,
                  eventType,
                  sessionId: SESSION,
                  timestamp: Date.now(),
                },
                envelope: {},
              })),
              lastId: `${String(hot.pending.length)}-0`,
              oldestId: '1-0',
            }
          : { entries: [], lastId: cursor, oldestId: null },
      ),
    appendEntityEvent: (
      _redis: unknown,
      params: { spaceId: string; event: { eventType: string; payload: unknown } },
    ) => {
      hot.signals.push({
        spaceId: params.spaceId,
        eventType: params.event.eventType,
        payload: params.event.payload,
      });
      return Promise.resolve('1-0');
    },
    ackProjection: () => Promise.resolve(true),
    publishActionCenterWake: () => undefined,
    deleteRecoveryData: () => Promise.resolve(),
  };
});
vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  const chain = (result: unknown): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        key === 'then'
          ? (resolve: (value: unknown) => void) => resolve(result)
          : () => chain(result),
    });
  const tx = {
    insert: () => chain([{ sessionId: SESSION }]),
    select: () => chain([{ cursor: null, status: null }]),
    update: () => chain([]),
  };
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
});
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return { ...actual, bumpAttentionGeneration: () => Promise.resolve() };
});
vi.mock('../hotStateSnapshot.js', () => ({ buildHotStateSnapshot: () => Promise.resolve(null) }));
vi.mock('../pauseNotificationRouter.js', () => ({
  routePauseNotifications: () => Promise.resolve(),
}));
vi.mock('../errorReportAssembly.js', () => ({ assembleErrorReport: () => Promise.resolve() }));

const { createProjectionWorker, movesSessionStatus } = await import('../ProjectionWorker.js');

function session(status: string, extra: Partial<SessionHotState> = {}): SessionHotState {
  const now = Date.now();
  return {
    tenantId: TENANT,
    sessionId: SESSION,
    spaceId: SPACE,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
    agentVersion: '1',
    status,
    createdAt: now,
    startedAt: now,
    lastUpdatedAt: now,
    ...extra,
  } as unknown as SessionHotState;
}

async function project(state: SessionHotState, pending: string[]): Promise<void> {
  hot.state = state;
  hot.pending = pending;
  const worker = createProjectionWorker({ redis: {} as never, db: {} as never });
  await worker.runOnce();
}

beforeEach(() => {
  hot.signals = [];
});

describe("a conversation's status reaches the space", () => {
  it('says a turn began once the resume is durable', async () => {
    await project(session('RUNNING'), ['SessionResumed', 'StepScheduled']);

    expect(hot.signals).toEqual([
      {
        spaceId: SPACE,
        eventType: 'entity.session.status',
        payload: { sessionId: SESSION, status: 'RUNNING' },
      },
    ]);
  });

  it('says a turn rested on the operator once the pause is durable', async () => {
    await project(session('PAUSED'), ['StepSucceeded', 'SessionPaused']);

    expect(hot.signals).toEqual([
      {
        spaceId: SPACE,
        eventType: 'entity.session.status',
        payload: { sessionId: SESSION, status: 'PAUSED' },
      },
    ]);
  });

  it('says nothing for a projection of steps alone, however many', async () => {
    await project(session('RUNNING'), ['StepScheduled', 'StepStarted', 'StepSucceeded']);
    await project(session('RUNNING'), []);

    expect(hot.signals).toEqual([]);
  });

  it("says nothing for a child session, whose turn is its parent's", async () => {
    await project(session('RUNNING', { parentSessionId: PARENT }), ['SessionStarted']);

    expect(hot.signals).toEqual([]);
  });
});

describe('which persisted events move a status', () => {
  it('is every session lifecycle event and nothing else', () => {
    expect(movesSessionStatus({ eventType: 'SessionStarted' })).toBe(true);
    expect(movesSessionStatus({ eventType: 'SessionCompleted' })).toBe(true);
    expect(movesSessionStatus({ eventType: 'StepSucceeded' })).toBe(false);
    expect(movesSessionStatus({ eventType: 'WorkflowTaskUpdate' })).toBe(false);
    expect(movesSessionStatus(null)).toBe(false);
  });
});
