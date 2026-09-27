import { describe, it, expect } from 'vitest';

import { runViewReducer, initialRunViewState } from './reducer.js';
import type { RunViewState } from './reducer.js';
import type { InlineAppletItem, SessionEvent } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const RUN_ID = '22222222-2222-2222-2222-222222222222';
const STEP_EXEC_ID = '33333333-3333-3333-3333-333333333333';
const WAITER_STEP_EXEC_ID = '44444444-4444-4444-4444-444444444444';

function makeEvent(
  eventType: string,
  data: Record<string, unknown>,
  opts: { timestamp?: string; metadata?: Record<string, unknown>; stepExecutionId?: string } = {},
): SessionEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    sessionId: SESSION_ID,
    timestamp: opts.timestamp ?? '2026-05-12T10:00:00.000Z',
    sequenceNumber: 0,
    eventVersion: 1,
    data,
    ...(opts.stepExecutionId ? { stepExecutionId: opts.stepExecutionId } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  } as SessionEvent;
}

function pauseEvent(opts: {
  pauseContract: Record<string, unknown>;
  pausedAtStepExecutionId?: string;
  timestamp?: string;
}): SessionEvent {
  return makeEvent(
    'SessionPaused',
    {
      pauseContract: opts.pauseContract,
      ...(opts.pausedAtStepExecutionId
        ? { pausedAtStepExecutionId: opts.pausedAtStepExecutionId }
        : {}),
    },
    {
      ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
      stepExecutionId: opts.pausedAtStepExecutionId ?? STEP_EXEC_ID,
    },
  );
}

function runUpdateEvent(opts: {
  runId?: string;
  status: string;
  pauseVersion?: number;
  startedAt?: string;
  completedAt?: string;
  workflowTitle?: string;
  slug?: string;
  waiterStepExecutionId?: string;
  metadata?: Record<string, unknown>;
}): SessionEvent {
  return makeEvent(
    'WorkflowRunUpdate',
    {
      workflowRunUpdate: {
        runId: opts.runId ?? RUN_ID,
        slug: opts.slug ?? 'demo-workflow',
        status: opts.status,
        pauseVersion: opts.pauseVersion ?? 1,
        startedAt: opts.startedAt ?? '2026-05-12T10:00:00.000Z',
        ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
        ...(opts.workflowTitle ? { workflowTitle: opts.workflowTitle } : {}),
        ...(opts.waiterStepExecutionId
          ? { waiterStepExecutionId: opts.waiterStepExecutionId }
          : {}),
      },
    },
    opts.metadata ? { metadata: opts.metadata } : {},
  );
}

function taskUpdateEvent(opts: {
  runId?: string;
  taskId: string;
  label: string;
  status: string;
  attempt?: number;
  workerSessionId?: string;
  operationId?: string;
  taskType?: 'agent' | 'operation' | 'human';
  humanIntent?: 'approve' | 'collect';
  humanDecision?: {
    decision: 'approved' | 'rejected';
    decidedAt?: string;
    decidedBy?: string;
    comment?: string;
  };
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
  cleared?: true;
  metadata?: Record<string, unknown>;
}): SessionEvent {
  return makeEvent(
    'WorkflowTaskUpdate',
    {
      workflowTaskUpdate: {
        runId: opts.runId ?? RUN_ID,
        taskId: opts.taskId,
        label: opts.label,
        status: opts.status,
        attempt: opts.attempt ?? 1,
        ...(opts.workerSessionId ? { workerSessionId: opts.workerSessionId } : {}),
        ...(opts.operationId ? { operationId: opts.operationId } : {}),
        ...(opts.taskType ? { taskType: opts.taskType } : {}),
        ...(opts.humanIntent ? { humanIntent: opts.humanIntent } : {}),
        ...(opts.humanDecision ? { humanDecision: opts.humanDecision } : {}),
        ...(opts.failureReason ? { failureReason: opts.failureReason } : {}),
        ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
        ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
        ...(opts.cleared ? { cleared: opts.cleared } : {}),
      },
    },
    opts.metadata ? { metadata: opts.metadata } : {},
  );
}

function taskActivityEvent(opts: {
  runId?: string;
  taskId: string;
  operationId: string;
  stepName?: string;
  stepDetail?: string;
  workerSessionId?: string;
  sequence?: number;
  timestamp?: string;
}): SessionEvent {
  return makeEvent(
    'WorkflowTaskActivity',
    {
      workflowTaskActivity: {
        runId: opts.runId ?? RUN_ID,
        taskId: opts.taskId,
        operationId: opts.operationId,
        ...(opts.stepName ? { stepName: opts.stepName } : {}),
        ...(opts.stepDetail ? { stepDetail: opts.stepDetail } : {}),
        workerSessionId: opts.workerSessionId ?? '88888888-8888-8888-8888-888888888888',
        sequence: opts.sequence ?? 1,
      },
    },
    opts.timestamp ? { timestamp: opts.timestamp } : {},
  );
}

function apply(state: RunViewState, ...events: SessionEvent[]): RunViewState {
  return events.reduce((s, event) => runViewReducer(s, { type: 'SSE_EVENT', event }), state);
}

// ---------------------------------------------------------------------------
// Mount Rule A — SessionPaused with pauseContract seeds sparse state
// ---------------------------------------------------------------------------

describe('Mount Rule A — SessionPaused/pauseContract', () => {
  it('creates a sparse `workflowRuns[runId]` entry with needsHydration: true', () => {
    const next = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'mount-rule-a-flow',
          status: 'running',
        },
      }),
    );

    const run = next.workflowRuns[RUN_ID];
    expect(run).toBeDefined();
    expect(run.needsHydration).toBe(true);
    expect(run.slug).toBe('mount-rule-a-flow');
    expect(run.isFrozen).toBe(false);
    expect(run.tasks).toEqual({});
    // anchor + createdAtMs land on the surface-item entry, not the
    // run state.
    const surfaceItem = next.workflowSurfaceItems.find((i) => i.runId === RUN_ID);
    expect(surfaceItem).toBeDefined();
    expect(surfaceItem?.anchorStepExecutionId).toBe(STEP_EXEC_ID);
    expect(surfaceItem?.createdAtMs).toBeGreaterThan(0);
  });

  it('is idempotent — a second SessionPaused for the same run does not duplicate the surface item', () => {
    const first = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'f',
          status: 'running',
        },
      }),
    );
    const next = apply(
      first,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'f',
          status: 'running',
        },
      }),
    );
    expect(next.workflowSurfaceItems.filter((i) => i.runId === RUN_ID)).toHaveLength(1);
  });

  it('ignores pauseContract kinds other than waiting_on_workflow_run', () => {
    const next = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: { kind: 'awaiting_user_input', prompt: 'hi' },
      }),
    );
    expect(next.workflowRuns).toEqual({});
    expect(next.workflowSurfaceItems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mount Rule B — catch-up WorkflowRunUpdate with waiterStepExecutionId
// ---------------------------------------------------------------------------

describe('Mount Rule B — catch-up WorkflowRunUpdate', () => {
  it('mounts the surface when the live event carries `waiterStepExecutionId`', () => {
    const next = apply(
      initialRunViewState,
      runUpdateEvent({ status: 'running', waiterStepExecutionId: WAITER_STEP_EXEC_ID }),
    );
    const surfaceItem = next.workflowSurfaceItems.find((i) => i.runId === RUN_ID);
    expect(surfaceItem).toBeDefined();
    expect(surfaceItem?.anchorStepExecutionId).toBe(WAITER_STEP_EXEC_ID);
    expect(surfaceItem?.createdAtMs).toBeGreaterThan(0);
  });

  it('does not duplicate the surface item if Mount Rule A already fired', () => {
    const seeded = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'f',
          status: 'running',
        },
      }),
    );
    const next = apply(
      seeded,
      runUpdateEvent({ status: 'running', waiterStepExecutionId: WAITER_STEP_EXEC_ID }),
    );
    expect(next.workflowSurfaceItems.filter((i) => i.runId === RUN_ID)).toHaveLength(1);
    // Mount-Rule-A's anchor stays pinned.
    expect(next.workflowSurfaceItems[0]?.anchorStepExecutionId).toBe(STEP_EXEC_ID);
  });
});

// ---------------------------------------------------------------------------
// WorkflowRunUpdate — clears needsHydration unless catch-up truncated tasks
// ---------------------------------------------------------------------------

describe('WorkflowRunUpdate handler', () => {
  it('clears `needsHydration` to false when an authoritative update lands', () => {
    const seeded = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'f',
          status: 'running',
        },
      }),
    );
    expect(seeded.workflowRuns[RUN_ID].needsHydration).toBe(true);

    const next = apply(seeded, runUpdateEvent({ status: 'running' }));
    expect(next.workflowRuns[RUN_ID].needsHydration).toBe(false);
  });

  it('keeps `needsHydration: true` when `metadata.tasksTruncated` is set (3.3c)', () => {
    // Catch-up subscribe path: server caps the per-run task batch and
    // signals truncation so the client knows to fetch the BFF detail.
    const next = apply(
      initialRunViewState,
      runUpdateEvent({
        status: 'running',
        waiterStepExecutionId: WAITER_STEP_EXEC_ID,
        metadata: { catchup: true, tasksTruncated: true },
      }),
    );
    expect(next.workflowRuns[RUN_ID].needsHydration).toBe(true);
  });

  it('freezes the run on terminal status (`completed` / `failed` / `cancelled`)', () => {
    const seeded = apply(initialRunViewState, runUpdateEvent({ status: 'running' }));
    expect(seeded.workflowRuns[RUN_ID].isFrozen).toBe(false);

    const next = apply(seeded, runUpdateEvent({ status: 'completed' }));
    expect(next.workflowRuns[RUN_ID].isFrozen).toBe(true);
    expect(next.workflowRuns[RUN_ID].status).toBe('completed');
  });

  it('drops further updates after the run is frozen', () => {
    const seeded = apply(initialRunViewState, runUpdateEvent({ status: 'completed' }));
    expect(seeded.workflowRuns[RUN_ID].isFrozen).toBe(true);

    const after = apply(
      seeded,
      runUpdateEvent({ status: 'running', workflowTitle: 'attempted un-freeze' }),
    );
    // Frozen state is authoritative — the live terminal wins over any
    // later update.
    expect(after.workflowRuns[RUN_ID].status).toBe('completed');
    expect(after.workflowRuns[RUN_ID].workflowTitle).toBeUndefined();
  });

  it('preserves the pause contract across a paused→paused update, drops it on resume', () => {
    // Seed a paused run carrying a BFF-surfaced resume contract.
    const sparse = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'f',
          status: 'running',
        },
      }),
    );
    const seeded = runViewReducer(sparse, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'demo-workflow',
        status: 'paused',
        pauseVersion: 1,
        startedAt: '2026-05-12T10:00:00.000Z',
        tasks: {},
        resumeContract: {
          pauseCause: 'transient_error',
          resumePrompt: 'Provider hiccup — resume to retry.',
          errorCode: 'AI_TIMEOUT',
          errorMessage: 'request timed out',
        },
        isFrozen: false,
        needsHydration: false,
      },
    });
    expect(seeded.workflowRuns[RUN_ID].resumeContract?.pauseCause).toBe('transient_error');

    // A later paused update (e.g. pauseVersion bump) keeps the contract.
    const stillPaused = apply(seeded, runUpdateEvent({ status: 'paused', pauseVersion: 2 }));
    expect(stillPaused.workflowRuns[RUN_ID].resumeContract?.pauseCause).toBe('transient_error');

    // Resuming drops the now-stale contract.
    const resumed = apply(stillPaused, runUpdateEvent({ status: 'running', pauseVersion: 2 }));
    expect(resumed.workflowRuns[RUN_ID].resumeContract).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WorkflowTaskUpdate — including the 3.3b "frozen runs still accept task
// updates" detail-repair path
// ---------------------------------------------------------------------------

