import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WorkflowRunUpdatePayload, WorkflowTaskUpdatePayload } from '@aflow/schemas';

const mockLoadPendingWaiters = vi.fn();
const mockLoadRunOriginatingSessionId = vi.fn();
const mockAppendSessionEvent = vi.fn();
const mockBuildWorkflowRunDetail = vi.fn();

vi.mock('../ledger.js', () => ({
  loadPendingWaiters: (...args: unknown[]) => mockLoadPendingWaiters(...args),
  loadRunOriginatingSessionId: (...args: unknown[]) => mockLoadRunOriginatingSessionId(...args),
}));

vi.mock('../workflowRunDetail.js', () => ({
  buildWorkflowRunDetail: (...args: unknown[]) => mockBuildWorkflowRunDetail(...args),
}));

vi.mock('@aflow/redis', () => ({
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
}));

import { emitWorkflowProgress, emitCatchupToNewWaiter } from '../workflowRunProgress.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-00000000aaaa';
const SESSION_A = '00000000-0000-4000-8000-00000000bbbb';
const SESSION_B = '00000000-0000-4000-8000-00000000cccc';
const STEP_EXEC_A = '00000000-0000-4000-8000-00000000dddd';
const STEP_EXEC_B = '00000000-0000-4000-8000-00000000eeee';
const NOW = '2026-05-11T12:00:00.000Z';

function makeWaiter(sessionId: string, stepExecutionId: string) {
  return {
    waiterSessionId: sessionId,
    waiterStepExecutionId: stepExecutionId,
    runId: RUN_ID,
    registeredAt: new Date(NOW),
  };
}

const baseRunPayload: WorkflowRunUpdatePayload = {
  runId: RUN_ID,
  slug: 'compose-skill',
  status: 'running',
  pauseVersion: 0,
  startedAt: NOW,
};

const baseTaskPayload: WorkflowTaskUpdatePayload = {
  runId: RUN_ID,
  taskId: 't1',
  label: 'draft-skill',
  status: 'running',
  attempt: 1,
};

