/**
 * The space hears `entity.session.status` when a conversation's turn begins,
 * rests or ends — once the move is durable, and only for a move: the
 * projection runs on every step, and a turn of forty tool calls is two signals,
 * not forty. It is what lets the Workbench's conversation list say which
 * conversations are live without a subscription per row (Plan 315 F75).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHotState } from '@aflow/redis';
import { BUBBLED_PAUSE_TYPE, gateRequestKind } from '@aflow/cybernetic-runtime';

const TENANT = 'a0000000-0000-4000-8000-000000000915';
const SPACE = '5e1d0000-0000-4000-8000-000000000915';
const SESSION = 'c01d0000-0000-4000-8000-000000000915';
const PARENT = 'c01d0000-0000-4000-8000-0000000009aa';

const hot = vi.hoisted(() => ({
  state: undefined as SessionHotState | undefined,
  /** The event types in the stream past the projection's cursor. */
  pending: [] as string[],
  signals: [] as Array<{ spaceId: string; eventType: string; payload: unknown }>,
  /** The spaces whose attention generation moved, in order. */
  bumps: [] as string[],
  /** The durable row as the projection finds it before it writes. */
  row: {
    status: null as string | null,
    currentStepExecutionId: null as string | null,
    pauseType: null as string | null,
    operationId: null as string | null,
  },
  /** The operation of the step the session is parked on, as its snapshot holds it. */
  parkedOperationId: undefined as string | undefined,
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
    select: () => chain([{ cursor: null, ...hot.row }]),
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
  return {
    ...actual,
    bumpAttentionGeneration: (_redis: unknown, _tenantId: string, spaceId: string) => {
      hot.bumps.push(spaceId);
      return Promise.resolve();
    },
  };
});
vi.mock('../hotStateSnapshot.js', () => ({
  buildHotStateSnapshot: (_redis: unknown, _tenantId: string, runState: SessionHotState) =>
    Promise.resolve(
      runState.currentStepExecutionId && hot.parkedOperationId
        ? {
            runHotState: runState,
            stepHotStates: {
              [runState.currentStepExecutionId]: { operationId: hot.parkedOperationId },
            },
          }
        : null,
    ),
}));
vi.mock('../pauseNotificationRouter.js', () => ({
  routePauseNotifications: () => Promise.resolve(),
}));
vi.mock('../errorReportAssembly.js', () => ({ assembleErrorReport: () => Promise.resolve() }));

const { createProjectionWorker, movesSessionGate, movesSessionStatus } =
  await import('../ProjectionWorker.js');

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
  hot.bumps = [];
  hot.row = { status: null, currentStepExecutionId: null, pauseType: null, operationId: null };
  hot.parkedOperationId = undefined;
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