describe('WorkflowTaskUpdate handler', () => {
  it('inserts a new task row into a live run', () => {
    const seeded = apply(initialRunViewState, runUpdateEvent({ status: 'running' }));
    const next = apply(
      seeded,
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'running',
        startedAt: '2026-05-12T10:00:01.000Z',
      }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1']).toBeDefined();
    expect(next.workflowRuns[RUN_ID].tasks['t1'].status).toBe('running');
    expect(next.workflowRuns[RUN_ID].tasks['t1'].lastMutatedAtMs).toBeGreaterThan(0);
  });

  it('accepts task updates on frozen runs (3.3b — catch-up race detail-repair)', () => {
    // Catch-up subscribe order: terminal WorkflowRunUpdate lands first
    // (freezes the run), then per-task batch arrives. Without the 3.3b
    // fix the task rows were dropped and the surface rendered with no
    // task UI.
    const seeded = apply(initialRunViewState, runUpdateEvent({ status: 'completed' }));
    expect(seeded.workflowRuns[RUN_ID].isFrozen).toBe(true);

    const next = apply(
      seeded,
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'succeeded',
        completedAt: '2026-05-12T10:00:05.000Z',
      }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1']?.status).toBe('succeeded');
    // Frozen flag is preserved (terminal live signal stays authoritative).
    expect(next.workflowRuns[RUN_ID].isFrozen).toBe(true);
  });

  it('rejects status regressions at the same attempt (`succeeded` → `running` is dropped)', () => {
    const seeded = apply(
      initialRunViewState,
      runUpdateEvent({ status: 'running' }),
      taskUpdateEvent({ taskId: 't1', label: 'T1', status: 'succeeded', attempt: 1 }),
    );
    const next = apply(
      seeded,
      taskUpdateEvent({ taskId: 't1', label: 'T1', status: 'running', attempt: 1 }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1']?.status).toBe('succeeded');
  });

  it('cleared update removes the row so it reverts to a forward-DAG queued node', () => {
    // A producer-rerun deletes its descendant rows server-side. A descendant
    // that already emitted `running` would stay stuck "running" without this —
    // and a same-attempt `running → scheduled` regression is normally dropped.
    const seeded = apply(
      initialRunViewState,
      runUpdateEvent({ status: 'running' }),
      taskUpdateEvent({ taskId: 'validate-task-graph', label: 'Validate', status: 'running' }),
    );
    expect(seeded.workflowRuns[RUN_ID].tasks['validate-task-graph']?.status).toBe('running');

    const next = apply(
      seeded,
      taskUpdateEvent({
        taskId: 'validate-task-graph',
        label: 'Validate',
        status: 'scheduled',
        cleared: true,
      }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['validate-task-graph']).toBeUndefined();
  });

  it('cleared update for an unknown task is a no-op (does not seed a row)', () => {
    const seeded = apply(initialRunViewState, runUpdateEvent({ status: 'running' }));
    const next = apply(
      seeded,
      taskUpdateEvent({
        taskId: 'never-ran',
        label: 'Never',
        status: 'scheduled',
        cleared: true,
      }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['never-ran']).toBeUndefined();
  });

  it('accepts a higher-attempt update even when status regresses (retry path)', () => {
    const seeded = apply(
      initialRunViewState,
      runUpdateEvent({ status: 'running' }),
      taskUpdateEvent({ taskId: 't1', label: 'T1', status: 'failed', attempt: 1 }),
    );
    const next = apply(
      seeded,
      taskUpdateEvent({ taskId: 't1', label: 'T1', status: 'running', attempt: 2 }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1']?.status).toBe('running');
    expect(next.workflowRuns[RUN_ID].tasks['t1']?.attempt).toBe(2);
  });

  it('catch-up replay leaves graphFidelity undefined — rehydration must re-fetch the graph', () => {
    // SSE catch-up emits a slim WorkflowRunUpdate (without graphFidelity /
    // workflowGraph — those are BFF-only) followed by per-task updates.
    // The run-update clears needsHydration to false. Without an additional
    // trigger in useWorkflowRunRehydration that fires when graphFidelity is
    // missing, the BFF call never happens and the forward-DAG rows never
    // render. This test pins the catch-up state shape so future changes
    // can't silently regress that contract.
    const catchup = apply(
      initialRunViewState,
      runUpdateEvent({
        status: 'running',
        waiterStepExecutionId: WAITER_STEP_EXEC_ID,
      }),
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'succeeded',
        startedAt: '2026-05-12T10:00:01.000Z',
        completedAt: '2026-05-12T10:00:02.000Z',
      }),
      taskUpdateEvent({
        taskId: 't2',
        label: 'Task 2',
        status: 'running',
        startedAt: '2026-05-12T10:00:03.000Z',
      }),
    );
    expect(catchup.workflowRuns[RUN_ID].needsHydration).toBe(false);
    expect(catchup.workflowRuns[RUN_ID].graphFidelity).toBeUndefined();
    expect(catchup.workflowRuns[RUN_ID].workflowGraph).toBeUndefined();
    expect(Object.keys(catchup.workflowRuns[RUN_ID].tasks)).toHaveLength(2);
  });

  it('seeds a sparse run entry when WorkflowTaskUpdate(running) arrives before SessionPaused', () => {
    // On the helmsman session's events stream, `emitStepPaused` writes the
    // PAUSED result to the results stream (consumed asynchronously by the
    // orchestrator), while `dispatchTask` writes the running event directly
    // to the session events stream. The running event therefore reaches the
    // reducer BEFORE the SessionPaused that Mount Rule A keys on. Without
    // the self-healing seed below, the first task's row would be silently
    // dropped and the surface would sit at "Loading tasks…" until the first
    // task's succeeded event arrives 30+ seconds later.
    const afterRunning = apply(
      initialRunViewState,
      taskUpdateEvent({
        taskId: 't1',
        label: 'First Task',
        status: 'running',
        startedAt: '2026-05-12T10:00:01.000Z',
      }),
    );
    expect(afterRunning.workflowRuns[RUN_ID]).toBeDefined();
    expect(afterRunning.workflowRuns[RUN_ID].tasks['t1']?.status).toBe('running');
    expect(afterRunning.workflowRuns[RUN_ID].needsHydration).toBe(true);

    // SessionPaused arrives next and upgrades the sparse seed without
    // clobbering the running task we already captured.
    const afterPaused = apply(
      afterRunning,
      pauseEvent({
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
        pausedAtStepExecutionId: WAITER_STEP_EXEC_ID,
      }),
    );
    expect(afterPaused.workflowRuns[RUN_ID].slug).toBe('demo-workflow');
    expect(afterPaused.workflowRuns[RUN_ID].tasks['t1']?.status).toBe('running');
    expect(afterPaused.workflowSurfaceItems.some((it) => it.runId === RUN_ID)).toBe(true);
  });

  it('maps taskType and preserves it + humanIntent across updates that omit them', () => {
    // A human task pauses (carries taskType + humanIntent), then resolves via
    // a `succeeded` update that omits both (only the dispatch/pause emit and
    // the BFF detail carry identity fields). The reducer must keep them so the
    // resolved row still resolves to the human icon, not the generic cube.
    const afterPaused = apply(
      initialRunViewState,
      taskUpdateEvent({
        taskId: 'approve',
        label: 'Approve submission',
        status: 'paused',
        taskType: 'human',
        humanIntent: 'approve',
      }),
    );
    expect(afterPaused.workflowRuns[RUN_ID]?.tasks['approve']?.taskType).toBe('human');
    expect(afterPaused.workflowRuns[RUN_ID]?.tasks['approve']?.humanIntent).toBe('approve');

    // The approve resume emits `succeeded` WITH the decision trace, but omits
    // taskType/humanIntent — both must be preserved while humanDecision lands.
    const afterResolved = apply(
      afterPaused,
      taskUpdateEvent({
        taskId: 'approve',
        label: 'Approve submission',
        status: 'succeeded',
        humanDecision: { decision: 'approved', decidedBy: 'karim@aflow.ai' },
      }),
    );
    const row = afterResolved.workflowRuns[RUN_ID]?.tasks['approve'];
    expect(row?.status).toBe('succeeded');
    expect(row?.taskType).toBe('human');
    expect(row?.humanIntent).toBe('approve');
    expect(row?.humanDecision?.decision).toBe('approved');
    expect(row?.humanDecision?.decidedBy).toBe('karim@aflow.ai');

    // A later bare update (no decision) must not wipe the recorded decision.
    const afterBare = apply(
      afterResolved,
      taskUpdateEvent({ taskId: 'approve', label: 'Approve submission', status: 'succeeded' }),
    );
    expect(afterBare.workflowRuns[RUN_ID]?.tasks['approve']?.humanDecision?.decision).toBe(
      'approved',
    );
  });

  it('preserves humanIntent and stamps humanDecision on approve reject (failed)', () => {
    const afterPaused = apply(
      initialRunViewState,
      taskUpdateEvent({
        taskId: 'approve',
        label: 'Approve submission',
        status: 'paused',
        taskType: 'human',
        humanIntent: 'approve',
      }),
    );

    const afterRejected = apply(
      afterPaused,
      taskUpdateEvent({
        taskId: 'approve',
        label: 'Approve submission',
        status: 'failed',
        failureReason: 'bad data quality',
        humanDecision: {
          decision: 'rejected',
          decidedBy: 'karim@aflow.ai',
          comment: 'bad data quality',
        },
      }),
    );
    const row = afterRejected.workflowRuns[RUN_ID]?.tasks['approve'];
    expect(row?.status).toBe('failed');
    expect(row?.taskType).toBe('human');
    expect(row?.humanIntent).toBe('approve');
    expect(row?.humanDecision?.decision).toBe('rejected');
    expect(row?.failureReason).toBe('bad data quality');
  });

  it('preserves operationId across a later update that omits it', () => {
    const afterRunning = apply(
      initialRunViewState,
      taskUpdateEvent({
        taskId: 'learn',
        label: 'Record learnings',
        status: 'running',
        taskType: 'operation',
        operationId: 'workflow.learn',
      }),
    );
    const afterDone = apply(
      afterRunning,
      taskUpdateEvent({ taskId: 'learn', label: 'Record learnings', status: 'succeeded' }),
    );
    const row = afterDone.workflowRuns[RUN_ID]?.tasks['learn'];
    expect(row?.operationId).toBe('workflow.learn');
    expect(row?.taskType).toBe('operation');
  });
});

// ---------------------------------------------------------------------------

describe('Phase 4 — freeze-on-resume', () => {
  const ANCHOR_1 = STEP_EXEC_ID;
  const ANCHOR_2 = '55555555-5555-5555-5555-555555555555';

  it('produces two surface items when SessionPaused fires twice for the same runId with different anchors', () => {
    const afterFirstPause = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_1,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'succeeded',
        startedAt: '2026-05-12T10:00:01.000Z',
        completedAt: '2026-05-12T10:00:02.000Z',
      }),
    );
    expect(afterFirstPause.workflowSurfaceItems).toHaveLength(1);
    expect(afterFirstPause.workflowSurfaceItems[0].frozenSnapshot).toBeUndefined();

    const afterRePause = apply(
      afterFirstPause,
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_2,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
    );
    expect(afterRePause.workflowSurfaceItems).toHaveLength(2);
    expect(afterRePause.workflowSurfaceItems[0].anchorStepExecutionId).toBe(ANCHOR_1);
    expect(afterRePause.workflowSurfaceItems[1].anchorStepExecutionId).toBe(ANCHOR_2);
  });

  it('freezes the previous card with its state-at-pause-time snapshot', () => {
    const afterRePause = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_1,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'succeeded',
        startedAt: '2026-05-12T10:00:01.000Z',
        completedAt: '2026-05-12T10:00:02.000Z',
      }),
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_2,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
    );

    const oldCard = afterRePause.workflowSurfaceItems[0];
    expect(oldCard.frozenSnapshot).toBeDefined();
    expect(oldCard.frozenSnapshot?.isFrozen).toBe(true);
    expect(oldCard.frozenSnapshot?.tasks['t1']?.status).toBe('succeeded');

    // New card has no frozenSnapshot — reads live state.
    const newCard = afterRePause.workflowSurfaceItems[1];
    expect(newCard.frozenSnapshot).toBeUndefined();
  });

  it('routes subsequent task updates only to the live card, not the frozen one', () => {
    const afterRePause = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_1,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'succeeded',
        startedAt: '2026-05-12T10:00:01.000Z',
        completedAt: '2026-05-12T10:00:02.000Z',
      }),
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_2,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
      // New task lands AFTER the re-pause — only the live state should see it.
      taskUpdateEvent({
        taskId: 't2',
        label: 'Task 2',
        status: 'running',
        startedAt: '2026-05-12T10:00:05.000Z',
      }),
    );

    // Live state has both tasks.
    expect(Object.keys(afterRePause.workflowRuns[RUN_ID].tasks)).toEqual(
      expect.arrayContaining(['t1', 't2']),
    );
    // Frozen snapshot was taken BEFORE t2 arrived — only has t1.
    const oldCard = afterRePause.workflowSurfaceItems[0];
    expect(Object.keys(oldCard.frozenSnapshot?.tasks ?? {})).toEqual(['t1']);
    expect(oldCard.frozenSnapshot?.tasks['t2']).toBeUndefined();
  });

  it('is idempotent when the same anchor arrives twice (replay safety)', () => {
    const seeded = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_1,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
    );
    const replayed = apply(
      seeded,
      pauseEvent({
        pausedAtStepExecutionId: ANCHOR_1,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'demo-workflow',
          status: 'running',
        },
      }),
    );
    // Same anchor = same key = no new entry, no freeze.
    expect(replayed.workflowSurfaceItems).toHaveLength(1);
    expect(replayed.workflowSurfaceItems[0].frozenSnapshot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HYDRATE_WORKFLOW_RUN — merge into partial state; defer to BFF for
// lifecycle when entry is still sparse; prefer existing when authoritative.
// ---------------------------------------------------------------------------

describe('HYDRATE_WORKFLOW_RUN', () => {
  it('merges BFF tasks into a sparse `needsHydration: true` entry', () => {
    const sparse = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'f',
          status: 'running',
        },
      }),
    );
    const next = runViewReducer(sparse, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'authoritative-slug',
        workflowTitle: 'BFF Title',
        status: 'paused',
        pauseVersion: 7,
        startedAt: '2026-05-12T09:55:00.000Z',
        tasks: {
          t1: {
            taskId: 't1',
            label: 'T1',
            status: 'succeeded',
            attempt: 1,
            lastMutatedAtMs: 100,
          },
        },
        isFrozen: false,
        needsHydration: false,
      },
    });
    const merged = next.workflowRuns[RUN_ID];
    // Sparse entry defers to BFF for lifecycle fields (slug, status,
    // pauseVersion, startedAt, workflowTitle).
    expect(merged.slug).toBe('authoritative-slug');
    expect(merged.workflowTitle).toBe('BFF Title');
    expect(merged.status).toBe('paused');
    expect(merged.pauseVersion).toBe(7);
    expect(merged.tasks['t1']?.status).toBe('succeeded');
    expect(merged.needsHydration).toBe(false);
  });

  it('carries the BFF resume contract onto an existing (non-sparse) paused entry', () => {
    // Live SSE lands a paused run first (no contract on the hot event), then
    // the pause-refresh BFF fetch hydrates the rich contract. The merge path
    // (existing entry) must not drop it.
    const live = apply(initialRunViewState, runUpdateEvent({ status: 'paused', pauseVersion: 3 }));
    expect(live.workflowRuns[RUN_ID].resumeContract).toBeUndefined();

    const next = runViewReducer(live, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'demo-workflow',
        status: 'paused',
        pauseVersion: 3,
        startedAt: '2026-05-12T10:00:00.000Z',
        tasks: {},
        resumeContract: {
          pauseCause: 'task_contract_violation',
          resumePrompt: 'Output failed its contract.',
        },
        isFrozen: false,
        needsHydration: false,
      },
    });
    expect(next.workflowRuns[RUN_ID].resumeContract?.pauseCause).toBe('task_contract_violation');
  });

  it('prefers live fields when a real WorkflowRunUpdate already cleared needsHydration', () => {
    // Live path: WorkflowRunUpdate freezes run as `completed`, then a
    // late BFF snapshot arrives claiming the run is still `running`.
    // Live wins — BFF is older by construction.
    const live = apply(
      initialRunViewState,
      runUpdateEvent({
        status: 'completed',
        workflowTitle: 'Live Title',
        completedAt: '2026-05-12T10:05:00.000Z',
      }),
    );
    const next = runViewReducer(live, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'demo-workflow',
        workflowTitle: 'BFF Title (stale)',
        status: 'running',
        pauseVersion: 0,
        startedAt: '2026-05-12T10:00:00.000Z',
        tasks: {},
        isFrozen: false,
        needsHydration: false,
      },
    });
    const merged = next.workflowRuns[RUN_ID];
    expect(merged.status).toBe('completed');
    expect(merged.isFrozen).toBe(true);
    expect(merged.workflowTitle).toBe('Live Title');
    expect(merged.completedAt).toBe('2026-05-12T10:05:00.000Z');
  });

  it('preserves allowedResumeModes from the BFF snapshot when merging a live card (Plan 182 §2.6)', () => {
    // A live interrupt-restart pause: the SSE `WorkflowRunUpdate(paused)` does
    // NOT carry the resume contract, so the live card has no
    // `allowedResumeModes`. The rehydration BFF snapshot must populate it on
    // merge, or the Resume button stays stuck defaulting to acknowledge.
    const live = apply(initialRunViewState, runUpdateEvent({ status: 'paused' }));
    expect(live.workflowRuns[RUN_ID].allowedResumeModes).toBeUndefined();
    const next = runViewReducer(live, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'demo-workflow',
        status: 'paused',
        pauseVersion: 1,
        startedAt: '2026-05-12T10:00:00.000Z',
        tasks: {},
        allowedResumeModes: ['re_execute', 'fail'],
        isFrozen: false,
        needsHydration: false,
      },
    });
    expect(next.workflowRuns[RUN_ID].allowedResumeModes).toEqual(['re_execute', 'fail']);
  });

  it('still merges BFF tasks into a frozen entry (3.3b detail-repair path)', () => {
    // Catch-up race left the run frozen with empty tasks; BFF should
    // fill them.
    const frozenEmpty = apply(initialRunViewState, runUpdateEvent({ status: 'completed' }));
    expect(frozenEmpty.workflowRuns[RUN_ID].isFrozen).toBe(true);
    expect(Object.keys(frozenEmpty.workflowRuns[RUN_ID].tasks)).toHaveLength(0);

    const next = runViewReducer(frozenEmpty, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'demo-workflow',
        status: 'completed',
        pauseVersion: 1,
        startedAt: '2026-05-12T10:00:00.000Z',
        tasks: {
          t1: { taskId: 't1', label: 'T1', status: 'succeeded', attempt: 1, lastMutatedAtMs: 100 },
          t2: { taskId: 't2', label: 'T2', status: 'succeeded', attempt: 1, lastMutatedAtMs: 100 },
        },
        isFrozen: true,
        needsHydration: false,
      },
    });
    expect(Object.keys(next.workflowRuns[RUN_ID].tasks).sort()).toEqual(['t1', 't2']);
    expect(next.workflowRuns[RUN_ID].isFrozen).toBe(true);
  });

  it('always picks up `workflowGraph` + `graphFidelity` from the BFF snapshot (3.8)', () => {
    // Live events don't carry the graph; the BFF is authoritative even
    // when a live WorkflowRunUpdate has already landed.
    const live = apply(initialRunViewState, runUpdateEvent({ status: 'running' }));
    expect(live.workflowRuns[RUN_ID].workflowGraph).toBeUndefined();

    const next = runViewReducer(live, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'demo-workflow',
        status: 'running',
        pauseVersion: 1,
        startedAt: '2026-05-12T10:00:00.000Z',
        tasks: {},
        graphFidelity: 'full',
        workflowGraph: {
          taskIds: ['a', 'b'],
          edges: [{ from: 'a', to: 'b' }],
        },
        isFrozen: false,
        needsHydration: false,
      },
    });
    expect(next.workflowRuns[RUN_ID].graphFidelity).toBe('full');
    expect(next.workflowRuns[RUN_ID].workflowGraph?.taskIds).toEqual(['a', 'b']);
  });

  it('bumps the surface revision so `allItems` picks up the merged state', () => {
    const seeded = apply(
      initialRunViewState,
      pauseEvent({
        pausedAtStepExecutionId: STEP_EXEC_ID,
        pauseContract: {
          kind: 'waiting_on_workflow_run',
          runId: RUN_ID,
          slug: 'f',
          status: 'running',
        },
      }),
    );
    const beforeRevision =
      seeded.workflowSurfaceItems.find((i) => i.runId === RUN_ID)?.revision ?? 0;

    const next = runViewReducer(seeded, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'f',
        status: 'running',
        pauseVersion: 1,
        startedAt: '2026-05-12T10:00:00.000Z',
        tasks: {},
        isFrozen: false,
        needsHydration: false,
      },
    });
    const afterRevision = next.workflowSurfaceItems.find((i) => i.runId === RUN_ID)?.revision ?? 0;
    expect(afterRevision).toBeGreaterThan(beforeRevision);
  });

  // Paused human-task hydration must survive a
  // late BFF snapshot that lacks the hydration fields.
  describe('paused human-task hydration preservation', () => {
    function liveHumanTaskUpdate(): SessionEvent {
      // Synth a WorkflowTaskUpdate as the dispatch.ts human-task pause path
      // emits it — paused status + humanIntent + actionPreview +
      // resumeContract + pauseVersion + failureMode.
      return makeEvent('WorkflowTaskUpdate', {
        workflowTaskUpdate: {
          runId: RUN_ID,
          taskId: 'approve-submit',
          label: 'Approve Kaggle submission',
          status: 'paused',
          attempt: 1,
          humanIntent: 'approve',
          actionPreview: {
            op: 'mcp.tool.call',
            input: { serverId: 'kaggle', toolName: 'submit_to_competition' },
          },
          resumeContract: { pauseCause: 'needs_decision' },
          pauseVersion: 2,
          failureMode: 'isolate',
        },
      });
    }

    it('preserves humanIntent + actionPreview when BFF snapshot lands without hydration', () => {
      // Live SSE delivers the paused-row with full hydration.
      const live = apply(
        initialRunViewState,
        runUpdateEvent({ status: 'paused' }),
        liveHumanTaskUpdate(),
      );
      expect(live.workflowRuns[RUN_ID]?.tasks['approve-submit']?.humanIntent).toBe('approve');

      // BFF detail fetch then completes — snapshot was taken before the
      // workflow def fully resolved (or workflow lookup failed), so the
      // task lands as paused-without-hydration. Same status, same attempt
      // ⇒ shouldAcceptTaskUpdate accepts → the wholesale replace would
      // silently wipe humanIntent. The fix field-merges instead.
      const next = runViewReducer(live, {
        type: 'HYDRATE_WORKFLOW_RUN',
        state: {
          runId: RUN_ID,
          slug: 'kaggle-competition-optimizer',
          status: 'paused',
          pauseVersion: 2,
          startedAt: '2026-05-12T10:00:00.000Z',
          tasks: {
            'approve-submit': {
              taskId: 'approve-submit',
              label: 'Approve Kaggle submission',
              status: 'paused',
              attempt: 1,
              lastMutatedAtMs: 100,
              // NB: NO humanIntent / actionPreview / etc.
            },
          },
          isFrozen: false,
          needsHydration: false,
        },
      });
      const merged = next.workflowRuns[RUN_ID]?.tasks['approve-submit'];
      expect(merged?.humanIntent).toBe('approve');
      expect(merged?.actionPreview?.op).toBe('mcp.tool.call');
      expect(merged?.pauseVersion).toBe(2);
      expect(merged?.failureMode).toBe('isolate');
      expect(merged?.resumeContract).toBeDefined();
    });

    it('prefers BFF hydration when prev lacks the field (rehydrate fills gaps)', () => {
      // Live entry has the task as paused but NO hydration (e.g., the
      // catchup path on first connect dropped the fields). BFF snapshot
      // brings hydration. Should accept — incoming wins where prev is
      // empty.
      const live = apply(
        initialRunViewState,
        runUpdateEvent({ status: 'paused' }),
        taskUpdateEvent({
          taskId: 'approve-submit',
          label: 'Approve Kaggle submission',
          status: 'paused',
        }),
      );
      expect(live.workflowRuns[RUN_ID]?.tasks['approve-submit']?.humanIntent).toBeUndefined();

      const next = runViewReducer(live, {
        type: 'HYDRATE_WORKFLOW_RUN',
        state: {
          runId: RUN_ID,
          slug: 'kaggle-competition-optimizer',
          status: 'paused',
          pauseVersion: 2,
          startedAt: '2026-05-12T10:00:00.000Z',
          tasks: {
            'approve-submit': {
              taskId: 'approve-submit',
              label: 'Approve Kaggle submission',
              status: 'paused',
              attempt: 1,
              humanIntent: 'approve',
              actionPreview: { op: 'mcp.tool.call', input: { x: 1 } },
              pauseVersion: 2,
              lastMutatedAtMs: 200,
            },
          },
          isFrozen: false,
          needsHydration: false,
        },
      });
      expect(next.workflowRuns[RUN_ID]?.tasks['approve-submit']?.humanIntent).toBe('approve');
      expect(next.workflowRuns[RUN_ID]?.tasks['approve-submit']?.actionPreview?.op).toBe(
        'mcp.tool.call',
      );
    });

    it('still replaces wholesale when status or attempt advances (live retry path preserved)', () => {
      // Live entry is paused (attempt 1). BFF snapshot has succeeded
      // (attempt 1) — a forward transition. Field-merge must NOT block
      // the genuine state transition; wholesale replace is correct here.
      const live = apply(
        initialRunViewState,
        runUpdateEvent({ status: 'paused' }),
        liveHumanTaskUpdate(),
      );
      const next = runViewReducer(live, {
        type: 'HYDRATE_WORKFLOW_RUN',
        state: {
          runId: RUN_ID,
          slug: 'kaggle-competition-optimizer',
          status: 'completed',
          pauseVersion: 2,
          startedAt: '2026-05-12T10:00:00.000Z',
          tasks: {
            'approve-submit': {
              taskId: 'approve-submit',
              label: 'Approve Kaggle submission',
              status: 'succeeded',
              attempt: 1,
              lastMutatedAtMs: 300,
            },
          },
          isFrozen: true,
          needsHydration: false,
        },
      });
      const merged = next.workflowRuns[RUN_ID]?.tasks['approve-submit'];
      expect(merged?.status).toBe('succeeded');
      // succeeded ⇒ no inline approval UI; hydration fields shouldn't
      // linger on a terminal row.
      expect(merged?.humanIntent).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------

describe('Phase 7 — WorkflowTaskActivity handler', () => {
  function seedWithRunningTask() {
    return apply(
      initialRunViewState,
      runUpdateEvent({ status: 'running' }),
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'running',
        workerSessionId: '88888888-8888-8888-8888-888888888888',
        startedAt: '2026-05-13T10:00:01.000Z',
      }),
    );
  }

  it('applies operationId / stepName / stepDetail to the running task', () => {
    const next = apply(
      seedWithRunningTask(),
      taskActivityEvent({
        taskId: 't1',
        operationId: 'ai.text.generate',
        stepName: 'Generate Plan',
        stepDetail: 'claude-sonnet-4-7',
      }),
    );
    const task = next.workflowRuns[RUN_ID].tasks['t1'];
    expect(task.activeOp).toBe('ai.text.generate');
    expect(task.activeStepName).toBe('Generate Plan');
    expect(task.activeDetail).toBe('claude-sonnet-4-7');
    expect(task.activeOpSequence).toBe(1);
    expect(task.activeOpUpdatedAtMs).toBeGreaterThan(0);
  });

  it('refreshes lastMutatedAtMs so the stalled-row threshold restarts', () => {
    const seeded = seedWithRunningTask();
    const before = seeded.workflowRuns[RUN_ID].tasks['t1'].lastMutatedAtMs;
    const next = apply(
      seeded,
      taskActivityEvent({
        taskId: 't1',
        operationId: 'ai.text.generate',
        timestamp: '2026-05-12T10:00:01.000Z',
      }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1'].lastMutatedAtMs).toBeGreaterThan(before);
  });

  it('drops out-of-order events (sequence <= prior)', () => {
    const afterSeq3 = apply(
      seedWithRunningTask(),
      taskActivityEvent({ taskId: 't1', operationId: 'ai.text.generate', sequence: 3 }),
    );
    const next = apply(
      afterSeq3,
      taskActivityEvent({ taskId: 't1', operationId: 'api.http.call', sequence: 2 }),
    );
    // sequence 2 < 3 → dropped; activeOp stays at the earlier value.
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeOp).toBe('ai.text.generate');
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeOpSequence).toBe(3);
  });

  it('drops events whose runId has no seeded workflowRuns entry', () => {
    // Activity event with no prior WorkflowTaskUpdate / SessionPaused — the
    // run isn't known to the reducer. Discard silently; the next live
    // event will seed the run.
    const next = apply(
      initialRunViewState,
      taskActivityEvent({ taskId: 't1', operationId: 'ai.text.generate' }),
    );
    expect(next.workflowRuns).toEqual({});
  });

  it('drops events for a task that is already terminal', () => {
    const seeded = apply(
      initialRunViewState,
      runUpdateEvent({ status: 'running' }),
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'succeeded',
        completedAt: '2026-05-13T10:00:05.000Z',
      }),
    );
    const next = apply(
      seeded,
      taskActivityEvent({ taskId: 't1', operationId: 'ai.text.generate' }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeOp).toBeUndefined();
  });

  it('clears activity fields when the task transitions to terminal status', () => {
    const withActivity = apply(
      seedWithRunningTask(),
      taskActivityEvent({ taskId: 't1', operationId: 'ai.text.generate', stepDetail: 'gpt-4o' }),
    );
    expect(withActivity.workflowRuns[RUN_ID].tasks['t1'].activeOp).toBe('ai.text.generate');

    const next = apply(
      withActivity,
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'succeeded',
        completedAt: '2026-05-13T10:00:05.000Z',
      }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeOp).toBeUndefined();
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeStepName).toBeUndefined();
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeDetail).toBeUndefined();
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeOpSequence).toBeUndefined();
  });

  it('replaces stepName / stepDetail on op change — no leak from prior activity', () => {
    // The "Runner · python3-ml" bug: an `ai.agent.turn` activity event
    // landed first (stepName="Runner", stepDetail=undefined), then a
    // `compute.sandbox.exec` event landed (stepName=undefined,
    // stepDetail="python3-ml"). Conditional spread on payload fields
    // preserved the prior op's stepName, fusing two different steps into
    // one subline. The fix is full replacement on every applied event.
    const next = apply(
      seedWithRunningTask(),
      taskActivityEvent({
        taskId: 't1',
        operationId: 'ai.agent.turn',
        stepName: 'Runner',
        sequence: 1,
      }),
      taskActivityEvent({
        taskId: 't1',
        operationId: 'compute.sandbox.exec',
        stepDetail: 'python3-ml',
        sequence: 2,
      }),
    );
    const task = next.workflowRuns[RUN_ID].tasks['t1'];
    expect(task.activeOp).toBe('compute.sandbox.exec');
    // stepName from the earlier `ai.agent.turn` event MUST NOT leak.
    expect(task.activeStepName).toBeUndefined();
    expect(task.activeDetail).toBe('python3-ml');
  });

  it('tracks lastSubstantive* only on non-thinking-class activity events', () => {
    // The thinking-grace UX (Phase 7 follow-up): the reducer caches the
    // most-recent NON-thinking activity so the render can keep it visible
    // during short thinking-class gaps. Only updates on substantive ops
    // (tools, API/memory/compute calls, etc.); never updates on
    // `ai.agent.turn` / `agent.control.run_step`.
    const afterTool = apply(
      seedWithRunningTask(),
      taskActivityEvent({
        taskId: 't1',
        operationId: 'compute.sandbox.exec',
        stepDetail: 'python3-ml',
        sequence: 1,
      }),
    );
    const t1 = afterTool.workflowRuns[RUN_ID].tasks['t1'];
    expect(t1.lastSubstantiveOp).toBe('compute.sandbox.exec');
    expect(t1.lastSubstantiveDetail).toBe('python3-ml');
    expect(t1.lastSubstantiveOpUpdatedAtMs).toBeGreaterThan(0);

    // Next event flips to `ai.agent.turn` (thinking). activeOp updates,
    // but lastSubstantive* MUST NOT be overwritten — it's the cache the
    // render falls back to during the thinking-grace window.
    const afterThinking = apply(
      afterTool,
      taskActivityEvent({
        taskId: 't1',
        operationId: 'ai.agent.turn',
        stepName: 'Runner',
        sequence: 2,
      }),
    );
    const t2 = afterThinking.workflowRuns[RUN_ID].tasks['t1'];
    expect(t2.activeOp).toBe('ai.agent.turn');
    expect(t2.lastSubstantiveOp).toBe('compute.sandbox.exec'); // preserved
    expect(t2.lastSubstantiveDetail).toBe('python3-ml');

    // `agent.control.run_step` is also thinking-class (synthetic
    // wrapper around tool execution); it MUST NOT overwrite the
    // substantive cache either.
    const afterRunStep = apply(
      afterThinking,
      taskActivityEvent({
        taskId: 't1',
        operationId: 'agent.control.run_step',
        sequence: 3,
      }),
    );
    const t3 = afterRunStep.workflowRuns[RUN_ID].tasks['t1'];
    expect(t3.activeOp).toBe('agent.control.run_step');
    expect(t3.lastSubstantiveOp).toBe('compute.sandbox.exec'); // still preserved
  });

  it('preserves activity fields across a non-terminal status update', () => {
    // Mid-run, a WorkflowTaskUpdate(running) arrives (e.g. attempt bump or
    // restart) — activity fields should survive so the subline doesn't
    // blink during normal lifecycle bumps.
    const withActivity = apply(
      seedWithRunningTask(),
      taskActivityEvent({ taskId: 't1', operationId: 'ai.text.generate', stepDetail: 'gpt-4o' }),
    );
    const next = apply(
      withActivity,
      taskUpdateEvent({
        taskId: 't1',
        label: 'Task 1',
        status: 'running',
        workerSessionId: '88888888-8888-8888-8888-888888888888',
      }),
    );
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeOp).toBe('ai.text.generate');
    expect(next.workflowRuns[RUN_ID].tasks['t1'].activeDetail).toBe('gpt-4o');
  });
});

