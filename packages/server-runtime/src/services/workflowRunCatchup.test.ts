import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@aflow/schemas';

const mockLoadPendingWaitersForSession = vi.fn();
const mockBuildWorkflowRunDetail = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadPendingWaitersForSession: (...args: unknown[]) => mockLoadPendingWaitersForSession(...args),
  buildWorkflowRunDetail: (...args: unknown[]) => mockBuildWorkflowRunDetail(...args),
}));

import {
  buildSessionCatchupEvents,
  MAX_CATCHUP_RUNS,
  MAX_CATCHUP_TASKS_PER_RUN,
} from './workflowRunCatchup.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002' as unknown as SessionId;
const SPACE = '00000000-0000-4000-8000-000000000003';
const RUN_1 = '00000000-0000-4000-8000-00000000aaaa';
const RUN_2 = '00000000-0000-4000-8000-00000000bbbb';
const STEP_EXEC = '00000000-0000-4000-8000-00000000cccc';
const NOW = '2026-05-11T12:00:00.000Z';

function makeWaiter(runId: string, stepExecutionId = STEP_EXEC) {
  return { runId, waiterSessionId: SESSION, waiterStepExecutionId: stepExecutionId };
}

function makeDetail(runId: string, taskCount: number, withTitle = true) {
  return {
    run: {
      runId,
      workflowSlug: 'compose-skill',
      ...(withTitle ? { workflowTitle: 'Compose a skill' } : {}),
      workflowRevision: 1,
      status: 'running',
      pauseVersion: 0,
      startedAt: NOW,
    },
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      taskId: `task-${i}`,
      label: `Task ${i}`,
      status: i === 0 ? 'succeeded' : i === 1 ? 'running' : 'scheduled',
      attempt: 1,
    })),
    activeWaiters: [],
  };
}