// The attention block counts the space's paused sessions as gates and is
// cached per space until its generation moves, so a gate the Helmsman has
// approved must leave the next turn's count, and a new one must enter it.
describe("a session row's gate and its resolution move the space's attention generation", () => {
  const gateRow = {
    status: 'PAUSED',
    currentStepExecutionId: 'step-1',
    pauseType: 'approval',
    operationId: null,
  };

  it('moves it once the row reads a gate pause', async () => {
    hot.row = { ...hot.row, status: 'RUNNING', currentStepExecutionId: 'step-1' };
    await project(
      session('PAUSED', {
        parentSessionId: PARENT,
        currentStepExecutionId: 'step-1',
        pauseType: 'approval',
      }),
      ['StepSucceeded', 'SessionPaused'],
    );

    expect(hot.bumps).toEqual([SPACE]);
  });

  it("moves it once the row reads a pause on the user executor's request", async () => {
    hot.row = { ...hot.row, status: 'RUNNING', currentStepExecutionId: 'step-1' };
    hot.parkedOperationId = 'user.interaction.ask';
    await project(
      session('PAUSED', { currentStepExecutionId: 'step-2', pauseType: 'user_input' }),
      ['StepSucceeded', 'SessionPaused'],
    );

    expect(hot.bumps).toEqual([SPACE]);
  });

  it('leaves it alone for a chat turn, whose session rests on user_input', async () => {
    hot.row = { ...hot.row, status: 'RUNNING', currentStepExecutionId: 'step-1' };
    hot.parkedOperationId = 'ai.agent.turn';
    await project(
      session('PAUSED', { currentStepExecutionId: 'step-1', pauseType: 'user_input' }),
      ['StepSucceeded', 'SessionPaused'],
    );
    expect(hot.bumps).toEqual([]);

    hot.row = {
      status: 'PAUSED',
      currentStepExecutionId: 'step-1',
      pauseType: 'user_input',
      operationId: 'ai.agent.turn',
    };
    await project(session('RUNNING', { currentStepExecutionId: 'step-2' }), [
      'SessionResumed',
      'StepScheduled',
    ]);
    expect(hot.bumps).toEqual([]);
  });

  it('moves it once the row no longer reads a gate pause after the resume', async () => {
    hot.row = gateRow;
    await project(session('RUNNING', { parentSessionId: PARENT }), [
      'SessionResumed',
      'StepScheduled',
    ]);

    expect(hot.bumps).toEqual([SPACE]);
  });

  it('waits for the resting flush when the live projection flushes a pause its row does not hold', async () => {
    hot.row = { ...hot.row, status: 'RUNNING', currentStepExecutionId: 'step-1' };
    await project(session('RUNNING'), ['StepSucceeded', 'SessionPaused']);
    expect(hot.bumps).toEqual([]);

    await project(session('PAUSED', { pauseType: 'oauth_consent' }), []);
    expect(hot.bumps).toEqual([SPACE]);
  });

  it('moves nothing for a projection of steps alone', async () => {
    hot.row = { ...hot.row, status: 'RUNNING', currentStepExecutionId: 'step-1' };
    await project(session('RUNNING'), ['StepScheduled', 'StepStarted', 'StepSucceeded']);

    expect(hot.bumps).toEqual([]);
  });

  it('reads an edge into or out of a gate pause, or a move to another gate, and nothing else', () => {
    const gate = { status: 'PAUSED', currentStepExecutionId: 'step-1', pauseType: 'approval' };
    expect(movesSessionGate(undefined, gate)).toBe(true);
    expect(movesSessionGate({ status: 'RUNNING' }, gate)).toBe(true);
    expect(movesSessionGate(gate, { status: 'RUNNING' })).toBe(true);
    expect(movesSessionGate(gate, { status: 'CANCELLED' })).toBe(true);
    expect(movesSessionGate(gate, { ...gate, currentStepExecutionId: 'step-2' })).toBe(true);
    expect(movesSessionGate(gate, { ...gate, pauseType: 'user_input' })).toBe(true);
    expect(movesSessionGate(gate, { ...gate })).toBe(false);
    expect(movesSessionGate(undefined, { status: 'RUNNING' })).toBe(false);
    expect(movesSessionGate({ status: 'RUNNING' }, { status: 'SUCCEEDED' })).toBe(false);
  });

  it('reads the gate types, the user executor operations and a bubbled pause as gates, and every other pause as none', () => {
    const pausedOn = (pauseType: string, operationId?: string) => ({
      status: 'PAUSED',
      currentStepExecutionId: 'step-1',
      pauseType,
      operationId,
    });
    for (const gate of [
      pausedOn('approval'),
      pausedOn('oauth_consent'),
      pausedOn('user_input', 'user.interaction.ask'),
      pausedOn('user_input', 'user.interaction.approve'),
      pausedOn('subflow_waiting', 'agent.control.delegate'),
    ]) {
      expect(movesSessionGate({ status: 'RUNNING' }, gate)).toBe(true);
      expect(movesSessionGate(gate, { status: 'WAITING_ON_CHILD' })).toBe(true);
    }
    for (const pause of [
      pausedOn('user_input', 'ai.agent.turn'),
      pausedOn('interrupted'),
      pausedOn('budget_exceeded'),
    ]) {
      expect(movesSessionGate({ status: 'RUNNING' }, pause)).toBe(false);
      expect(movesSessionGate(pause, { status: 'RUNNING' })).toBe(false);
    }
  });

  it("moves it once a parent row holds its child's bubbled pause, and once it leaves it", async () => {
    hot.row = { ...hot.row, status: 'WAITING_ON_CHILD', currentStepExecutionId: 'step-1' };
    hot.parkedOperationId = 'agent.control.delegate';
    await project(
      session('PAUSED', { currentStepExecutionId: 'step-1', pauseType: 'subflow_waiting' }),
      ['SessionPaused'],
    );
    expect(hot.bumps).toEqual([SPACE]);

    hot.row = {
      status: 'PAUSED',
      currentStepExecutionId: 'step-1',
      pauseType: 'subflow_waiting',
      operationId: 'agent.control.delegate',
    };
    await project(
      session('WAITING_ON_CHILD', {
        currentStepExecutionId: 'step-1',
        pauseType: 'subflow_waiting',
      }),
      ['SessionResumed'],
    );
    expect(hot.bumps).toEqual([SPACE, SPACE]);
  });
});