describe('HYDRATE_SNAPSHOT — Plan 146 Phase 6 mount hydration', () => {
  it('replaces state wholesale with the snapshot', () => {
    // Start from a state with some optimistic content, then hydrate a
    // server-folded snapshot. The previous content is discarded — the
    // caller (use-run-reducer.ts) is responsible for merging any
    // optimistic messages into the snapshot before dispatching HYDRATE.
    const seeded = runViewReducer(initialRunViewState, {
      type: 'USER_MESSAGE',
      content: 'optimistic',
      id: 'u1',
      timestamp: '2026-05-12T10:00:00.000Z',
    });
    expect(seeded.messages).toHaveLength(1);

    const snapshot: RunViewState = {
      ...initialRunViewState,
      status: 'RUNNING',
      messages: [
        {
          id: 'snap-1',
          role: 'assistant',
          content: 'server-folded reply',
          timestamp: '2026-05-12T10:00:00.000Z',
        },
      ],
    };

    const next = runViewReducer(seeded, { type: 'HYDRATE_SNAPSHOT', snapshot });
    expect(next.status).toBe('RUNNING');
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.id).toBe('snap-1');
    // The optimistic message is gone — the caller must re-dispatch it.
    expect(next.messages.find((m) => m.id === 'u1')).toBeUndefined();
  });

  it('preserves snapshot workflowRuns + workflowSurfaceItems', () => {
    const snapshot: RunViewState = {
      ...initialRunViewState,
      workflowRuns: {
        'run-1': {
          runId: 'run-1',
          slug: 'test-skill',
          status: 'running',
          pauseVersion: 0,
          startedAt: '2026-05-12T10:00:00.000Z',
          tasks: {},
          isFrozen: false,
          needsHydration: false,
        },
      },
      workflowSurfaceItems: [
        {
          runId: 'run-1',
          anchorStepExecutionId: 'step-1',
          revision: 1,
          createdAtMs: 1_747_044_000_000,
        },
      ],
    };
    const next = runViewReducer(initialRunViewState, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot,
    });
    expect(next.workflowRuns['run-1']?.slug).toBe('test-skill');
    expect(next.workflowSurfaceItems).toHaveLength(1);
    expect(next.workflowSurfaceItems[0]?.runId).toBe('run-1');
  });
});