describe('emitWorkflowProgress — Plan 135 §4.2', () => {
  beforeEach(() => {
    mockLoadPendingWaiters.mockReset();
    mockLoadRunOriginatingSessionId.mockReset();
    mockAppendSessionEvent.mockReset();
    // Default: no originating session — existing tests stay focused on
    // the waiter fan-out. Tests that exercise the originating-session
    // path opt in explicitly via mockResolvedValueOnce.
    mockLoadRunOriginatingSessionId.mockResolvedValue(null);
  });

  it('is a no-op when there are no pending waiters', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([]);
    await emitWorkflowProgress(
      { db: {} as never, redis: {} as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        event: { kind: 'WorkflowRunUpdate', payload: baseRunPayload },
      },
    );
    expect(mockAppendSessionEvent).not.toHaveBeenCalled();
  });

  it('emits a WorkflowRunUpdate event carrying workflowRunUpdate payload to a single waiter', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([makeWaiter(SESSION_A, STEP_EXEC_A)]);
    await emitWorkflowProgress(
      { db: {} as never, redis: {} as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        event: { kind: 'WorkflowRunUpdate', payload: baseRunPayload },
      },
    );
    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    const [, tenant, sessionId, event] = mockAppendSessionEvent.mock.calls[0]!;
    expect(tenant).toBe(TENANT);
    expect(sessionId).toBe(SESSION_A);
    expect(event.eventType).toBe('WorkflowRunUpdate');
    expect(event.sessionId).toBe(SESSION_A);
    expect(event.workflowRunUpdate).toEqual(baseRunPayload);
    expect(event.workflowTaskUpdate).toBeUndefined();
  });

  it('emits a WorkflowTaskUpdate event carrying workflowTaskUpdate payload', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([makeWaiter(SESSION_A, STEP_EXEC_A)]);
    await emitWorkflowProgress(
      { db: {} as never, redis: {} as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        event: { kind: 'WorkflowTaskUpdate', payload: baseTaskPayload },
      },
    );
    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    const event = mockAppendSessionEvent.mock.calls[0]![3];
    expect(event.eventType).toBe('WorkflowTaskUpdate');
    expect(event.workflowTaskUpdate).toEqual(baseTaskPayload);
    expect(event.workflowRunUpdate).toBeUndefined();
  });

  it('fans out one event per waiter when multiple sessions are parked on the run', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      makeWaiter(SESSION_A, STEP_EXEC_A),
      makeWaiter(SESSION_B, STEP_EXEC_B),
    ]);
    await emitWorkflowProgress(
      { db: {} as never, redis: {} as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        event: { kind: 'WorkflowTaskUpdate', payload: baseTaskPayload },
      },
    );
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
    const sessionIdsTargeted = mockAppendSessionEvent.mock.calls.map((c) => c[2]);
    expect(sessionIdsTargeted).toEqual([SESSION_A, SESSION_B]);
    // Each event stamps its waiter's sessionId on the event body too.
    const eventSessionIds = mockAppendSessionEvent.mock.calls.map((c) => c[3].sessionId);
    expect(eventSessionIds).toEqual([SESSION_A, SESSION_B]);
  });

  it('strips waiterStepExecutionId from live WorkflowRunUpdate payloads', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([makeWaiter(SESSION_A, STEP_EXEC_A)]);
    await emitWorkflowProgress(
      { db: {} as never, redis: {} as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        event: {
          kind: 'WorkflowRunUpdate',
          // Caller (mistakenly) passes the catch-up anchor field — the helper
          // must strip it. Live emissions never carry the anchor; only the
          // subscribe-time catch-up path does.
          payload: { ...baseRunPayload, waiterStepExecutionId: STEP_EXEC_A },
        },
      },
    );
    const event = mockAppendSessionEvent.mock.calls[0]![3];
    expect(event.workflowRunUpdate.waiterStepExecutionId).toBeUndefined();
    // But the rest of the payload is preserved.
    expect(event.workflowRunUpdate.runId).toBe(RUN_ID);
    expect(event.workflowRunUpdate.status).toBe('running');
  });

  it('honors excludeSessionIds — skips listed sessions in fan-out (review-fix regression)', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      makeWaiter(SESSION_A, STEP_EXEC_A),
      makeWaiter(SESSION_B, STEP_EXEC_B),
    ]);
    await emitWorkflowProgress(
      { db: {} as never, redis: {} as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        event: { kind: 'WorkflowRunUpdate', payload: baseRunPayload },
        excludeSessionIds: [SESSION_A],
      },
    );
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(1);
    const sessionIdsTargeted = mockAppendSessionEvent.mock.calls.map((c) => c[2]);
    expect(sessionIdsTargeted).toEqual([SESSION_B]);
  });

  it('continues fan-out when one waiter append throws (per-waiter best-effort, review-fix regression)', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      makeWaiter(SESSION_A, STEP_EXEC_A),
      makeWaiter(SESSION_B, STEP_EXEC_B),
    ]);
    // First call rejects; second resolves.
    mockAppendSessionEvent
      .mockRejectedValueOnce(new Error('redis ECONNRESET'))
      .mockResolvedValueOnce('msg-id');
    await expect(
      emitWorkflowProgress(
        { db: {} as never, redis: {} as never },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          event: { kind: 'WorkflowRunUpdate', payload: baseRunPayload },
        },
      ),
    ).resolves.toBeUndefined();
    // Both appends were attempted; the second succeeded.
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
  });

  it('gives each waiter its own unique eventId', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      makeWaiter(SESSION_A, STEP_EXEC_A),
      makeWaiter(SESSION_B, STEP_EXEC_B),
    ]);
    await emitWorkflowProgress(
      { db: {} as never, redis: {} as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        event: { kind: 'WorkflowTaskUpdate', payload: baseTaskPayload },
      },
    );
    const eventIds = mockAppendSessionEvent.mock.calls.map((c) => c[3].eventId);
    expect(eventIds[0]).not.toBe(eventIds[1]);
    expect(eventIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  // Observability fan-out to the run's
  // originating chat session even when no waiter is parked.
  describe('originating session fan-out', () => {
    it('emits to the originating session when no waiters are parked', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([]);
      mockLoadRunOriginatingSessionId.mockResolvedValueOnce(SESSION_A);
      await emitWorkflowProgress(
        { db: {} as never, redis: {} as never },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          event: { kind: 'WorkflowTaskUpdate', payload: baseTaskPayload },
        },
      );
      expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
      const [, , sessionId, event] = mockAppendSessionEvent.mock.calls[0]!;
      expect(sessionId).toBe(SESSION_A);
      expect(event.workflowTaskUpdate).toEqual(baseTaskPayload);
    });

    it('emits once when the originating session is also a waiter (dedup)', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([makeWaiter(SESSION_A, STEP_EXEC_A)]);
      mockLoadRunOriginatingSessionId.mockResolvedValueOnce(SESSION_A);
      await emitWorkflowProgress(
        { db: {} as never, redis: {} as never },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          event: { kind: 'WorkflowRunUpdate', payload: baseRunPayload },
        },
      );
      expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    });

    it('emits to both originating session AND distinct waiter', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([makeWaiter(SESSION_B, STEP_EXEC_B)]);
      mockLoadRunOriginatingSessionId.mockResolvedValueOnce(SESSION_A);
      await emitWorkflowProgress(
        { db: {} as never, redis: {} as never },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          event: { kind: 'WorkflowTaskUpdate', payload: baseTaskPayload },
        },
      );
      const fanOutSessionIds = mockAppendSessionEvent.mock.calls.map((c) => c[2]).sort();
      expect(fanOutSessionIds).toEqual([SESSION_B, SESSION_A].sort());
    });

    it('honors excludeSessionIds for the originating session too', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([]);
      mockLoadRunOriginatingSessionId.mockResolvedValueOnce(SESSION_A);
      await emitWorkflowProgress(
        { db: {} as never, redis: {} as never },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          event: { kind: 'WorkflowTaskUpdate', payload: baseTaskPayload },
          excludeSessionIds: [SESSION_A],
        },
      );
      expect(mockAppendSessionEvent).not.toHaveBeenCalled();
    });

    it('is a no-op when neither waiter nor originating session is present', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([]);
      mockLoadRunOriginatingSessionId.mockResolvedValueOnce(null);
      await emitWorkflowProgress(
        { db: {} as never, redis: {} as never },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          event: { kind: 'WorkflowTaskUpdate', payload: baseTaskPayload },
        },
      );
      expect(mockAppendSessionEvent).not.toHaveBeenCalled();
    });
  });
});

