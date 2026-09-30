import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ledger's waiter rows, standing in for Postgres: they outlive the
 * process, so a restart sees exactly what the last delivery recorded.
 */
const ledger = new Map<string, { lastDeliveredKey: string | null; retiredAs: string | null }>();

type LedgerReport = { outcome: 'paused'; pauseVersion: number } | { outcome: string };

function ledgerKey(report: LedgerReport): string {
  return 'pauseVersion' in report ? `paused:${String(report.pauseVersion)}` : report.outcome;
}

/** Forward only, as the row's key is: a pause no later than the one heard is refused. */
function claimInLedger(args: { waiterId: string; report: LedgerReport }) {
  const row = ledger.get(args.waiterId);
  if (!row || row.retiredAs !== null) return false;
  const { report } = args;
  if ('pauseVersion' in report) {
    const heard = row.lastDeliveredKey === null ? -1 : Number(row.lastDeliveredKey.split(':')[1]);
    if (report.pauseVersion <= heard) return false;
  } else {
    row.retiredAs = report.outcome;
  }
  row.lastDeliveredKey = ledgerKey(report);
  return true;
}

const mockLoadPendingWaiters = vi.fn();
const mockMarkWaiterNotified = vi.fn();
const mockRehydratePausedRun = vi.fn();
const mockDispatchResume = vi.fn();
const mockResumeClaimsForStep = vi.fn();
vi.mock('@aflow/cybernetic-runtime', () => ({
  loadPendingWaiters: (...args: unknown[]) => mockLoadPendingWaiters(...args),
  markWaiterNotified: (...args: unknown[]) => mockMarkWaiterNotified(...args),
  rehydratePausedRun: (...args: unknown[]) => mockRehydratePausedRun(...args),
  claimSessionWaiterDelivery: (_tx: unknown, args: Parameters<typeof claimInLedger>[0]) =>
    Promise.resolve(claimInLedger(args)),
  sessionWaiterDeliveryKey: ledgerKey,
  dispatchResume: (...args: unknown[]) => mockDispatchResume(...args),
  resumeClaimsForStep: (...args: unknown[]) => mockResumeClaimsForStep(...args),
  rehydrateParkedStep: vi.fn(),
  buildWorkflowRunDetail: vi.fn().mockResolvedValue(null),
  surfaceWorkflowResumeContract: vi.fn().mockResolvedValue(null),
}));

/** The event log, unique on the event id as the table is; read back newest first. */
const mockInsertedEvents: Array<{
  eventId: string;
  eventType: string;
  sessionId: string;
  payloadRef: string | null;
}> = [];
vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(() => ({})),
  eventLog: {
    eventId: 'event_id',
    payloadRef: 'payload_ref',
    sessionId: 'session_id',
    eventType: 'event_type',
    timestamp: 'timestamp',
  },
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      insert: () => ({
        values: (row: (typeof mockInsertedEvents)[number]) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              if (mockInsertedEvents.some((logged) => logged.eventId === row.eventId)) {
                return Promise.resolve([]);
              }
              mockInsertedEvents.push(row);
              return Promise.resolve([{ eventId: row.eventId }]);
            },
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () =>
                Promise.resolve(
                  [...mockInsertedEvents]
                    .reverse()
                    .map(({ eventId, payloadRef }) => ({ eventId, payloadRef })),
                ),
            }),
          }),
        }),
      }),
    }),
  ),
}));

const mockAppendSessionEvent = vi.fn();
const mockGetSessionStateSafe = vi.fn();
const mockGetStepState = vi.fn();
const mockAddStepResult = vi.fn();
const mockClaimEventDrivenTurn = vi.fn();
const mockReturnEventDrivenTurn = vi.fn();
const mockScheduleShardTimer = vi.fn();
vi.mock('@aflow/redis', async () => {
  const { mayWake } = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    mayWake,
    appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
    getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
    getStepState: (...args: unknown[]) => mockGetStepState(...args),
    addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
    claimEventDrivenTurn: (...args: unknown[]) => mockClaimEventDrivenTurn(...args),
    returnEventDrivenTurn: (...args: unknown[]) => mockReturnEventDrivenTurn(...args),
    scheduleShardTimer: (...args: unknown[]) => mockScheduleShardTimer(...args),
    updateStepState: vi.fn(),
    updateSessionState: vi.fn(),
    markSessionDirty: vi.fn(),
  };
});