// ---------------------------------------------------------------------------

describe('runViewReducer — MCP elicitation lifecycle', () => {
  const baseElicit = (
    eventType: string,
    metadata: Record<string, unknown>,
    stepExec = STEP_EXEC_ID,
  ): SessionEvent => makeEvent(eventType, {}, { stepExecutionId: stepExec, metadata });

  function requestedMeta(
    overrides: Partial<{
      elicitationId: string;
      bindingId: string;
      serverId: string;
      request: Record<string, unknown>;
      leaseExpiresAt: string;
    }> = {},
  ): Record<string, unknown> {
    return {
      elicitationId: overrides.elicitationId ?? 'elic-1',
      bindingId: overrides.bindingId ?? 'kaggle-default',
      serverId: overrides.serverId ?? 'kaggle',
      request: overrides.request ?? {
        mode: 'form',
        elicitationId: 'elic-1',
        message: 'Pick a flavor',
        requestedSchema: { type: 'object', properties: { flavor: { type: 'string' } } },
      },
      leaseExpiresAt: overrides.leaseExpiresAt ?? '2099-01-01T00:00:00.000Z',
    };
  }

  it('McpElicitationRequested adds a form-mode entry keyed by elicitationId', () => {
    const next = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationRequested', requestedMeta()),
    });
    expect(Object.keys(next.mcpElicitations)).toEqual(['elic-1']);
    const entry = next.mcpElicitations['elic-1']!;
    expect(entry.mode).toBe('form');
    expect(entry.stepExecutionId).toBe(STEP_EXEC_ID);
    expect(entry.bindingId).toBe('kaggle-default');
    expect(entry.requestedSchema).toEqual({
      type: 'object',
      properties: { flavor: { type: 'string' } },
    });
  });

  it('McpElicitationRequested in url mode captures the url + omits schema', () => {
    const next = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: baseElicit(
        'McpElicitationRequested',
        requestedMeta({
          request: {
            mode: 'url',
            elicitationId: 'elic-url',
            message: 'Open this in your browser',
            url: 'https://oauth.example.com/auth?...',
          },
          elicitationId: 'elic-url',
        }),
      ),
    });
    const entry = next.mcpElicitations['elic-url']!;
    expect(entry.mode).toBe('url');
    expect(entry.url).toBe('https://oauth.example.com/auth?...');
    expect(entry.requestedSchema).toBeUndefined();
  });

  it('ignores malformed McpElicitationRequested envelopes (missing fields)', () => {
    const next = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationRequested', { elicitationId: 'elic-bad' }),
    });
    expect(next.mcpElicitations).toEqual({});
  });

  it('McpElicitationResolved removes the matching entry', () => {
    const withEntry = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationRequested', requestedMeta()),
    });
    const next = runViewReducer(withEntry, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationResolved', {
        elicitationId: 'elic-1',
        action: 'accept',
      }),
    });
    expect(next.mcpElicitations).toEqual({});
  });

  it('McpElicitationTimedOut + McpElicitationExecutorLost both clear the entry', () => {
    let s = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationRequested', requestedMeta()),
    });
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationTimedOut', { elicitationId: 'elic-1' }),
    });
    expect(s.mcpElicitations).toEqual({});

    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: baseElicit(
        'McpElicitationRequested',
        requestedMeta({
          elicitationId: 'elic-2',
          request: {
            mode: 'form',
            elicitationId: 'elic-2',
            message: 'go',
            requestedSchema: { type: 'object', properties: {} },
          },
        }),
      ),
    });
    expect(s.mcpElicitations['elic-2']).toBeDefined();
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationExecutorLost', { elicitationId: 'elic-2' }),
    });
    expect(s.mcpElicitations).toEqual({});
  });

  it('terminal step event clears lingering elicitations anchored to that step', () => {
    // Safety net for the v1 case where the executor times out internally
    // and the orchestrator never emits an explicit TimedOut event — the
    // step's StepFailed must still drop the form.
    let s = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationRequested', requestedMeta()),
    });
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: makeEvent(
        'StepFailed',
        {},
        { stepExecutionId: STEP_EXEC_ID, metadata: { reason: 'elicitation_timeout' } },
      ),
    });
    expect(s.mcpElicitations).toEqual({});
  });

  it('terminal step event leaves elicitations belonging to OTHER steps untouched', () => {
    let s = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: baseElicit('McpElicitationRequested', requestedMeta()),
    });
    // Different step finishing must not nuke the active elicitation.
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: makeEvent('StepSucceeded', {}, { stepExecutionId: WAITER_STEP_EXEC_ID }),
    });
    expect(s.mcpElicitations['elic-1']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe('Plan 156 §5.6.1 — inline HITL message lifecycle', () => {
  const HITL_STEP_EXEC_ID = '55555555-5555-5555-5555-555555555555';

  function inlineApprovalPause(): SessionEvent {
    return makeEvent(
      'SessionPaused',
      {},
      {
        stepExecutionId: HITL_STEP_EXEC_ID,
        metadata: {
          placement: 'chat_inline',
          kind: 'approval',
          title: 'Deploy to production?',
          description: 'Promote v2.3.0 to production environment.',
          reviewData: { rows: 432 },
          // userInputHandler synthesises `prompt = title\n\ndescription`
          // for legacy consumers; we keep that field too.
          prompt: 'Deploy to production?\n\nPromote v2.3.0 to production environment.',
        },
      },
    );
  }

  function inlineInputPause(prompt: string): SessionEvent {
    return makeEvent(
      'SessionPaused',
      {},
      {
        stepExecutionId: HITL_STEP_EXEC_ID,
        metadata: {
          placement: 'chat_inline',
          kind: 'input',
          prompt,
          inputSchema: { type: 'string', enum: ['sales', 'returns', 'inventory'] },
          uiHints: { mode: 'choices', submitLabel: 'Use this' },
        },
      },
    );
  }

  it('emits an `inline_hitl` message with the full pause payload on placement="chat_inline"', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, { type: 'SSE_EVENT', event: inlineApprovalPause() });

    expect(s.status).toBe('PAUSED');
    const msg = s.messages.find((m) => m.semanticType === 'inline_hitl');
    expect(msg).toBeDefined();
    expect(msg?.id).toBe(`inline-hitl-${HITL_STEP_EXEC_ID}`);

    const payload = msg!.richContent as Record<string, unknown>;
    expect(payload['hitlKind']).toBe('human_approval');
    expect(payload['title']).toBe('Deploy to production?');
    expect(payload['body']).toBe('Promote v2.3.0 to production environment.');
    expect(payload['itemId']).toBe(`step:${HITL_STEP_EXEC_ID}`);
    expect(payload['status']).toBe('open');
    expect(payload['reviewData']).toEqual({ rows: 432 });
  });

  it('clears `requiredInput.prompt` so the legacy plain-text fallback in ChatMessages does not double up', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, { type: 'SSE_EVENT', event: inlineApprovalPause() });

    expect(s.requiredInput?.stepExecutionId).toBe(HITL_STEP_EXEC_ID);
    expect(s.requiredInput?.prompt).toBeUndefined();
    expect(s.requiredInput?.placement).toBe('chat_inline');
  });

  it('maps kind="input" → human_input and carries inputSchema / uiHints', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, { type: 'SSE_EVENT', event: inlineInputPause('Which dataset?') });

    const payload = s.messages.find((m) => m.semanticType === 'inline_hitl')!.richContent as Record<
      string,
      unknown
    >;
    expect(payload['hitlKind']).toBe('human_input');
    expect(payload['body']).toBe('Which dataset?');
    expect(payload['inputSchema']).toEqual({
      type: 'string',
      enum: ['sales', 'returns', 'inventory'],
    });
    expect(payload['uiHints']).toEqual({ mode: 'choices', submitLabel: 'Use this' });
  });

  it('flips an open inline HITL to resolved on a matching StepSucceeded (approval kind)', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, { type: 'SSE_EVENT', event: inlineApprovalPause() });

    // Match the on-the-wire shape produced by the orchestrator: the
    // resume payload is stored inline (`inline:<base64>`) and shows
    // up on `data.payloadRef`. The reducer decodes it synchronously.
    // Earlier versions of this test stuffed the payload directly on a
    // non-existent `data.output` field — that path was never on the
    // canonical ApiSessionEventDataSchema, so the test passed but the
    // production reducer call never actually picked up the resolution
    // value.
    const resumePayload = {
      decision: 'approved',
      comment: 'looks good',
      decidedAt: '2026-05-22T14:23:00.000Z',
      decidedBy: 'user-abc',
    };
    const inlineRef = `inline:${btoa(JSON.stringify(resumePayload))}`;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: makeEvent(
        'StepSucceeded',
        { payloadRef: inlineRef },
        { stepExecutionId: HITL_STEP_EXEC_ID },
      ),
    });

    const payload = s.messages.find((m) => m.semanticType === 'inline_hitl')!.richContent as Record<
      string,
      unknown
    >;
    expect(payload['status']).toBe('resolved');
    const resolution = payload['resolution'] as Record<string, unknown>;
    expect(resolution['kind']).toBe('approval');
    expect(resolution['decision']).toBe('approved');
    expect(resolution['comment']).toBe('looks good');
    expect(resolution['decidedBy']).toBe('user-abc');
  });

  it('flips an open inline HITL to resolved on a matching StepSucceeded (input kind)', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: inlineInputPause('Which dataset?'),
    });
    const resumePayload = {
      input: 'sales',
      providedAt: '2026-05-22T14:23:00.000Z',
      providedBy: 'user-abc',
    };
    const inlineRef = `inline:${btoa(JSON.stringify(resumePayload))}`;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: makeEvent(
        'StepSucceeded',
        { payloadRef: inlineRef },
        { stepExecutionId: HITL_STEP_EXEC_ID },
      ),
    });

    const payload = s.messages.find((m) => m.semanticType === 'inline_hitl')!.richContent as Record<
      string,
      unknown
    >;
    const resolution = payload['resolution'] as Record<string, unknown>;
    expect(resolution['kind']).toBe('input');
    expect(resolution['value']).toBe('sales');
    expect(resolution['providedBy']).toBe('user-abc');
  });

  it('decodes a non-string input value verbatim (structured form response)', () => {
    // The user.interaction.ask input schema can be a JSON object, in
    // which case the resume payload's `input` is the structured object.
    // Pin that path so a future refactor doesn't accidentally narrow
    // `resolution.value` to string only.
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: inlineInputPause('Configure the model'),
    });
    const structuredAnswer = {
      modelType: 'XGBoost',
      maxDepth: 6,
      notes: 'try with early stopping',
    };
    const inlineRef = `inline:${btoa(
      JSON.stringify({ input: structuredAnswer, providedAt: '2026-05-22T14:23:00.000Z' }),
    )}`;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: makeEvent(
        'StepSucceeded',
        { payloadRef: inlineRef },
        { stepExecutionId: HITL_STEP_EXEC_ID },
      ),
    });

    const payload = s.messages.find((m) => m.semanticType === 'inline_hitl')!.richContent as Record<
      string,
      unknown
    >;
    const resolution = payload['resolution'] as Record<string, unknown>;
    expect(resolution['value']).toEqual(structuredAnswer);
  });

  // -------------------------------------------------------------------------

  it('INLINE_PROPOSAL_FOCUS mounts an inline_proposal_focus message with the itemId', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, {
      type: 'INLINE_PROPOSAL_FOCUS',
      itemId: 'proposal:7f2d3a16-9b51-4e7f-a3c5-3bf3a3f04d10',
      reason: 'Coach wants you to ratify this.',
      timestamp: '2026-05-22T14:23:00.000Z',
    });
    const msg = s.messages.find((m) => m.semanticType === 'inline_proposal_focus');
    expect(msg).toBeDefined();
    expect(msg?.id).toBe('inline-focus-proposal:7f2d3a16-9b51-4e7f-a3c5-3bf3a3f04d10');
    const payload = msg!.richContent as Record<string, unknown>;
    expect(payload['itemId']).toBe('proposal:7f2d3a16-9b51-4e7f-a3c5-3bf3a3f04d10');
    expect(payload['reason']).toBe('Coach wants you to ratify this.');
  });

  it('derives inline_proposal_focus from a persisted human.action_center.focus StepSucceeded event', () => {
    // Reload case: the SSE focus pubsub is fire-and-forget, but the
    // step's StepSucceeded event lives in event_log. On chat mount the
    // snapshot fold replays this event and the reducer materialises
    // the card from it — same id as the live path, so dedupe holds.
    let s: RunViewState = initialRunViewState;
    const inlineRef = `inline:${Buffer.from(
      JSON.stringify({
        acknowledged: true,
        itemId: 'proposal:7f2d3a16-9b51-4e7f-a3c5-3bf3a3f04d10',
        placement: 'chat_inline',
      }),
    ).toString('base64')}`;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: {
        ...makeEvent('StepSucceeded', { payloadRef: inlineRef }, { stepExecutionId: 'exec-1' }),
        metadata: { operationId: 'human.action_center.focus' },
      } as SessionEvent,
    });
    const msg = s.messages.find((m) => m.semanticType === 'inline_proposal_focus');
    expect(msg).toBeDefined();
    expect(msg?.id).toBe('inline-focus-proposal:7f2d3a16-9b51-4e7f-a3c5-3bf3a3f04d10');
    const payload = msg!.richContent as Record<string, unknown>;
    expect(payload['itemId']).toBe('proposal:7f2d3a16-9b51-4e7f-a3c5-3bf3a3f04d10');
  });

  it('emits inline_proposal_focus from focus StepSucceeded regardless of any stale `placement` value (Plan 166 §HITL — field removed)', () => {
    // Regression for the snapshot-replay rehydration path. Earlier code
    let s: RunViewState = initialRunViewState;
    const inlineRef = `inline:${Buffer.from(
      JSON.stringify({
        acknowledged: true,
        itemId: 'proposal:abc',
        placement: 'peek_panel', // stale field; ignored
      }),
    ).toString('base64')}`;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: {
        ...makeEvent('StepSucceeded', { payloadRef: inlineRef }, { stepExecutionId: 'exec-2' }),
        metadata: { operationId: 'human.action_center.focus' },
      } as SessionEvent,
    });
    const msg = s.messages.find((m) => m.semanticType === 'inline_proposal_focus');
    expect(msg).toBeDefined();
    expect(msg?.id).toBe('inline-focus-proposal:abc');
  });

  it('the durable path and the live SSE path share an id so a reconnect/replay does not double the card', () => {
    let s: RunViewState = initialRunViewState;
    // Live SSE dispatched first.
    s = runViewReducer(s, {
      type: 'INLINE_PROPOSAL_FOCUS',
      itemId: 'proposal:dup',
      timestamp: '2026-05-22T14:00:00.000Z',
    });
    // Snapshot replays the StepSucceeded event for the same focus call.
    const inlineRef = `inline:${Buffer.from(
      JSON.stringify({ itemId: 'proposal:dup', placement: 'chat_inline' }),
    ).toString('base64')}`;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: {
        ...makeEvent('StepSucceeded', { payloadRef: inlineRef }, { stepExecutionId: 'exec-3' }),
        metadata: { operationId: 'human.action_center.focus' },
      } as SessionEvent,
    });
    const matches = s.messages.filter((m) => m.semanticType === 'inline_proposal_focus');
    expect(matches).toHaveLength(1);
  });

  it('dedupes INLINE_PROPOSAL_FOCUS by itemId (SSE reconnect resending the same focus)', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, {
      type: 'INLINE_PROPOSAL_FOCUS',
      itemId: 'proposal:abc',
      timestamp: '2026-05-22T14:23:00.000Z',
    });
    const beforeLen = s.messages.length;
    s = runViewReducer(s, {
      type: 'INLINE_PROPOSAL_FOCUS',
      itemId: 'proposal:abc',
      timestamp: '2026-05-22T14:24:00.000Z',
    });
    expect(s.messages.length).toBe(beforeLen);
  });

  it('does NOT emit an inline_hitl message when placement is absent (legacy path)', () => {
    let s: RunViewState = initialRunViewState;
    s = runViewReducer(s, {
      type: 'SSE_EVENT',
      event: makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: HITL_STEP_EXEC_ID,
          metadata: { prompt: 'Plain old pause', kind: 'input' },
        },
      ),
    });
    expect(s.messages.find((m) => m.semanticType === 'inline_hitl')).toBeUndefined();
    // The legacy `requiredInput.prompt` still surfaces for the
    // `<ChatMessage senderName="System">` fallback.
    expect(s.requiredInput?.prompt).toBe('Plain old pause');
    expect(s.requiredInput?.placement).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const ARTIFACT_ID = '55555555-5555-5555-5555-555555555555';
