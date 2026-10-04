import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, TenantId } from '@aflow/schemas';

const SESSION = '99999999-2222-3333-4444-555555555556' as SessionId;
const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;

const mockGetSessionStateSafe = vi.fn();
vi.mock('@aflow/redis', async () => ({
  ...(await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis')),
  getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
  getStepState: () => Promise.resolve(null),
}));
vi.mock('@aflow/database', async () => ({
  ...(await vi.importActual<typeof import('@aflow/database')>('@aflow/database')),
  readSessionMetadata: () => Promise.resolve(null),
}));

import {
  createSessionService,
  type GetSessionEventsBeforeResult,
  type SessionEvent,
} from './sessions.js';
import type { AppContext } from './context.js';

const service = createSessionService({
  db: {},
  redis: {},
  payloadStore: null,
  isMock: false,
} as unknown as AppContext);

let clock = Date.parse('2026-10-01T00:00:00Z');
function event(eventType: string, stepId: string): SessionEvent {
  clock += 1000;
  return {
    eventId: `${eventType}-${stepId}`,
    eventType,
    sessionId: SESSION,
    stepExecutionId: `exec-${stepId}`,
    timestamp: new Date(clock).toISOString(),
    sequenceNumber: 0,
    eventVersion: 1,
    data: { stepId },
  };
}

/** Sixty tool steps, each scheduled, started and finished: 180 events. */
const STEP_IDS = Array.from({ length: 60 }, (_, i) => `dynamic_tool_${String(i)}`);
const HISTORY = STEP_IDS.flatMap((id) => [
  event('StepScheduled', id),
  event('StepStarted', id),
  event('StepSucceeded', id),
]);

beforeEach(() => {
  vi.restoreAllMocks();
  mockGetSessionStateSafe.mockResolvedValue({
    ok: true,
    state: {
      sessionId: SESSION,
      status: 'FAILED',
      agentVersion: '1',
      createdAt: clock,
      lastUpdatedAt: clock,
      errorRef: 'inline:eyJjb2RlIjoiUFJPVklERVJfRVJST1IifQ==',
      dynamicSteps: JSON.stringify(
        STEP_IDS.map((stepId) => ({ stepId, stepType: 'api', operation: 'browser.page.open' })),
      ),
    },
  });
  vi.spyOn(service, 'getSessionEventsBefore').mockImplementation(
    (_tenant, _session, before, limit = 100): Promise<GetSessionEventsBeforeResult> => {
      const end = before === undefined ? HISTORY.length : Number(before);
      const start = Math.max(0, end - limit);
      return Promise.resolve({
        kind: 'events',
        events: HISTORY.slice(start, end),
        hasOlder: start > 0,
        ...(start > 0 ? { olderCursor: String(start) } : {}),
      });
    },
  );
});

describe('the session debug view', () => {
  it('carries the newest events, not the first ones', async () => {
    const debug = await service.getSessionDebug(TENANT, SESSION, { eventsLimit: 30 });

    expect(debug?.recentEvents).toHaveLength(30);
    expect(debug?.recentEvents.at(-1)?.eventId).toBe(HISTORY.at(-1)?.eventId);
  });

  it('reads one page when the step history is not asked for', async () => {
    const debug = await service.getSessionDebug(TENANT, SESSION, { eventsLimit: 1 });

    expect(service.getSessionEventsBefore).toHaveBeenCalledTimes(1);
    expect(debug?.stepEvents).toEqual({ read: 1, complete: false });
    expect(debug?.dynamicSteps?.filter((s) => s.status !== undefined)).toHaveLength(1);
  });

  it('reads a status for every step, walking back past the newest page when asked', async () => {
    const debug = await service.getSessionDebug(TENANT, SESSION, {
      eventsLimit: 30,
      walkStepHistory: true,
    });

    expect(service.getSessionEventsBefore).toHaveBeenCalledTimes(2);
    expect(debug?.dynamicSteps).toHaveLength(60);
    expect(debug?.dynamicSteps?.every((s) => s.status === 'SUCCEEDED')).toBe(true);
    expect(debug?.stepEvents?.complete).toBe(true);
    expect(debug?.hotState).toBe('present');
  });

  it('names the stored error the session failed with', async () => {
    const debug = await service.getSessionDebug(TENANT, SESSION);

    expect(debug?.session.errorRef).toBe('inline:eyJjb2RlIjoiUFJPVklERVJfRVJST1IifQ==');
    expect(debug?.refs.errorRef).toBe(debug?.session.errorRef);
  });
});