const mockHasUnreadRunWakeups = vi.fn();
vi.mock('../../../SessionOrchestrator/helpers/runWakeups.js', () => ({
  hasUnreadRunWakeups: (...args: unknown[]) => mockHasUnreadRunWakeups(...args),
}));
const { hasUnreadRunWakeups: realHasUnreadRunWakeups } = await vi.importActual<
  typeof import('../../../SessionOrchestrator/helpers/runWakeups.js')
>('../../../SessionOrchestrator/helpers/runWakeups.js');

const mockLoadRun = vi.fn();
vi.mock('../helpers.js', () => ({
  emitTerminalRunUpdate: vi.fn().mockResolvedValue(undefined),
  loadRunByRunIdAcrossSpaces: (...args: unknown[]) => mockLoadRun(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

import { notifyWaiters } from '../waiters.js';
import {
  EVENT_DRIVEN_TURNS_PER_MINUTE,
  deliverSessionWakeup,
  runWakeupEventId,
  wakeSessionForRunWakeups,
} from '../sessionWakeup.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as never;
const SESSION = '99999999-2222-3333-4444-555555555555';
const RUN = '11111111-2222-3333-4444-555555555555';
const PROMPT_STEP = '00000000-0000-4000-8000-0000000000a1';
const TURN_INPUT = 'gs://bucket/turn-input';

const payloadStore = { store: vi.fn(), retrieve: vi.fn(), exists: vi.fn() };
const deps = { db: {} as never, redis: {} as never, payloadStore: payloadStore as never };

function sessionWaiter(id = 'waiter-1', runId = RUN) {
  return { id, runId, waiterSessionId: SESSION, waiterStepExecutionId: null };
}

/** Registers a session waiter in the ledger and serves it while it is not retired. */
function registerSessionWaiter(id = 'waiter-1', runId = RUN) {
  ledger.set(id, { lastDeliveredKey: null, retiredAs: null });
  mockLoadPendingWaiters.mockImplementation((_db: unknown, _tenant: unknown, forRun: string) =>
    Promise.resolve(
      [...ledger.entries()]
        .filter(([, row]) => row.retiredAs === null)
        .map(([waiterId]) => sessionWaiter(waiterId, runId))
        .filter((w) => w.runId === forRun),
    ),
  );
}

function restingAtPrompt() {
  mockGetSessionStateSafe.mockResolvedValue({
    ok: true,
    state: { status: 'PAUSED', currentStepExecutionId: PROMPT_STEP, traceId: 'trace-1' },
  });
  mockGetStepState.mockResolvedValue({
    stepExecutionId: PROMPT_STEP,
    stepId: 'agent',
    stepType: 'ai',
    operationId: 'ai.agent.turn',
    attempt: 1,
    inputRef: TURN_INPUT,
  });
}

function wakeupEvents() {
  return mockInsertedEvents.filter((row) => row.eventType === 'WorkflowRunWakeup');
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.clear();
  mockInsertedEvents.length = 0;
  payloadStore.store.mockResolvedValue('gs://bucket/wakeup-envelope');
  payloadStore.retrieve.mockReset();
  payloadStore.exists.mockReset();
  registerSessionWaiter();
  mockLoadRun.mockResolvedValue({ runId: RUN, spaceId: 'space-1' });
  mockHasUnreadRunWakeups.mockResolvedValue(true);
  mockResumeClaimsForStep.mockResolvedValue([]);
  mockClaimEventDrivenTurn.mockResolvedValue({ taken: true });
  mockDispatchResume.mockResolvedValue({ firstSeen: true });
});

describe('a waiter with no parked step', () => {
  it('appends a WorkflowRunWakeup event carrying the envelope, and retires on the run’s end', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { status: 'RUNNING', currentStepExecutionId: PROMPT_STEP },
    });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockAddStepResult).not.toHaveBeenCalled();
    const [, , sessionId, event] = mockAppendSessionEvent.mock.calls[0]!;
    expect(sessionId).toBe(SESSION);
    expect(event).toMatchObject({
      eventId: runWakeupEventId('waiter-1', 'completed'),
      eventType: 'WorkflowRunWakeup',
      outputRef: 'gs://bucket/wakeup-envelope',
      metadata: { runId: RUN, outcome: 'completed', waiterId: 'waiter-1' },
    });
    const stored = payloadStore.store.mock.calls[0]![0] as {
      stepExecutionId: string;
      data: Record<string, unknown>;
    };
    expect(stored.data).toMatchObject({ runId: RUN, outcome: 'completed', waiterId: 'waiter-1' });
    expect(stored.stepExecutionId).toBe(runWakeupEventId('waiter-1', 'completed'));

    // Durable at once: the turn builder reads the log, not the hot stream.
    expect(wakeupEvents()).toEqual([
      expect.objectContaining({ eventType: 'WorkflowRunWakeup', sessionId: SESSION }),
    ]);
    expect(ledger.get('waiter-1')).toEqual({
      lastDeliveredKey: 'completed',
      retiredAs: 'completed',
    });
    // A turn in flight reads it at its next boundary; nothing resumes it.
    expect(mockDispatchResume).not.toHaveBeenCalled();
  });

  it('stays registered through a pause, so the run’s end still reaches the session', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 1 });
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(wakeupEvents().map((row) => row.eventId)).toEqual([
      runWakeupEventId('waiter-1', 'paused:1'),
      runWakeupEventId('waiter-1', 'completed'),
    ]);
    expect(ledger.get('waiter-1')?.retiredAs).toBe('completed');
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();
  });

  it('hears a later pause of the same run as a new wakeup', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 1 });
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 3 });

    expect(wakeupEvents()).toHaveLength(2);
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
  });

  it('refuses a late notify of an earlier pause as delivered, and keeps the later key', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 3 });
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 2 });

    expect(wakeupEvents()).toHaveLength(1);
    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(ledger.get('waiter-1')?.lastDeliveredKey).toBe('paused:3');
  });

  it('keys a notification that arrives after the run paused again on the pause it reports', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });
    // The run row already stands at the newer pause when the older notify lands.
    mockLoadRun.mockResolvedValue({ runId: RUN, spaceId: 'space-1', pauseVersion: 5 });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN,
      outcome: 'paused',
      pauseVersion: 4,
      payloadRef: 'gs://bucket/contract-4',
    });
    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN,
      outcome: 'paused',
      pauseVersion: 5,
      payloadRef: 'gs://bucket/contract-5',
    });

    expect(wakeupEvents().map((row) => row.eventId)).toEqual([
      runWakeupEventId('waiter-1', 'paused:4'),
      runWakeupEventId('waiter-1', 'paused:5'),
    ]);
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
    expect(ledger.get('waiter-1')?.lastDeliveredKey).toBe('paused:5');
  });
});