const VERSION_ID = '66666666-6666-6666-6666-666666666666';
const WORKER_STEP_EXEC_ID = '77777777-7777-7777-7777-777777777777';

function taskUpdateWithPresentation(opts: {
  taskId: string;
  presentation: Record<string, unknown>;
  status?: string;
  stepExecutionId?: string;
}): SessionEvent {
  return makeEvent(
    'WorkflowTaskUpdate',
    {
      workflowTaskUpdate: {
        runId: RUN_ID,
        taskId: opts.taskId,
        label: 'Render output',
        status: opts.status ?? 'succeeded',
        attempt: 1,
        presentation: opts.presentation,
      },
    },
    opts.stepExecutionId ? { stepExecutionId: opts.stepExecutionId } : {},
  );
}

describe('Plan 158 §4.5.5 — workflow-scoped inline mount', () => {
  it('mounts an inline_artifact item from a WorkflowTaskUpdate with rendered_inline artifact presentation', () => {
    const event = taskUpdateWithPresentation({
      taskId: 'render-portfolio',
      presentation: {
        mode: 'rendered_inline',
        substrate: 'artifact',
        payloadRef: 'inline:eyJodG1sIjoiPGh0bWwvPiJ9',
        artifactId: ARTIFACT_ID,
        versionId: VERSION_ID,
      },
      stepExecutionId: WORKER_STEP_EXEC_ID,
    });
    const next = apply(initialRunViewState, event);
    const itemId = `workflow:${RUN_ID}:render-portfolio`;
    const item = next.inlineItems[itemId];
    expect(item).toBeDefined();
    expect(item?.kind).toBe('inline_artifact');
    if (item?.kind === 'inline_artifact') {
      expect(item.artifactId).toBe(ARTIFACT_ID);
      expect(item.versionId).toBe(VERSION_ID);
      expect(item.workflowRunId).toBe(RUN_ID);
      expect(item.anchorStepExecutionId).toBe(WORKER_STEP_EXEC_ID);
    }
  });

  it('mounts an inline_surface item with isStreaming=false from a terminal task update', () => {
    const event = taskUpdateWithPresentation({
      taskId: 'render-dashboard',
      presentation: {
        mode: 'rendered_inline',
        substrate: 'surface',
        surfaceId: 'sfc-1',
      },
    });
    const next = apply(initialRunViewState, event);
    const itemId = `workflow:${RUN_ID}:render-dashboard`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_surface');
    if (item?.kind === 'inline_surface') {
      expect(item.surfaceId).toBe('sfc-1');
      expect(item.isStreaming).toBe(false);
    }
  });

  it('does NOT mount when WorkflowTaskUpdate carries no presentation (default summarize semantics)', () => {
    const event = taskUpdateEvent({ taskId: 'plain', label: 'Plain step', status: 'succeeded' });
    const next = apply(initialRunViewState, event);
    expect(next.inlineItems).toEqual({});
  });

  it('upserts inline_surface from WorkflowTaskSurfaceUpdate stream with isStreaming=true', () => {
    const event = makeEvent('WorkflowTaskSurfaceUpdate', {
      workflowTaskSurfaceUpdate: {
        runId: RUN_ID,
        taskId: 'render-dashboard',
        stepExecutionId: WORKER_STEP_EXEC_ID,
        surfaceId: 'sfc-stream',
        surfaceMutations: [{ type: 'createSurface', surfaceId: 'sfc-stream' }],
        sequence: 1,
      },
    });
    const next = apply(initialRunViewState, event);
    const itemId = `workflow:${RUN_ID}:render-dashboard`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_surface');
    if (item?.kind === 'inline_surface') {
      expect(item.isStreaming).toBe(true);
      expect(item.surfaceId).toBe('sfc-stream');
    }
  });

  it('flips isStreaming to false on a completeSurface mutation', () => {
    const start = makeEvent('WorkflowTaskSurfaceUpdate', {
      workflowTaskSurfaceUpdate: {
        runId: RUN_ID,
        taskId: 'render-dashboard',
        stepExecutionId: WORKER_STEP_EXEC_ID,
        surfaceId: 'sfc-stream',
        surfaceMutations: [{ type: 'createSurface', surfaceId: 'sfc-stream' }],
        sequence: 1,
      },
    });
    const done = makeEvent('WorkflowTaskSurfaceUpdate', {
      workflowTaskSurfaceUpdate: {
        runId: RUN_ID,
        taskId: 'render-dashboard',
        stepExecutionId: WORKER_STEP_EXEC_ID,
        surfaceId: 'sfc-stream',
        surfaceMutations: [{ type: 'completeSurface' }],
        sequence: 2,
      },
    });
    const next = apply(initialRunViewState, start, done);
    const itemId = `workflow:${RUN_ID}:render-dashboard`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_surface');
    if (item?.kind === 'inline_surface') {
      expect(item.isStreaming).toBe(false);
    }
  });

  it('resets surface state across task retries (different stepExecutionId, PR #351 review fix)', () => {
    // Attempt 1: emits mutations up to sequence=47, then fails before
    // completeSurface. Inline item ends up with mutations + sequence=47.
    const attempt1Events = Array.from({ length: 3 }, (_, i) =>
      makeEvent('WorkflowTaskSurfaceUpdate', {
        workflowTaskSurfaceUpdate: {
          runId: RUN_ID,
          taskId: 'render-dashboard',
          stepExecutionId: WORKER_STEP_EXEC_ID, // attempt 1's worker step
          surfaceId: 'sfc-attempt-1',
          surfaceMutations: [{ type: 'updateComponents', batch: i + 1 }],
          sequence: 40 + i + 1, // 41, 42, 43
        },
      }),
    );
    const attempt2WorkerStep = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    // Attempt 2: retry. New stepExecutionId, sequence restarts at 1.
    // Without the retry fix, sequence=1 ≤ 43 would be dropped as stale
    // and the inline card would stay frozen at attempt-1 mutations.
    const attempt2Start = makeEvent('WorkflowTaskSurfaceUpdate', {
      workflowTaskSurfaceUpdate: {
        runId: RUN_ID,
        taskId: 'render-dashboard',
        stepExecutionId: attempt2WorkerStep,
        surfaceId: 'sfc-attempt-2',
        surfaceMutations: [{ type: 'createSurface', surfaceId: 'sfc-attempt-2' }],
        sequence: 1,
      },
    });
    const attempt2Next = makeEvent('WorkflowTaskSurfaceUpdate', {
      workflowTaskSurfaceUpdate: {
        runId: RUN_ID,
        taskId: 'render-dashboard',
        stepExecutionId: attempt2WorkerStep,
        surfaceId: 'sfc-attempt-2',
        surfaceMutations: [{ type: 'updateComponents', batch: 'retry' }],
        sequence: 2,
      },
    });
    const next = apply(initialRunViewState, ...attempt1Events, attempt2Start, attempt2Next);
    const itemId = `workflow:${RUN_ID}:render-dashboard`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_surface');
    if (item?.kind === 'inline_surface') {
      // Retry state replaces attempt-1 state — surfaceId, mutations,
      // and sequence cursor all reset to the new attempt's values.
      expect(item.surfaceId).toBe('sfc-attempt-2');
      expect(item.mutations).toHaveLength(2);
      expect(item.mutations[0]).toMatchObject({ type: 'createSurface' });
      expect(item.mutations[1]).toMatchObject({ type: 'updateComponents', batch: 'retry' });
      expect(item.lastSurfaceSequence).toBe(2);
      expect(item.lastSurfaceStepExecutionId).toBe(attempt2WorkerStep);
    }
  });
});

