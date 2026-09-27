/**
 * The run watchdog is the only thing that turns a queued run nobody will ever
 * start into something a user can see, and it is allowed to do that only while
 * no orchestrator is alive. Both halves of that sentence are load-bearing:
 * stalling a run behind a healthy orchestrator destroys work that was merely
 * waiting, and not stalling one behind a dead orchestrator leaves a session
 * silent forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsOrchestratorAlive = vi.fn();
const mockClaimDueQueuedSessions = vi.fn();
const mockDropQueuedSessionCandidate = vi.fn();
const mockRearmQueuedSessionCandidate = vi.fn();
const mockGetSessionState = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockAppendSessionEvent = vi.fn();
const mockMarkSessionDirty = vi.fn();

vi.mock('@aflow/redis', () => ({
  isOrchestratorAlive: (...args: unknown[]) => mockIsOrchestratorAlive(...args),
  claimDueQueuedSessions: (...args: unknown[]) => mockClaimDueQueuedSessions(...args),
  dropQueuedSessionCandidate: (...args: unknown[]) => mockDropQueuedSessionCandidate(...args),
  rearmQueuedSessionCandidate: (...args: unknown[]) => mockRearmQueuedSessionCandidate(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
  markSessionDirty: (...args: unknown[]) => mockMarkSessionDirty(...args),
}));

import type { Redis } from 'ioredis';
import { createRunWatchdog } from './runWatchdog.js';

const TENANT = 'tenant-1';
const RUN = '22222222-2222-4222-9222-222222222222';
const GRACE_MS = 30_000;

function queuedState(createdAt: number): Record<string, unknown> {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'helmsman' },
    agentVersion: '1',
    status: 'QUEUED',
    createdAt,
    lastUpdatedAt: createdAt,
  };
}

function watchdog() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return createRunWatchdog(
    { redis: {} as Redis, logger },
    { gracePeriodMs: GRACE_MS, maxBatch: 200, maxCycleMs: 10_000 },
  );
}

beforeEach(() => {
  mockIsOrchestratorAlive.mockReset().mockResolvedValue(false);
  mockClaimDueQueuedSessions.mockReset().mockResolvedValue([]);
  mockDropQueuedSessionCandidate.mockReset().mockResolvedValue(undefined);
  mockRearmQueuedSessionCandidate.mockReset().mockResolvedValue(undefined);
  mockGetSessionState.mockReset().mockResolvedValue(null);
  mockUpdateSessionState.mockReset().mockResolvedValue(undefined);
  mockAppendSessionEvent.mockReset().mockResolvedValue(undefined);
  mockMarkSessionDirty.mockReset().mockResolvedValue(undefined);
});

describe('run watchdog', () => {
  it('does not touch the index while an orchestrator is alive', async () => {
    mockIsOrchestratorAlive.mockResolvedValue(true);

    await watchdog().runOnce();

    expect(mockClaimDueQueuedSessions).not.toHaveBeenCalled();
  });

  it('treats a failed liveness probe as alive', async () => {
    mockIsOrchestratorAlive.mockRejectedValue(new Error('probe exploded'));

    await watchdog().runOnce();

    expect(mockClaimDueQueuedSessions).not.toHaveBeenCalled();
  });

  it('claims with the caller grace as the cutoff and stalls what it gets', async () => {
    mockClaimDueQueuedSessions.mockResolvedValue([{ tenantId: TENANT, sessionId: RUN }]);
    mockGetSessionState.mockResolvedValue(queuedState(Date.now() - GRACE_MS - 1000));

    const result = await watchdog().runOnce();

    const [, cutoffMs, limit] = mockClaimDueQueuedSessions.mock.calls[0] as [
      unknown,
      number,
      number,
    ];
    expect(cutoffMs).toBeLessThanOrEqual(Date.now() - GRACE_MS);
    expect(limit).toBe(200);

    expect(result.processed).toBe(1);
    expect(mockUpdateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN,
      expect.objectContaining({ status: 'STALLED' }),
    );
    expect(mockAppendSessionEvent).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN,
      expect.objectContaining({ eventType: 'SessionStalled' }),
    );
    // The STALLED write clears the queued candidate but arms no projection, and
    // a stall the durable row never learns about is a stall nobody can see.
    expect(mockMarkSessionDirty).toHaveBeenCalledWith(expect.anything(), TENANT, RUN);
  });

  it('drops a claimed candidate whose session is gone', async () => {
    mockClaimDueQueuedSessions.mockResolvedValue([{ tenantId: TENANT, sessionId: RUN }]);
    mockGetSessionState.mockResolvedValue(null);

    await watchdog().runOnce();

    expect(mockDropQueuedSessionCandidate).toHaveBeenCalledWith(expect.anything(), TENANT, RUN);
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('drops a claimed candidate that has already left QUEUED', async () => {
    mockClaimDueQueuedSessions.mockResolvedValue([{ tenantId: TENANT, sessionId: RUN }]);
    mockGetSessionState.mockResolvedValue({ ...queuedState(0), status: 'RUNNING' });

    await watchdog().runOnce();

    expect(mockDropQueuedSessionCandidate).toHaveBeenCalledWith(expect.anything(), TENANT, RUN);
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('re-arms a candidate still inside the grace period instead of stalling it', async () => {
    // Only reachable when a previous claimant died: the score is standing at a
    // lease deadline rather than the creation time it was armed with.
    const createdAt = Date.now();
    mockClaimDueQueuedSessions.mockResolvedValue([{ tenantId: TENANT, sessionId: RUN }]);
    mockGetSessionState.mockResolvedValue(queuedState(createdAt));

    await watchdog().runOnce();

    expect(mockRearmQueuedSessionCandidate).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN,
      createdAt,
    );
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });
});