describe('exactly once', () => {
  it('appends one event when the same pause is notified twice', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });

    await Promise.all([
      notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 1 }),
      notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 1 }),
    ]);

    expect(wakeupEvents()).toHaveLength(1);
    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(ledger.get('waiter-1')).toEqual({ lastDeliveredKey: 'paused:1', retiredAs: null });
  });

  it('appends nothing for the restart re-drive of a pause already delivered', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 1 });

    // A fresh process holds nothing of the first delivery but the ledger.
    vi.resetModules();
    const restarted = await import('../waiters.js');
    await restarted.notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN,
      outcome: 'paused',
      pauseVersion: 1,
      payloadRef: 'gs://bucket/contract',
      runDetail: { runId: RUN, spaceId: 'space-1', pauseVersion: 1 } as never,
    });

    expect(wakeupEvents()).toHaveLength(1);
    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
  });

  it('reports a wakeup already in the log as not recorded, and appends it nowhere again', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 4 });
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused', pauseVersion: 5 });

    // The waiter last heard pause 5, so a re-drive of pause 4 takes the claim;
    // its event is already in the log.
    const redrive = await deliverSessionWakeup(deps, {
      tenantId: TENANT,
      sessionId: SESSION,
      runId: RUN,
      waiterId: 'waiter-1',
      report: { outcome: 'paused', pauseVersion: 4 },
      storeEnvelope: () => Promise.resolve('gs://bucket/wakeup-envelope' as never),
    });

    expect(redrive).toMatchObject({
      eventId: runWakeupEventId('waiter-1', 'paused:4'),
      recorded: false,
    });
    expect(wakeupEvents()).toHaveLength(2);
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
  });

  it('gives the same outcome of the same pause the same identity', () => {
    expect(runWakeupEventId('waiter-1', 'paused:4')).toBe(runWakeupEventId('waiter-1', 'paused:4'));
    expect(runWakeupEventId('waiter-1', 'paused:4')).not.toBe(
      runWakeupEventId('waiter-1', 'paused:5'),
    );
    expect(runWakeupEventId('waiter-1', 'paused:4')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('waking a session resting at its prompt', () => {
  it('resumes it the way a room message with wake does, through the durable resume claim', async () => {
    restingAtPrompt();

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockDispatchResume).toHaveBeenCalledOnce();
    const request = mockDispatchResume.mock.calls[0]![2] as Record<string, unknown>;
    expect(request).toMatchObject({
      sessionId: SESSION,
      stepExecutionId: PROMPT_STEP,
      idempotencyKey: `event-wake:${PROMPT_STEP}`,
    });
    expect(
      JSON.parse(Buffer.from(String(request['inputRef']).slice(7), 'base64').toString()),
    ).toEqual({});
    expect(mockClaimEventDrivenTurn).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      SESSION,
      EVENT_DRIVEN_TURNS_PER_MINUTE,
    );
  });

  it('takes no turn slot when another resume of the pause is already claimed', async () => {
    restingAtPrompt();
    mockResumeClaimsForStep.mockResolvedValue(['wake:room-message-1']);

    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('coalesced');

    expect(mockClaimEventDrivenTurn).not.toHaveBeenCalled();
    expect(mockDispatchResume).not.toHaveBeenCalled();
  });

  it('sends its own claimed wake again, so a crash between claim and send is not a lost wake', async () => {
    restingAtPrompt();
    mockResumeClaimsForStep.mockResolvedValue([`event-wake:${PROMPT_STEP}`]);

    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('coalesced');

    expect(mockClaimEventDrivenTurn).not.toHaveBeenCalled();
    expect(mockDispatchResume).toHaveBeenCalledOnce();
  });

  it('gives the slot back when a concurrent wake started the turn first', async () => {
    restingAtPrompt();
    mockDispatchResume.mockResolvedValue({ firstSeen: false });

    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('coalesced');

    expect(mockReturnEventDrivenTurn).toHaveBeenCalledWith(expect.anything(), TENANT, SESSION);
  });

  it('does nothing when every wakeup has been read', async () => {
    restingAtPrompt();
    mockHasUnreadRunWakeups.mockResolvedValue(false);

    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('read');

    expect(mockHasUnreadRunWakeups).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TENANT,
      SESSION,
      TURN_INPUT,
    );
    expect(mockClaimEventDrivenTurn).not.toHaveBeenCalled();
    expect(mockDispatchResume).not.toHaveBeenCalled();
  });

  it('leaves a session parked on a blocking start alone', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: {
        status: 'PAUSED',
        currentStepExecutionId: PROMPT_STEP,
        pauseType: 'external_dependency',
        waitingOnWorkflowRunId: 'another-run',
      },
    });
    mockGetStepState.mockResolvedValue({ operationId: 'workflow.run.start', inputRef: 'x' });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(mockDispatchResume).not.toHaveBeenCalled();
    expect(mockClaimEventDrivenTurn).not.toHaveBeenCalled();
  });
});

