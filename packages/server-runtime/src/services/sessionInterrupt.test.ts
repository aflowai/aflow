import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, TenantId } from '@aflow/schemas';

const SESSION = '99999999-2222-3333-4444-555555555555' as SessionId;
const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;

/** The session's pending waiter rows, served by both ledger reads. */
const waiterRows: Array<{ runId: string; waiterStepExecutionId: string | null }> = [];

vi.mock('@aflow/cybernetic-runtime', () => ({
  dispatchResume: vi.fn(),
  loadPendingWaitersForSession: vi.fn(() => Promise.resolve([...waiterRows])),
  loadParkedStepWaitersForSession: vi.fn(() =>
    Promise.resolve(waiterRows.filter((row) => row.waiterStepExecutionId !== null)),
  ),
}));

const mockGetSessionStateSafe = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockAddControlMessage = vi.fn();
vi.mock('@aflow/redis', async () => ({
  ...(await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis')),
  getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
}));

import { createSessionService } from './sessions.js';
import type { AppContext } from './context.js';

const service = createSessionService({
  db: {},
  redis: {},
  payloadStore: null,
  isMock: false,
} as unknown as AppContext);

function sessionIn(state: Record<string, unknown>) {
  mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { sessionId: SESSION, ...state } });
}

beforeEach(() => {
  vi.clearAllMocks();
  waiterRows.length = 0;
  waiterRows.push({ runId: 'run-started-without-waiting', waiterStepExecutionId: null });
});

describe('interruptSession on a session that started a run without waiting on it', () => {
  it('reads a session resting at its prompt as already paused', async () => {
    sessionIn({ status: 'PAUSED', pauseType: 'user_input' });

    await expect(
      service.interruptSession({ tenantId: TENANT, sessionId: SESSION }),
    ).resolves.toEqual({ status: 'PAUSED', message: 'Run is already paused' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('interrupts a session with a step parked on a run', async () => {
    waiterRows.push({ runId: 'run-waited-on', waiterStepExecutionId: 'step-parked' });
    sessionIn({ status: 'PAUSED', pauseType: 'external_dependency' });

    await service.interruptSession({ tenantId: TENANT, sessionId: SESSION });

    expect(mockAddControlMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'interrupt_run', runId: SESSION }),
    );
  });
});