describe('Plan 158 §4.5.5 — session-scoped inline mount', () => {
  it('mounts an inline_artifact from a StepSucceeded with data.presentation', () => {
    const event = makeEvent(
      'StepSucceeded',
      {
        presentation: {
          mode: 'rendered_inline',
          substrate: 'artifact',
          payloadRef: 'inline:eyJodG1sIjoiPGh0bWwvPiJ9',
          artifactId: ARTIFACT_ID,
          versionId: VERSION_ID,
        },
      },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const next = apply(initialRunViewState, event);
    const itemId = `session:${STEP_EXEC_ID}`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_artifact');
    if (item?.kind === 'inline_artifact') {
      expect(item.artifactId).toBe(ARTIFACT_ID);
      expect(item.anchorStepExecutionId).toBe(STEP_EXEC_ID);
      // Session-scoped items omit workflowRunId.
      expect(item.workflowRunId).toBeUndefined();
    }
  });

  it('mounts an inline_surface from a StepSucceeded with data.presentation', () => {
    const event = makeEvent(
      'StepSucceeded',
      {
        presentation: {
          mode: 'rendered_inline',
          substrate: 'surface',
          surfaceId: 'sfc-helmsman-1',
        },
      },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const next = apply(initialRunViewState, event);
    const itemId = `session:${STEP_EXEC_ID}`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_surface');
    if (item?.kind === 'inline_surface') {
      expect(item.surfaceId).toBe('sfc-helmsman-1');
    }
  });

  it('does NOT mount when StepSucceeded has no presentation', () => {
    const event = makeEvent('StepSucceeded', {}, { stepExecutionId: STEP_EXEC_ID });
    const next = apply(initialRunViewState, event);
    expect(next.inlineItems).toEqual({});
  });

  it('hoists surface-{surfaceId} message mutations onto inline_surface mount (PR #351 review fix)', () => {
    // Simulate the canonical ad-hoc Helmsman flow:
    //   1. ui.surface.visualize streams SurfaceUpdate events
    //      (mutations accumulate into next.messages[surface-sfc-1])
    //   2. Step completes; StepSucceeded carries
    //      `presentation.rendered_inline + substrate: 'surface'`
    //   3. Reducer hoists the accumulated mutations onto the inline
    //      card and drops the now-redundant surface message.
    const streamingEvent = {
      eventId: crypto.randomUUID(),
      eventType: 'SurfaceUpdate',
      sessionId: SESSION_ID,
      timestamp: '2026-05-22T10:00:00.000Z',
      sequenceNumber: 0,
      eventVersion: 1,
      data: {},
      surfaceId: 'sfc-1',
      surfaceMutations: [
        { type: 'createSurface', surfaceId: 'sfc-1' },
        { type: 'updateComponents', components: { root1: { type: 'Page' } } },
      ],
    } as SessionEvent;
    const terminalEvent = makeEvent(
      'StepSucceeded',
      {
        presentation: {
          mode: 'rendered_inline',
          substrate: 'surface',
          surfaceId: 'sfc-1',
        },
      },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const next = apply(initialRunViewState, streamingEvent, terminalEvent);
    const itemId = `session:${STEP_EXEC_ID}`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_surface');
    if (item?.kind === 'inline_surface') {
      expect(item.mutations).toHaveLength(2);
      expect(item.mutations[0]).toMatchObject({ type: 'createSurface' });
      expect(item.mutations[1]).toMatchObject({ type: 'updateComponents' });
      expect(item.isStreaming).toBe(false);
    }
    // The surface- message must be dropped so the chat doesn't render
    // the surface twice (once as a bubble, once as an inline card).
    expect(next.messages.some((m) => m.id === 'surface-sfc-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const APPLET_INSTANCE_ID = '88888888-8888-8888-8888-888888888888';

function appletPresentation(instanceId: string = APPLET_INSTANCE_ID): Record<string, unknown> {
  return { mode: 'rendered_inline', substrate: 'applet', instanceId };
}

describe('applet inline mount', () => {
  it('mounts an inline_applet from a StepSucceeded with data.presentation (session path)', () => {
    const event = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const next = apply(initialRunViewState, event);
    const itemId = `session:${STEP_EXEC_ID}`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_applet');
    if (item?.kind === 'inline_applet') {
      expect(item.instanceId).toBe(APPLET_INSTANCE_ID);
      expect(item.anchorStepExecutionId).toBe(STEP_EXEC_ID);
      expect(item.workflowRunId).toBeUndefined();
    }
  });

  it('mounts an inline_applet from a WorkflowTaskUpdate with applet presentation (workflow path)', () => {
    const event = taskUpdateWithPresentation({
      taskId: 'start-board',
      presentation: appletPresentation(),
      stepExecutionId: WORKER_STEP_EXEC_ID,
    });
    const next = apply(initialRunViewState, event);
    const itemId = `workflow:${RUN_ID}:start-board`;
    const item = next.inlineItems[itemId];
    expect(item?.kind).toBe('inline_applet');
    if (item?.kind === 'inline_applet') {
      expect(item.instanceId).toBe(APPLET_INSTANCE_ID);
      expect(item.anchorStepExecutionId).toBe(WORKER_STEP_EXEC_ID);
      expect(item.workflowRunId).toBe(RUN_ID);
    }
  });

  it('a re-read moves the one card to the new anchor (session path)', () => {
    // The board is a single live object, not a message. An agent reading it is
    // the same object being used again — leaving a copy behind at every step
    // that touched it stacked 25 boards into one session, 24 of them read-only
    // renders of the same current state.
    const secondStep = '99999999-9999-9999-9999-999999999999';
    const instantiate = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const reRead = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: secondStep },
    );
    const next = apply(initialRunViewState, instantiate, reRead);
    const appletItems = Object.values(next.inlineItems).filter(
      (it): it is InlineAppletItem => it.kind === 'inline_applet',
    );
    expect(appletItems).toHaveLength(1);
    expect(next.inlineItems[`session:${STEP_EXEC_ID}`]).toBeUndefined();
    const moved = next.inlineItems[`session:${secondStep}`];
    expect(moved?.kind).toBe('inline_applet');
    if (moved?.kind === 'inline_applet') {
      expect(moved.anchorStepExecutionId).toBe(secondStep);
      expect(moved.instanceId).toBe(APPLET_INSTANCE_ID);
    }
  });

  it('a workflow re-read moves the same card to the task anchor', () => {
    const sessionMount = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const workflowReRead = taskUpdateWithPresentation({
      taskId: 'read-board',
      presentation: appletPresentation(),
      stepExecutionId: WORKER_STEP_EXEC_ID,
    });
    const next = apply(initialRunViewState, sessionMount, workflowReRead);
    const appletItems = Object.values(next.inlineItems).filter(
      (it): it is InlineAppletItem => it.kind === 'inline_applet',
    );
    expect(appletItems).toHaveLength(1);
    expect(next.inlineItems[`session:${STEP_EXEC_ID}`]).toBeUndefined();
    const workflowItem = next.inlineItems[`workflow:${RUN_ID}:read-board`];
    expect(workflowItem?.kind).toBe('inline_applet');
    if (workflowItem?.kind === 'inline_applet') {
      expect(workflowItem.anchorStepExecutionId).toBe(WORKER_STEP_EXEC_ID);
      expect(workflowItem.workflowRunId).toBe(RUN_ID);
    }
  });

  it('same-anchor re-delivery is a no-op — no duplicate mount, no freeze (session path)', () => {
    const event = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const redelivery = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const next = apply(initialRunViewState, event, redelivery);
    const appletItems = Object.values(next.inlineItems).filter(
      (it): it is InlineAppletItem => it.kind === 'inline_applet',
    );
    expect(appletItems).toHaveLength(1);
  });

  it('same-anchor re-delivery is a no-op — no duplicate mount, no freeze (workflow path)', () => {
    const event = taskUpdateWithPresentation({
      taskId: 'start-board',
      presentation: appletPresentation(),
      stepExecutionId: WORKER_STEP_EXEC_ID,
    });
    const redelivery = taskUpdateWithPresentation({
      taskId: 'start-board',
      presentation: appletPresentation(),
      stepExecutionId: WORKER_STEP_EXEC_ID,
    });
    const next = apply(initialRunViewState, event, redelivery);
    const appletItems = Object.values(next.inlineItems).filter(
      (it): it is InlineAppletItem => it.kind === 'inline_applet',
    );
    expect(appletItems).toHaveLength(1);
  });

  it('a replayed older anchor takes the card back, and still leaves one', () => {
    // Out-of-order redelivery must not be able to produce two boards. Where the
    // one card sits is a display question; how many there are is not.
    const secondStep = '99999999-9999-9999-9999-999999999999';
    const instantiate = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const reRead = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: secondStep },
    );
    const replayOriginal = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const next = apply(initialRunViewState, instantiate, reRead, replayOriginal);
    const appletItems = Object.values(next.inlineItems).filter(
      (it): it is InlineAppletItem => it.kind === 'inline_applet',
    );
    expect(appletItems).toHaveLength(1);
    expect(next.inlineItems[`session:${STEP_EXEC_ID}`]?.kind).toBe('inline_applet');
  });

  it('a different instanceId mounts its own card', () => {
    const otherInstance = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const secondStep = '99999999-9999-9999-9999-999999999999';
    const first = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation() },
      { stepExecutionId: STEP_EXEC_ID },
    );
    const second = makeEvent(
      'StepSucceeded',
      { presentation: appletPresentation(otherInstance) },
      { stepExecutionId: secondStep },
    );
    const next = apply(initialRunViewState, first, second);
    const appletItems = Object.values(next.inlineItems).filter((it) => it.kind === 'inline_applet');
    expect(appletItems).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('MARK_WORKFLOW_RUN_NEEDS_HYDRATION — chat stale-run repair', () => {
  it('a stale paused card re-hydrates to the terminal BFF state after a stale control error', () => {
    // 1. Live paused card (e.g. a subagent_handoff pause). The authoritative
    //    WorkflowRunUpdate cleared needsHydration; isFrozen is false because
    //    `paused` is non-terminal.
    const seeded = apply(initialRunViewState, runUpdateEvent({ status: 'paused' }));
    expect(seeded.workflowRuns[RUN_ID].status).toBe('paused');
    expect(seeded.workflowRuns[RUN_ID].needsHydration).toBe(false);

    // 2. The run actually cancelled out-of-band and the live tail missed the
    //    terminal WorkflowRunUpdate. A pause/resume/cancel click returns a stale
    //    404/409 → the chat mount dispatches MARK to force a repair.
    const marked = runViewReducer(seeded, {
      type: 'MARK_WORKFLOW_RUN_NEEDS_HYDRATION',
      runId: RUN_ID,
    });
    expect(marked.workflowRuns[RUN_ID].needsHydration).toBe(true);
    // MARK only flips the hydration flag — it must not invent a status.
    expect(marked.workflowRuns[RUN_ID].status).toBe('paused');

    // 3. The rehydration hook fetches the BFF detail (now cancelled) and
    //    dispatches HYDRATE_WORKFLOW_RUN. Because needsHydration was true the
    //    BFF snapshot is authoritative, so the card flips to the real terminal
    //    state instead of preserving the stale live `paused`.
    const hydrated = runViewReducer(marked, {
      type: 'HYDRATE_WORKFLOW_RUN',
      state: {
        runId: RUN_ID,
        slug: 'demo-workflow',
        status: 'cancelled',
        pauseVersion: 1,
        startedAt: '2026-05-12T10:00:00.000Z',
        completedAt: '2026-05-12T10:05:00.000Z',
        tasks: {},
        isFrozen: true,
        needsHydration: false,
      },
    });
    expect(hydrated.workflowRuns[RUN_ID].status).toBe('cancelled');
    expect(hydrated.workflowRuns[RUN_ID].isFrozen).toBe(true);
    expect(hydrated.workflowRuns[RUN_ID].needsHydration).toBe(false);
  });

  it('MARK is a no-op when the run is not in state', () => {
    const next = runViewReducer(initialRunViewState, {
      type: 'MARK_WORKFLOW_RUN_NEEDS_HYDRATION',
      runId: RUN_ID,
    });
    expect(next).toBe(initialRunViewState);
    expect(next.workflowRuns).toEqual({});
  });
});

// ---------------------------------------------------------------------------

describe('Plan 192 Phase 1 — user-message identity round-trip', () => {
  function optimisticUserMessage(state: RunViewState, id: string, content: string): RunViewState {
    return runViewReducer(state, {
      type: 'USER_MESSAGE',
      content,
      id,
      timestamp: '2026-06-10T10:00:00.000Z',
    });
  }

  it('SessionStarted with metadata.clientMessageId mints that id and dedups against the optimistic message', () => {
    const withOptimistic = optimisticUserMessage(initialRunViewState, 'client-msg-1', 'hello');
    const next = apply(
      withOptimistic,
      makeEvent(
        'SessionStarted',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-1' } },
      ),
    );
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].id).toBe('client-msg-1');
  });

  it('SessionStarted without clientMessageId falls back to user-<eventId>', () => {
    const started = makeEvent('SessionStarted', {}, { metadata: { userMessage: 'hello' } });
    const next = apply(initialRunViewState, started);
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].id).toBe(`user-${started.eventId}`);
  });

  it('same content sent twice with different clientMessageIds renders TWO messages', () => {
    // Pre-192 the fold deduped by content-string equality, eating the
    // second send of identical text. Identity is exact now.
    let state = optimisticUserMessage(initialRunViewState, 'client-msg-1', 'hello');
    state = apply(
      state,
      makeEvent(
        'SessionStarted',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-1' } },
      ),
    );
    state = optimisticUserMessage(state, 'client-msg-2', 'hello');
    state = apply(
      state,
      makeEvent(
        'SessionResumed',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-2' } },
      ),
    );
    const userMsgs = state.messages.filter((m) => m.role === 'user');
    expect(userMsgs.map((m) => m.id)).toEqual(['client-msg-1', 'client-msg-2']);
  });

  it('snapshot fold without the optimistic message mints both same-content sends', () => {
    // Reload path: no optimistic bubbles, two events with identical text
    // but distinct client ids must reconstruct two messages.
    const next = apply(
      initialRunViewState,
      makeEvent(
        'SessionStarted',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-1' } },
      ),
      makeEvent(
        'SessionResumed',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-2' } },
      ),
    );
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs.map((m) => m.id)).toEqual(['client-msg-1', 'client-msg-2']);
  });

  it('SessionResumed with a surface-action- clientMessageId dedups against the optimistic chip', () => {
    const chipId = 'surface-action-0f0e0d0c-aaaa-bbbb-cccc-444455556666';
    const withChip = optimisticUserMessage(initialRunViewState, chipId, 'Approve');
    const next = apply(
      withChip,
      makeEvent(
        'SessionResumed',
        {},
        {
          metadata: {
            userMessage: 'User clicked "Approve" (component: btn_approve)',
            clientMessageId: chipId,
          },
        },
      ),
    );
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].id).toBe(chipId);
    expect(userMsgs[0].content).toBe('Approve');
  });

  it('a surface-action chip no longer suppresses unrelated resume reconstructions', () => {
    // Pre-192 a content-blind hasSurfaceActionMsg check swallowed EVERY
    // later resume message while any chip existed in the transcript.
    const chipId = 'surface-action-0f0e0d0c-aaaa-bbbb-cccc-444455556666';
    const withChip = optimisticUserMessage(initialRunViewState, chipId, 'Approve');
    const resumed = makeEvent(
      'SessionResumed',
      {},
      { metadata: { userMessage: 'follow-up question', clientMessageId: 'client-msg-9' } },
    );
    const next = apply(withChip, resumed);
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs.map((m) => m.id)).toEqual([chipId, 'client-msg-9']);
  });
});