describe('above the rate', () => {
  it('arms the next allowed slot as a shard timer instead of starting a turn', async () => {
    restingAtPrompt();
    mockClaimEventDrivenTurn.mockResolvedValue({ taken: false, nextSlotAtMs: 1_700_000_042_000 });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(mockDispatchResume).not.toHaveBeenCalled();
    expect(mockScheduleShardTimer).toHaveBeenCalledOnce();
    expect(mockScheduleShardTimer.mock.calls[0]![1]).toMatchObject({
      tenantId: TENANT,
      sessionId: SESSION,
      stepExecutionId: PROMPT_STEP,
      operationId: 'ai.agent.turn',
      reason: 'event_wake',
      dueAtMs: 1_700_000_042_000,
    });
  });

  it('when the slot comes round, wakes the session if the wakeups are still unread', async () => {
    restingAtPrompt();

    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('woke');
    expect(mockDispatchResume).toHaveBeenCalledOnce();
  });

  it('when the slot comes round after a turn read them, leaves the session resting', async () => {
    restingAtPrompt();
    mockHasUnreadRunWakeups.mockResolvedValue(false);

    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('read');
    expect(mockDispatchResume).not.toHaveBeenCalled();
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();
  });
});

describe('several wakeups on one pause', () => {
  it('start one turn', async () => {
    restingAtPrompt();
    const otherRun = '22222222-2222-3333-4444-555555555555';
    ledger.set('waiter-2', { lastDeliveredKey: null, retiredAs: null });
    mockLoadPendingWaiters
      .mockResolvedValueOnce([sessionWaiter('waiter-1', RUN)])
      .mockResolvedValueOnce([sessionWaiter('waiter-2', otherRun)]);
    mockResumeClaimsForStep
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([`event-wake:${PROMPT_STEP}`]);

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });
    await notifyWaiters(deps, { tenantId: TENANT, runId: otherRun, outcome: 'failed' });

    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
    expect(mockClaimEventDrivenTurn).toHaveBeenCalledOnce();
  });
});