describe('emitCatchupToNewWaiter — Plan 135 §4.2', () => {
  beforeEach(() => {
    mockBuildWorkflowRunDetail.mockReset();
    mockAppendSessionEvent.mockReset();
    mockLoadPendingWaiters.mockReset();
  });

  const SPACE = '00000000-0000-4000-8000-000000000ff0';

  function makeDetail(taskStatuses: string[]) {
    return {
      run: {
        runId: RUN_ID,
        workflowSlug: 'compose-skill',
        workflowTitle: 'Compose a skill',
        workflowRevision: 1,
        status: 'running',
        pauseVersion: 0,
        startedAt: NOW,
      },
      tasks: taskStatuses.map((status, i) => ({
        taskId: `t${String(i)}`,
        label: `Task ${String(i)}`,
        status,
        attempt: 1,
      })),
      activeWaiters: [],
    };
  }

  it('returns 0 events when the run cannot be loaded (vanished)', async () => {
    mockBuildWorkflowRunDetail.mockResolvedValueOnce(null);
    const count = await emitCatchupToNewWaiter(
      { db: {} as never, redis: {} as never, payloadStore: {} as never },
      {
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN_ID,
        waiterSessionId: SESSION_A,
        waiterStepExecutionId: STEP_EXEC_A,
      },
    );
    expect(count).toBe(0);
    expect(mockAppendSessionEvent).not.toHaveBeenCalled();
  });

  it('emits one WorkflowRunUpdate (with waiterStepExecutionId mount anchor) + per-task updates for non-terminal tasks', async () => {
    mockBuildWorkflowRunDetail.mockResolvedValueOnce(
      makeDetail(['succeeded', 'running', 'scheduled', 'failed', 'paused']),
    );
    const count = await emitCatchupToNewWaiter(
      { db: {} as never, redis: {} as never, payloadStore: {} as never },
      {
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN_ID,
        waiterSessionId: SESSION_A,
        waiterStepExecutionId: STEP_EXEC_A,
      },
    );
    // 1 run update + 3 non-terminal task updates (running, scheduled, paused).
    // succeeded + failed are terminal and skipped.
    expect(count).toBe(4);
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(4);

    const events = mockAppendSessionEvent.mock.calls.map((c) => c[3]);
    expect(events[0].eventType).toBe('WorkflowRunUpdate');
    // Mount anchor is the load-bearing field on catch-up.
    expect(events[0].workflowRunUpdate.waiterStepExecutionId).toBe(STEP_EXEC_A);
    expect(events[0].sessionId).toBe(SESSION_A);

    // Subsequent events are WorkflowTaskUpdate, and none are terminal.
    const taskStatuses = events
      .slice(1)
      .map((e) => e.workflowTaskUpdate.status as string)
      .sort();
    expect(taskStatuses).toEqual(['paused', 'running', 'scheduled']);
  });

  it('emits to the new waiter session ONLY (does not call loadPendingWaiters)', async () => {
    mockBuildWorkflowRunDetail.mockResolvedValueOnce(makeDetail(['running']));
    await emitCatchupToNewWaiter(
      { db: {} as never, redis: {} as never, payloadStore: {} as never },
      {
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN_ID,
        waiterSessionId: SESSION_B,
        waiterStepExecutionId: STEP_EXEC_B,
      },
    );
    // Targeted to one session — no fan-out.
    expect(mockLoadPendingWaiters).not.toHaveBeenCalled();
    const sessionIdsTargeted = mockAppendSessionEvent.mock.calls.map((c) => c[2]);
    expect(new Set(sessionIdsTargeted)).toEqual(new Set([SESSION_B]));
  });
});