// ---------------------------------------------------------------------------

describe('Plan 192 Phase 2 — blockedOn lifecycle', () => {
  it('SessionPaused with explicit metadata.blockedOn (workflow-wait park) → workflow_run', () => {
    // The parked step ALSO carries a stepExecutionId — without the explicit
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: {
            pauseReason: 'input_required',
            pauseType: 'external_dependency',
            blockedOn: { kind: 'workflow_run', runId: RUN_ID },
          },
        },
      ),
    );
    expect(next.status).toBe('PAUSED');
    expect(next.blockedOn).toEqual({ kind: 'workflow_run', runId: RUN_ID });
    // requiredInput still carries the parked step for the resume plumbing.
    expect(next.requiredInput?.stepExecutionId).toBe(STEP_EXEC_ID);
  });

  it('SessionPaused with subflowWaiting → child_session + WAITING_ON_CHILD', () => {
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: { pauseType: 'subflow_waiting', subflowWaiting: true },
        },
      ),
    );
    expect(next.status).toBe('WAITING_ON_CHILD');
    expect(next.blockedOn).toEqual({ kind: 'child_session', sessionIds: [] });
  });

  it('plain SessionPaused with a stepExecutionId → user_input', () => {
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: { pauseReason: 'input_required', prompt: 'What next?' },
        },
      ),
    );
    expect(next.status).toBe('PAUSED');
    expect(next.blockedOn).toEqual({ kind: 'user_input', stepExecutionId: STEP_EXEC_ID });
  });

  it('interrupted SessionPaused → user_input', () => {
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: { pauseReason: 'interrupted', pauseType: 'interrupted' },
        },
      ),
    );
    expect(next.status).toBe('PAUSED');
    expect(next.blockedOn).toEqual({ kind: 'user_input', stepExecutionId: STEP_EXEC_ID });
  });

  it('SessionPaused without any stepExecutionId → blockedOn stays null', () => {
    // A pause carrying no step id offers the client nothing to resume through,
    // which is why the orchestrator must not emit one.
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent('SessionPaused', {}, { metadata: { pauseReason: 'something unresumable' } }),
    );
    expect(next.status).toBe('PAUSED');
    expect(next.blockedOn).toBeNull();
  });

  it('SessionResumed clears blockedOn', () => {
    const paused = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: { blockedOn: { kind: 'workflow_run', runId: RUN_ID } },
        },
      ),
    );
    expect(paused.blockedOn).not.toBeNull();
    const next = apply(paused, makeEvent('SessionResumed', {}));
    expect(next.status).toBe('RUNNING');
    expect(next.blockedOn).toBeNull();
  });

  it('SessionResumed routed to a child → child_session with the child id', () => {
    const childId = '99999999-9999-9999-9999-999999999999';
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent('SessionResumed', {}, { metadata: { routedToChildRun: childId } }),
    );
    expect(next.status).toBe('WAITING_ON_CHILD');
    expect(next.blockedOn).toEqual({ kind: 'child_session', sessionIds: [childId] });
  });

  it('SessionRetried clears blockedOn', () => {
    const paused = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent('SessionPaused', {}, { stepExecutionId: STEP_EXEC_ID, metadata: {} }),
    );
    expect(paused.blockedOn).not.toBeNull();
    const next = apply(paused, makeEvent('SessionRetried', {}));
    expect(next.blockedOn).toBeNull();
  });

  it('terminal events clear blockedOn', () => {
    for (const terminal of ['SessionSucceeded', 'SessionFailed', 'SessionCancelled']) {
      const paused = apply(
        initialRunViewState,
        makeEvent('SessionStarted', {}),
        makeEvent('SessionPaused', {}, { stepExecutionId: STEP_EXEC_ID, metadata: {} }),
      );
      const next = apply(paused, makeEvent(terminal, {}));
      expect(next.blockedOn).toBeNull();
    }
  });

  it('SessionStalled clears blockedOn (STALLED is gating-terminal)', () => {
    const paused = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent('SessionPaused', {}, { stepExecutionId: STEP_EXEC_ID, metadata: {} }),
    );
    expect(paused.blockedOn).not.toBeNull();
    const next = apply(paused, makeEvent('SessionStalled', {}));
    expect(next.status).toBe('STALLED');
    expect(next.blockedOn).toBeNull();
  });

  it('malformed metadata.blockedOn (workflow_run without runId) is rejected → derived user_input', () => {
    // Schema-validated read: a kind-only descriptor missing its payload must
    // not flow into state (pauseRun would POST to /workflow-runs/undefined).
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: { pauseReason: 'input_required', blockedOn: { kind: 'workflow_run' } },
        },
      ),
    );
    expect(next.status).toBe('PAUSED');
    expect(next.blockedOn).toEqual({ kind: 'user_input', stepExecutionId: STEP_EXEC_ID });
  });

  it('a write-approval pause reaches state as blockedOn, carrying no prompt', () => {
    // The chat's approval notice keys on exactly this: the pause has no prompt,
    // so the generic paused bubble skips it and `blockedOn` is the only signal
    // that the run is parked rather than hung.
    const blockedOn = {
      kind: 'needs_write_approval' as const,
      stepExecutionId: STEP_EXEC_ID,
      apiId: 'etoro-trading',
      endpointId: 'createOrder',
      method: 'POST',
      urlHost: 'public-api.etoro.com',
      writeRiskTier: 'high' as const,
      requestHash: 'abc123',
    };
    const next = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: { pauseReason: 'input_required', pauseType: 'approval', blockedOn },
        },
      ),
    );
    expect(next.status).toBe('PAUSED');
    expect(next.blockedOn).toEqual(blockedOn);
    expect(next.requiredInput?.prompt).toBeUndefined();
  });

  it('HYDRATE_SNAPSHOT carries blockedOn', () => {
    const snapshot: RunViewState = {
      ...initialRunViewState,
      status: 'PAUSED',
      blockedOn: { kind: 'workflow_run', runId: RUN_ID },
    };
    const next = runViewReducer(initialRunViewState, { type: 'HYDRATE_SNAPSHOT', snapshot });
    expect(next.blockedOn).toEqual({ kind: 'workflow_run', runId: RUN_ID });
  });

  it('LOCAL_RUN_STATE out of the parked states clears blockedOn; into PAUSED keeps it', () => {
    const paused = apply(
      initialRunViewState,
      makeEvent('SessionStarted', {}),
      makeEvent(
        'SessionPaused',
        {},
        {
          stepExecutionId: STEP_EXEC_ID,
          metadata: { blockedOn: { kind: 'user_input', stepExecutionId: STEP_EXEC_ID } },
        },
      ),
    );
    const stillPaused = runViewReducer(paused, { type: 'LOCAL_RUN_STATE', status: 'PAUSED' });
    expect(stillPaused.blockedOn).toEqual({ kind: 'user_input', stepExecutionId: STEP_EXEC_ID });
    const resumed = runViewReducer(paused, {
      type: 'LOCAL_RUN_STATE',
      status: 'RUNNING',
      requiredInput: null,
    });
    expect(resumed.blockedOn).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('Plan 192 Phase 4 — message delivery state', () => {
  const TS = '2026-06-10T10:00:00.000Z';

  function userMessage(
    state: RunViewState,
    id: string,
    deliveryState?: 'queued' | 'delivering',
  ): RunViewState {
    return runViewReducer(state, {
      type: 'USER_MESSAGE',
      content: 'hello',
      id,
      timestamp: TS,
      ...(deliveryState ? { deliveryState } : {}),
    });
  }

  it('USER_MESSAGE carries deliveryState when given; omits the field otherwise', () => {
    const queued = userMessage(initialRunViewState, 'm-1', 'queued');
    expect(queued.messages[0].deliveryState).toBe('queued');

    const plain = userMessage(initialRunViewState, 'm-2');
    expect('deliveryState' in plain.messages[0]).toBe(false);
  });

  it('SET_MESSAGE_DELIVERY transitions queued → delivering', () => {
    const queued = userMessage(initialRunViewState, 'm-1', 'queued');
    const next = runViewReducer(queued, {
      type: 'SET_MESSAGE_DELIVERY',
      id: 'm-1',
      deliveryState: 'delivering',
    });
    expect(next.messages[0].deliveryState).toBe('delivering');
    expect(next.messages[0].id).toBe('m-1');
    expect(next.messages[0].content).toBe('hello');
  });

  it('SET_MESSAGE_DELIVERY with null strips the field entirely', () => {
    const delivering = userMessage(initialRunViewState, 'm-1', 'delivering');
    const next = runViewReducer(delivering, {
      type: 'SET_MESSAGE_DELIVERY',
      id: 'm-1',
      deliveryState: null,
    });
    expect('deliveryState' in next.messages[0]).toBe(false);
  });

  it('SET_MESSAGE_DELIVERY is a no-op (same reference) for unknown id or unchanged value', () => {
    const queued = userMessage(initialRunViewState, 'm-1', 'queued');
    expect(
      runViewReducer(queued, { type: 'SET_MESSAGE_DELIVERY', id: 'absent', deliveryState: null }),
    ).toBe(queued);
    expect(
      runViewReducer(queued, { type: 'SET_MESSAGE_DELIVERY', id: 'm-1', deliveryState: 'queued' }),
    ).toBe(queued);
  });

  it('REMOVE_MESSAGE removes the bubble; no-op for unknown id', () => {
    const queued = userMessage(initialRunViewState, 'm-1', 'queued');
    const next = runViewReducer(queued, { type: 'REMOVE_MESSAGE', id: 'm-1' });
    expect(next.messages).toHaveLength(0);
    expect(runViewReducer(queued, { type: 'REMOVE_MESSAGE', id: 'absent' })).toBe(queued);
  });

  it('SessionStarted echo strips deliveryState in place (same id, same slot, no duplicate)', () => {
    let state = userMessage(initialRunViewState, 'client-msg-1', 'delivering');
    state = runViewReducer(state, {
      type: 'USER_MESSAGE',
      content: 'later bubble',
      id: 'client-msg-2',
      timestamp: TS,
    });
    const next = apply(
      state,
      makeEvent(
        'SessionStarted',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-1' } },
      ),
    );
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0].id).toBe('client-msg-1');
    expect('deliveryState' in next.messages[0]).toBe(false);
    expect(next.messages[0].content).toBe('hello');
  });

  it('SessionResumed echo strips a queued deliveryState in place', () => {
    const state = userMessage(initialRunViewState, 'client-msg-1', 'queued');
    const next = apply(
      state,
      makeEvent(
        'SessionResumed',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-1' } },
      ),
    );
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].id).toBe('client-msg-1');
    expect('deliveryState' in userMsgs[0]).toBe(false);
  });

  it('echo without an optimistic bubble reconstructs a plain delivered message', () => {
    // Server-fold direction (snapshot/reload): the fold never sets
    // deliveryState, so reconstructions are inherently "delivered".
    const next = apply(
      initialRunViewState,
      makeEvent(
        'SessionResumed',
        {},
        { metadata: { userMessage: 'hello', clientMessageId: 'client-msg-1' } },
      ),
    );
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect('deliveryState' in userMsgs[0]).toBe(false);
  });
});