describe('a wakeup whose envelope cannot be read', () => {
  /** The turn at the prompt read nothing; the payload store holds only `envelopes`. */
  function storeHolding(envelopes: Record<string, unknown>) {
    payloadStore.retrieve.mockImplementation(async (ref: string) => {
      if (ref === TURN_INPUT) return { prompt: 'p' };
      if (ref in envelopes) return envelopes[ref];
      throw new Error(`Payload not found: ${ref}`);
    });
    payloadStore.exists.mockImplementation(async (ref: string) => ref in envelopes);
  }

  beforeEach(() => {
    restingAtPrompt();
    mockHasUnreadRunWakeups.mockImplementation(realHasUnreadRunWakeups);
  });

  it('wakes the session neither when it lands nor when an event-wake slot comes round', async () => {
    storeHolding({});

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });
    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('read');

    expect(wakeupEvents()).toHaveLength(1);
    expect(mockDispatchResume).not.toHaveBeenCalled();
    expect(mockClaimEventDrivenTurn).not.toHaveBeenCalled();
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();
  });

  it('is told apart from one that can, which still wakes it', async () => {
    storeHolding({
      'gs://bucket/wakeup-envelope': { runId: RUN, outcome: 'completed', waiterId: 'waiter-1' },
    });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockDispatchResume).toHaveBeenCalledOnce();
  });

  it('is left unread while the store cannot answer, and wakes the session once it can', async () => {
    const envelope = { runId: RUN, outcome: 'completed', waiterId: 'waiter-1' };
    const unavailable = new Error('ECONNRESET');
    payloadStore.retrieve.mockImplementation(async (ref: string) => {
      if (ref === TURN_INPUT) return { prompt: 'p' };
      throw unavailable;
    });
    payloadStore.exists.mockResolvedValue(true);

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });
    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).rejects.toBe(unavailable);
    expect(mockDispatchResume).not.toHaveBeenCalled();

    storeHolding({ 'gs://bucket/wakeup-envelope': envelope });
    await expect(wakeSessionForRunWakeups(deps, TENANT, SESSION)).resolves.toBe('woke');
    expect(mockDispatchResume).toHaveBeenCalledOnce();
  });
});