/**
 * A pause bubbled up a delegation chain: the Runner pauses at an ask, and the
 * Driver and the Helmsman each hold it paused `subflow_waiting`. The count
 * lists every level, so each row's flush must move the generation. The rows
 * flush in any order, and the block may be rebuilt between any two flushes.
 */
describe('a bubbled pause and the cached count', () => {
  interface Row {
    status: string;
    currentStepExecutionId: string;
    pauseType?: string;
    operationId: string;
    ref?: string;
    childId?: string;
  }

  const REF = 'payload:ask';
  const paused: Record<string, Row> = {
    runner: {
      status: 'PAUSED',
      currentStepExecutionId: 'runner-step',
      pauseType: 'user_input',
      operationId: 'user.interaction.ask',
      ref: REF,
    },
    driver: {
      status: 'PAUSED',
      currentStepExecutionId: 'driver-step',
      pauseType: BUBBLED_PAUSE_TYPE,
      operationId: 'agent.control.delegate',
      ref: REF,
      childId: 'runner',
    },
    helmsman: {
      status: 'PAUSED',
      currentStepExecutionId: 'helmsman-step',
      pauseType: BUBBLED_PAUSE_TYPE,
      operationId: 'agent.control.delegate',
      ref: REF,
      childId: 'driver',
    },
  };
  const running: Record<string, Row> = {
    runner: {
      status: 'RUNNING',
      currentStepExecutionId: 'runner-next',
      operationId: 'ai.agent.turn',
    },
    driver: {
      status: 'WAITING_ON_CHILD',
      currentStepExecutionId: 'driver-step',
      pauseType: BUBBLED_PAUSE_TYPE,
      operationId: 'agent.control.delegate',
    },
    helmsman: {
      status: 'WAITING_ON_CHILD',
      currentStepExecutionId: 'helmsman-step',
      pauseType: BUBBLED_PAUSE_TYPE,
      operationId: 'agent.control.delegate',
    },
  };

  /** The run gates as `PAUSED_SESSIONS_SQL` counts them: each paused row by its own request, or by the one its chain bubbled up. */
  function runGates(rows: ReadonlyMap<string, Row>): number {
    let total = 0;
    for (const row of rows.values()) {
      if (row.status !== 'PAUSED' || row.ref === undefined) continue;
      let at: Row | undefined = row;
      let kind = gateRequestKind(at.operationId, at.pauseType);
      while (kind === null && at?.pauseType === BUBBLED_PAUSE_TYPE) {
        const child: Row | undefined = at.childId ? rows.get(at.childId) : undefined;
        at = child?.ref === row.ref ? child : undefined;
        kind = at ? gateRequestKind(at.operationId, at.pauseType) : null;
      }
      if (kind === 'input' || kind === 'approval' || kind === 'write_approval') total++;
    }
    return total;
  }

  /** Flushes rows in order, rebuilding the block after each, and returns the counts it cached. */
  function flush(rows: Map<string, Row>, order: string[], next: Record<string, Row>): number[] {
    let generation = 0;
    let cached: { generation: number; count: number } | null = null;
    const counts: number[] = [];
    for (const id of order) {
      const prior = rows.get(id);
      const row = next[id];
      if (!row) throw new Error(`no row for ${id}`);
      rows.set(id, row);
      if (movesSessionGate(prior, row)) generation++;
      if (cached?.generation !== generation) cached = { generation, count: runGates(rows) };
      expect(cached.count).toBe(runGates(rows));
      counts.push(cached.count);
    }
    return counts;
  }

  const orders = [
    ['runner', 'driver', 'helmsman'],
    ['helmsman', 'driver', 'runner'],
    ['driver', 'runner', 'helmsman'],
  ];

  it.each(orders)('holds every level once the pause has flushed, %s first', (...order) => {
    const rows = new Map(Object.entries(running));
    const counts = flush(rows, order, paused);
    expect(counts.at(-1)).toBe(3);
  });

  it.each(orders)('holds no level once the resume has flushed, %s first', (...order) => {
    const rows = new Map(Object.entries(paused));
    const counts = flush(rows, order, running);
    expect(counts.at(-1)).toBe(0);
  });
});