describe('buildSessionCatchupEvents — Plan 135 §4.1.4', () => {
  beforeEach(() => {
    mockLoadPendingWaitersForSession.mockReset();
    mockBuildWorkflowRunDetail.mockReset();
  });

  it('returns empty events array when the session has no active waiters', async () => {
    mockLoadPendingWaitersForSession.mockResolvedValueOnce([]);
    const result = await buildSessionCatchupEvents(
      {} as never,
      {} as never,
      TENANT,
      SESSION,
      SPACE,
    );
    expect(result.events).toEqual([]);
    expect(result.runsTruncated).toBe(false);
    expect(result.tasksTruncated).toBe(0);
    // No detail fetches for empty waiter list.
    expect(mockBuildWorkflowRunDetail).not.toHaveBeenCalled();
  });

  it('emits a WorkflowRunUpdate with waiterStepExecutionId, then per-task WorkflowTaskUpdate events', async () => {
    mockLoadPendingWaitersForSession.mockResolvedValueOnce([makeWaiter(RUN_1)]);
    mockBuildWorkflowRunDetail.mockResolvedValueOnce(makeDetail(RUN_1, 3));

    const { events } = await buildSessionCatchupEvents(
      {} as never,
      {} as never,
      TENANT,
      SESSION,
      SPACE,
    );

    expect(events).toHaveLength(4); // 1 run + 3 task
    expect(events[0]!.eventType).toBe('WorkflowRunUpdate');
    expect(events[0]!.data.workflowRunUpdate?.runId).toBe(RUN_1);
    expect(events[0]!.data.workflowRunUpdate?.waiterStepExecutionId).toBe(STEP_EXEC);
    expect(events[0]!.metadata).toMatchObject({ catchup: true });
    for (const e of events.slice(1)) {
      expect(e.eventType).toBe('WorkflowTaskUpdate');
      expect(e.data.workflowTaskUpdate?.runId).toBe(RUN_1);
      expect(e.metadata).toMatchObject({ catchup: true });
    }
  });

  it('skips runs whose detail load returns null (vanished between waiter read and now)', async () => {
    mockLoadPendingWaitersForSession.mockResolvedValueOnce([makeWaiter(RUN_1), makeWaiter(RUN_2)]);
    mockBuildWorkflowRunDetail.mockResolvedValueOnce(null);
    mockBuildWorkflowRunDetail.mockResolvedValueOnce(makeDetail(RUN_2, 1));

    const { events } = await buildSessionCatchupEvents(
      {} as never,
      {} as never,
      TENANT,
      SESSION,
      SPACE,
    );

    // Only RUN_2's events should appear.
    const runIds = events
      .filter((e) => e.eventType === 'WorkflowRunUpdate')
      .map((e) => e.data.workflowRunUpdate?.runId);
    expect(runIds).toEqual([RUN_2]);
  });

  it('caps runs at MAX_CATCHUP_RUNS and sets metadata.runsTruncated', async () => {
    const waiters = Array.from({ length: MAX_CATCHUP_RUNS + 5 }, (_, i) =>
      makeWaiter(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
    );
    mockLoadPendingWaitersForSession.mockResolvedValueOnce(waiters);
    for (let i = 0; i < MAX_CATCHUP_RUNS; i++) {
      mockBuildWorkflowRunDetail.mockResolvedValueOnce(makeDetail(waiters[i]!.runId, 1));
    }

    const { events, runsTruncated } = await buildSessionCatchupEvents(
      {} as never,
      {} as never,
      TENANT,
      SESSION,
      SPACE,
    );

    expect(runsTruncated).toBe(true);
    // Detail called only for the first MAX_CATCHUP_RUNS waiters.
    expect(mockBuildWorkflowRunDetail).toHaveBeenCalledTimes(MAX_CATCHUP_RUNS);
    // Every catch-up event carries runsTruncated.
    for (const e of events) {
      expect(e.metadata).toMatchObject({ catchup: true, runsTruncated: true });
    }
  });

  it('caps tasks per run at MAX_CATCHUP_TASKS_PER_RUN and sets metadata.truncated on task events', async () => {
    mockLoadPendingWaitersForSession.mockResolvedValueOnce([makeWaiter(RUN_1)]);
    mockBuildWorkflowRunDetail.mockResolvedValueOnce(
      makeDetail(RUN_1, MAX_CATCHUP_TASKS_PER_RUN + 5),
    );

    const { events, tasksTruncated } = await buildSessionCatchupEvents(
      {} as never,
      {} as never,
      TENANT,
      SESSION,
      SPACE,
    );

    expect(tasksTruncated).toBe(1);
    const taskEvents = events.filter((e) => e.eventType === 'WorkflowTaskUpdate');
    expect(taskEvents).toHaveLength(MAX_CATCHUP_TASKS_PER_RUN);
    for (const e of taskEvents) {
      expect(e.metadata).toMatchObject({ catchup: true, truncated: true });
    }
    const runEvent = events.find((e) => e.eventType === 'WorkflowRunUpdate');
    expect(runEvent).toBeDefined();
    expect(runEvent?.metadata).toMatchObject({ catchup: true, tasksTruncated: true });
  });

  it('orders truncated tasks terminal-first → in-flight → pending', async () => {
    // 30 tasks, mix: 10 succeeded, 5 running, 15 scheduled. With MAX=25, the
    // last 5 scheduled tasks should be dropped, terminal+running preserved.
    const tasks = [
      ...Array.from({ length: 10 }, (_, i) => ({
        taskId: `term-${i}`,
        label: `t${i}`,
        status: 'succeeded' as const,
        attempt: 1,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        taskId: `run-${i}`,
        label: `r${i}`,
        status: 'running' as const,
        attempt: 1,
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        taskId: `pend-${i}`,
        label: `p${i}`,
        status: 'scheduled' as const,
        attempt: 1,
      })),
    ];
    mockLoadPendingWaitersForSession.mockResolvedValueOnce([makeWaiter(RUN_1)]);
    mockBuildWorkflowRunDetail.mockResolvedValueOnce({
      run: {
        runId: RUN_1,
        workflowSlug: 's',
        workflowRevision: 1,
        status: 'running',
        pauseVersion: 0,
        startedAt: NOW,
      },
      tasks,
      activeWaiters: [],
    });

    const { events } = await buildSessionCatchupEvents(
      {} as never,
      {} as never,
      TENANT,
      SESSION,
      SPACE,
    );

    const taskEvents = events.filter((e) => e.eventType === 'WorkflowTaskUpdate');
    expect(taskEvents).toHaveLength(MAX_CATCHUP_TASKS_PER_RUN);
    const statuses = taskEvents.map((e) => e.data.workflowTaskUpdate?.status);
    expect(statuses.slice(0, 10).every((s) => s === 'succeeded')).toBe(true);
    expect(statuses.slice(10, 15).every((s) => s === 'running')).toBe(true);
    expect(statuses.slice(15).every((s) => s === 'scheduled')).toBe(true);
  });
});
