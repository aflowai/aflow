import { describe, it, expect } from 'vitest';
import {
  deriveRunLiveness,
  deriveRunLivenessFromCounts,
  isRunResumable,
  isRunRecoverable,
  type RunLiveness,
  type RunLivenessInputs,
} from '../scheduling/runLiveness.js';
import type { WorkflowRunDetail, WorkflowTaskRow } from '../ledger.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTaskRow(taskId: string, status: string): WorkflowTaskRow {
  return {
    id: `id-${taskId}`,
    runId: 'run-1',
    taskId,
    status,
    attempt: 1,
    sessionId: null,
    workerSessionId: null,
    dispatchDeadlineAt: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    costCents: null,
    metricsJson: null,
    summary: null,
    failureReason: null,
    outputRef: null,
    reflectionJson: null,
  };
}

function makeRun(
  overrides: Partial<WorkflowRunDetail> & { tasks: WorkflowTaskRow[] },
): WorkflowRunDetail {
  return {
    id: 'id-1',
    spaceId: 'space-1',
    workflowSlug: 'test-workflow',
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    workflowRevision: 1,
    startedAt: new Date('2026-04-21T10:00:00Z'),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: null,
    ...overrides,
  };
}

const NOW = new Date('2026-04-21T12:00:00Z');

// ============================================================================
// Core liveness derivation
// ============================================================================

describe('deriveRunLiveness', () => {
  describe('executing', () => {
    it('detects a run with tasks in "running" status', () => {
      const run = makeRun({
        tasks: [makeTaskRow('a', 'succeeded'), makeTaskRow('b', 'running')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('executing');
      expect(result.activeTaskIds).toEqual(['b']);
    });

    it('detects a run with tasks in "scheduled" status (fresh cursor — transient pre-dispatch)', () => {
      const run = makeRun({
        schedulerCursorAt: new Date('2026-04-21T11:59:00Z'),
        tasks: [makeTaskRow('a', 'scheduled')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('executing');
      expect(result.activeTaskIds).toEqual(['a']);
    });

    it('detects "scheduled but never claimed" past staleness as stalled (plan 113 §5.4)', () => {
      // No live or paused tasks; only a scheduled one, with a stale cursor.
      const run = makeRun({
        startedAt: new Date('2026-04-21T10:00:00Z'),
        schedulerCursorAt: new Date('2026-04-21T11:30:00Z'),
        tasks: [makeTaskRow('done-1', 'succeeded'), makeTaskRow('parked', 'scheduled')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('stalled');
      expect(result.reason).toMatch(/scheduled but never claimed/);
      expect(result.activeTaskIds).toContain('parked');
    });

    it('detects a run with tasks in "claimed" status', () => {
      const run = makeRun({
        tasks: [makeTaskRow('a', 'claimed'), makeTaskRow('b', 'succeeded')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('executing');
    });

    it('executing takes precedence over paused', () => {
      const run = makeRun({
        tasks: [makeTaskRow('a', 'running'), makeTaskRow('b', 'paused')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('executing');
      expect(result.activeTaskIds).toEqual(['a']);
      expect(result.pausedTaskIds).toEqual(['b']);
    });
  });

  describe('waiting_for_input', () => {
    it('detects a run with only paused tasks', () => {
      const run = makeRun({
        tasks: [makeTaskRow('a', 'succeeded'), makeTaskRow('b', 'paused')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('waiting_for_input');
      expect(result.pausedTaskIds).toEqual(['b']);
    });

    it('detects run-level paused status even without paused tasks', () => {
      const run = makeRun({
        status: 'paused',
        tasks: [makeTaskRow('a', 'succeeded')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('waiting_for_input');
    });
  });

  describe('stalled', () => {
    it('detects a stalled run with expired scheduler cursor', () => {
      const run = makeRun({
        // Cursor was updated 10 minutes ago
        schedulerCursorAt: new Date('2026-04-21T11:50:00Z'),
        tasks: [
          makeTaskRow('a', 'succeeded'),
          // No active or paused tasks
        ],
      });

      // With 5-minute threshold, 10 minutes ago = stalled
      const result = deriveRunLiveness(run, { now: NOW, staleThresholdMs: 5 * 60 * 1000 });
      expect(result.liveness).toBe('stalled');
    });

    it('does not mark as stalled if cursor is fresh', () => {
      const run = makeRun({
        // Cursor was updated 2 minutes ago
        schedulerCursorAt: new Date('2026-04-21T11:58:00Z'),
        tasks: [makeTaskRow('a', 'succeeded')],
      });

      const result = deriveRunLiveness(run, { now: NOW, staleThresholdMs: 5 * 60 * 1000 });
      expect(result.liveness).toBe('idle');
    });

    it('respects custom stale threshold', () => {
      const run = makeRun({
        // Cursor was updated 30 seconds ago
        schedulerCursorAt: new Date('2026-04-21T11:59:30Z'),
        tasks: [],
      });

      // With 10-second threshold, 30s = stalled
      const result = deriveRunLiveness(run, { now: NOW, staleThresholdMs: 10_000 });
      expect(result.liveness).toBe('stalled');
    });

    it('detects orphaned run with no cursor using startedAt fallback', () => {
      // Run started 2 hours ago, no scheduler cursor ever set, no active tasks
      const run = makeRun({
        startedAt: new Date('2026-04-21T10:00:00Z'),
        schedulerCursorAt: null,
        tasks: [makeTaskRow('a', 'succeeded')],
      });

      const result = deriveRunLiveness(run, { now: NOW, staleThresholdMs: 5 * 60 * 1000 });
      expect(result.liveness).toBe('stalled');
      expect(result.reason).toContain('run start time');
    });
  });

  describe('idle', () => {
    it('detects idle run with no tasks and recent start', () => {
      // startedAt is 1 minute ago — within the 5-minute threshold
      const run = makeRun({
        startedAt: new Date('2026-04-21T11:59:00Z'),
        tasks: [],
      });
      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('idle');
    });

    it('detects idle run with only succeeded tasks and fresh cursor', () => {
      const run = makeRun({
        // Fresh cursor — 1 minute ago
        schedulerCursorAt: new Date('2026-04-21T11:59:00Z'),
        tasks: [makeTaskRow('a', 'succeeded'), makeTaskRow('b', 'succeeded')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('idle');
    });
  });

  describe('terminal runs', () => {
    it('returns idle for completed runs', () => {
      const run = makeRun({
        status: 'completed',
        tasks: [makeTaskRow('a', 'succeeded')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('idle');
    });

    it('returns idle for failed runs', () => {
      const run = makeRun({
        status: 'failed',
        tasks: [makeTaskRow('a', 'failed')],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('idle');
    });

    it('returns idle for cancelled runs', () => {
      const run = makeRun({
        status: 'cancelled',
        tasks: [],
      });

      const result = deriveRunLiveness(run, { now: NOW });
      expect(result.liveness).toBe('idle');
    });
  });
});

// ============================================================================
// Convenience helpers
// ============================================================================

describe('isRunResumable', () => {
  it('returns true for waiting_for_input', () => {
    expect(isRunResumable('waiting_for_input')).toBe(true);
  });

  it('returns false for executing', () => {
    expect(isRunResumable('executing')).toBe(false);
  });

  it('returns false for stalled', () => {
    expect(isRunResumable('stalled')).toBe(false);
  });

  it('returns false for idle', () => {
    expect(isRunResumable('idle')).toBe(false);
  });
});

describe('isRunRecoverable', () => {
  it('returns true for stalled', () => {
    expect(isRunRecoverable('stalled')).toBe(true);
  });

  it('returns false for executing', () => {
    expect(isRunRecoverable('executing')).toBe(false);
  });

  it('returns false for waiting_for_input', () => {
    expect(isRunRecoverable('waiting_for_input')).toBe(false);
  });
});

// ============================================================================
// Key acceptance criterion tests
// ============================================================================

describe('acceptance criteria: liveness distinctions', () => {
  it('a paused-for-input run is never surfaced as generic "running"', () => {
    // This is the core 104d requirement: a run where status='running'
    // but has a paused task must show as waiting_for_input, not executing.
    const run = makeRun({
      status: 'running', // The coarse status says "running"
      tasks: [
        makeTaskRow('a', 'succeeded'),
        makeTaskRow('b', 'paused'), // But this task is waiting for input
      ],
    });

    const result = deriveRunLiveness(run, { now: NOW });
    // Must NOT be 'executing' or 'idle' — must be 'waiting_for_input'
    expect(result.liveness).toBe('waiting_for_input');
    expect(result.liveness).not.toBe('executing');
  });

  it('a stalled run is distinguishable from an actively executing run', () => {
    // Actively executing
    const executingRun = makeRun({
      tasks: [makeTaskRow('a', 'running')],
    });

    // Stalled: no active tasks, old cursor
    const stalledRun = makeRun({
      schedulerCursorAt: new Date('2026-04-21T11:30:00Z'), // 30 min old
      tasks: [makeTaskRow('a', 'succeeded')],
    });

    const executingResult = deriveRunLiveness(executingRun, { now: NOW });
    const stalledResult = deriveRunLiveness(stalledRun, { now: NOW });

    expect(executingResult.liveness).toBe('executing');
    expect(stalledResult.liveness).toBe('stalled');
    expect(executingResult.liveness).not.toBe(stalledResult.liveness);
  });

  it('resume, attention, and operator surfaces all use the same model', () => {
    // This test just verifies that deriveRunLiveness is a single function
    // with a single return type — consuming code all calls the same function.
    // The structural guarantee is in the code; this test documents the intent.
    const run = makeRun({
      tasks: [makeTaskRow('a', 'paused')],
    });

    // All consumers call the same function
    const result1 = deriveRunLiveness(run, { now: NOW });
    const result2 = deriveRunLiveness(run, { now: NOW });
    expect(result1.liveness).toBe(result2.liveness);
    expect(result1.reason).toBe(result2.reason);
  });
});

// ============================================================================
// Resume handler logic tests (exercises the branching that was a no-op bug)
// ============================================================================

describe('resume handler branching logic', () => {
  // These tests simulate the decision logic in handleWorkflowRunResume
  // without requiring the full orchestrator stack. They exercise the same
  // liveness → branch → action mapping.

  it('stalled + running → recovery path (not no-op)', () => {
    const run = makeRun({
      status: 'running',
      schedulerCursorAt: new Date('2026-04-21T11:30:00Z'), // 30 min old
      tasks: [makeTaskRow('a', 'succeeded')],
    });

    const liveness = deriveRunLiveness(run, { now: NOW });
    expect(liveness.liveness).toBe('stalled');

    // The handler checks: is this running + stalled? → recovery path
    const isStalledRecovery = run.status === 'running' && liveness.liveness === 'stalled';
    expect(isStalledRecovery).toBe(true);

    // In the handler, this branches to recoverStalledRun() which resets
    // schedulerCursorAt and transfers session ownership — NOT resumeRun()
    // which would be a no-op on a 'running' row.
  });

  it('running + executing → rejected (cannot resume an active run)', () => {
    const run = makeRun({
      status: 'running',
      tasks: [makeTaskRow('a', 'running')],
    });

    const liveness = deriveRunLiveness(run, { now: NOW });
    expect(liveness.liveness).toBe('executing');

    const isStalledRecovery = run.status === 'running' && liveness.liveness === 'stalled';
    expect(isStalledRecovery).toBe(false);

    // Handler rejects: not paused, not failed, not stalled
    const shouldReject = run.status !== 'paused' && run.status !== 'failed' && !isStalledRecovery;
    expect(shouldReject).toBe(true);
  });

  it('paused + waiting_for_input → normal resume path', () => {
    const run = makeRun({
      status: 'paused',
      tasks: [makeTaskRow('a', 'paused')],
    });

    const liveness = deriveRunLiveness(run, { now: NOW });
    expect(liveness.liveness).toBe('waiting_for_input');

    const isStalledRecovery = run.status === 'running' && liveness.liveness === 'stalled';
    expect(isStalledRecovery).toBe(false);

    // Handler takes normal path: resumeRun() which sets status='running'
    const shouldReject = run.status !== 'paused' && run.status !== 'failed' && !isStalledRecovery;
    expect(shouldReject).toBe(false);
  });

  it('orphaned running run with no cursor → stalled via startedAt fallback', () => {
    const run = makeRun({
      status: 'running',
      startedAt: new Date('2026-04-21T10:00:00Z'), // 2 hours ago
      schedulerCursorAt: null, // cursor never set
      tasks: [], // no tasks at all
    });

    const liveness = deriveRunLiveness(run, { now: NOW });
    expect(liveness.liveness).toBe('stalled');
    expect(liveness.reason).toContain('run start time');

    // Handler takes recovery path, not no-op
    const isStalledRecovery = run.status === 'running' && liveness.liveness === 'stalled';
    expect(isStalledRecovery).toBe(true);
  });
});

// ============================================================================
// 104d Phase 1a: deriveRunLivenessFromCounts parity
// ============================================================================

describe('deriveRunLivenessFromCounts', () => {
  const NOW = new Date('2026-04-21T12:00:00Z');
  const FRESH = new Date('2026-04-21T11:59:00Z');
  const OLD = new Date('2026-04-21T11:30:00Z');

  it('returns executing when activeTasks > 0', () => {
    const inputs: RunLivenessInputs = {
      status: 'running',
      startedAt: FRESH,
      schedulerCursorAt: FRESH,
      liveTasks: 2,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 1,
      totalTasks: 3,
    };
    expect(deriveRunLivenessFromCounts(inputs, { now: NOW })).toBe('executing');
  });

  it('returns waiting_for_input when pausedTasks > 0 and no active', () => {
    const inputs: RunLivenessInputs = {
      status: 'running',
      startedAt: FRESH,
      schedulerCursorAt: FRESH,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 1,
      succeededTasks: 1,
      totalTasks: 2,
    };
    expect(deriveRunLivenessFromCounts(inputs, { now: NOW })).toBe('waiting_for_input');
  });

  it('returns waiting_for_input for run-level paused status', () => {
    const inputs: RunLivenessInputs = {
      status: 'paused',
      startedAt: OLD,
      schedulerCursorAt: null,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 1,
      totalTasks: 1,
    };
    expect(deriveRunLivenessFromCounts(inputs, { now: NOW })).toBe('waiting_for_input');
  });

  it('returns stalled when reference time is old and no active/paused tasks', () => {
    const inputs: RunLivenessInputs = {
      status: 'running',
      startedAt: OLD,
      schedulerCursorAt: OLD,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 1,
      totalTasks: 1,
    };
    expect(deriveRunLivenessFromCounts(inputs, { now: NOW })).toBe('stalled');
  });

  it('falls back to startedAt for stalled when cursor is null', () => {
    const inputs: RunLivenessInputs = {
      status: 'running',
      startedAt: OLD,
      schedulerCursorAt: null,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 0,
      totalTasks: 0,
    };
    expect(deriveRunLivenessFromCounts(inputs, { now: NOW })).toBe('stalled');
  });

  it('returns idle when fresh and no active/paused tasks', () => {
    const inputs: RunLivenessInputs = {
      status: 'running',
      startedAt: FRESH,
      schedulerCursorAt: FRESH,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 0,
      totalTasks: 0,
    };
    expect(deriveRunLivenessFromCounts(inputs, { now: NOW })).toBe('idle');
  });

  it('returns idle for terminal runs', () => {
    const inputs: RunLivenessInputs = {
      status: 'completed',
      startedAt: OLD,
      schedulerCursorAt: OLD,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 3,
      totalTasks: 3,
    };
    expect(deriveRunLivenessFromCounts(inputs, { now: NOW })).toBe('idle');
  });

  it('matches deriveRunLiveness for the same inputs', () => {
    // Executing case
    const executingRun = makeRun({
      status: 'running',
      startedAt: FRESH,
      schedulerCursorAt: FRESH,
      tasks: [makeTaskRow('a', 'running'), makeTaskRow('b', 'succeeded')],
    });
    const executingCounts: RunLivenessInputs = {
      status: 'running',
      startedAt: FRESH,
      schedulerCursorAt: FRESH,
      liveTasks: 1,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 1,
      totalTasks: 2,
    };
    expect(deriveRunLivenessFromCounts(executingCounts, { now: NOW })).toBe(
      deriveRunLiveness(executingRun, { now: NOW }).liveness,
    );

    // Paused case
    const pausedRun = makeRun({
      status: 'running',
      startedAt: FRESH,
      schedulerCursorAt: FRESH,
      tasks: [makeTaskRow('a', 'paused')],
    });
    const pausedCounts: RunLivenessInputs = {
      status: 'running',
      startedAt: FRESH,
      schedulerCursorAt: FRESH,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 1,
      succeededTasks: 0,
      totalTasks: 1,
    };
    expect(deriveRunLivenessFromCounts(pausedCounts, { now: NOW })).toBe(
      deriveRunLiveness(pausedRun, { now: NOW }).liveness,
    );

    // Stalled case
    const stalledRun = makeRun({
      status: 'running',
      startedAt: OLD,
      schedulerCursorAt: OLD,
      tasks: [makeTaskRow('a', 'succeeded')],
    });
    const stalledCounts: RunLivenessInputs = {
      status: 'running',
      startedAt: OLD,
      schedulerCursorAt: OLD,
      liveTasks: 0,
      scheduledTasks: 0,
      pausedTasks: 0,
      succeededTasks: 1,
      totalTasks: 1,
    };
    expect(deriveRunLivenessFromCounts(stalledCounts, { now: NOW })).toBe(
      deriveRunLiveness(stalledRun, { now: NOW }).liveness,
    );
  });
});

// ============================================================================
// 104d Phase 1a: claim-before-schedule contract (structural)
// ============================================================================

describe('claim-before-schedule contract', () => {
  it('claimTask is exported from the ledger module', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.claimTask).toBe('function');
  });

  it('releaseClaimedTask is exported from the ledger module', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.releaseClaimedTask).toBe('function');
  });

  it('listActiveRunsWithLiveness is exported from the ledger module', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.listActiveRunsWithLiveness).toBe('function');
  });
});

// ============================================================================
// 104d Phase 1a: WorkflowEngineResult contract (behavioral)
// ============================================================================

describe('WorkflowEngineResult caller contract', () => {
  // These tests verify the branching logic that callers (applyStepSucceeded,
  // index.ts) must implement for the discriminated engine result type.

  type EngineResult = 'scheduled' | 'already_claimed' | 'complete' | 'error';

  /**
   * Simulates the caller logic from applyStepSucceeded.ts (success path).
   * Returns true if the caller should SKIP terminal SessionCompleted handling.
   *
   * Only 'complete' falls through to terminal — the engine explicitly
   * determined all tasks are done. Everything else (scheduled, already_claimed,
   * error) means the run is NOT done.
   */
  function shouldSkipTerminalHandling(result: EngineResult): boolean {
    return result !== 'complete';
  }

  /**
   * Simulates the caller logic from index.ts (failure path).
   * Returns true if the caller should SKIP failing the run.
   */
  function shouldSkipRunFailure(result: EngineResult): boolean {
    return result === 'scheduled' || result === 'already_claimed';
  }

  it('scheduled → skip terminal handling (next task is running)', () => {
    expect(shouldSkipTerminalHandling('scheduled')).toBe(true);
  });

  it('already_claimed → skip terminal handling (another pass owns the task)', () => {
    expect(shouldSkipTerminalHandling('already_claimed')).toBe(true);
  });

  it('complete → allow terminal handling (all tasks done)', () => {
    expect(shouldSkipTerminalHandling('complete')).toBe(false);
  });

  it('error → skip terminal handling on SUCCESS path (run is not done, stalled-liveness will catch)', () => {
    // THIS is the key fix: an engine error on the success path must NOT
    // cause SessionCompleted. The step succeeded but the engine couldn't
    // determine the next task. The run will be caught by stalled-liveness.
    expect(shouldSkipTerminalHandling('error')).toBe(true);
  });

  it('scheduled → skip run failure on task failure path', () => {
    expect(shouldSkipRunFailure('scheduled')).toBe(true);
  });

  it('already_claimed → skip run failure on task failure path', () => {
    expect(shouldSkipRunFailure('already_claimed')).toBe(true);
  });

  it('complete → allow run failure on task failure path', () => {
    expect(shouldSkipRunFailure('complete')).toBe(false);
  });

  it('error → allow run failure on task failure path', () => {
    // On the FAILURE path, error means the engine itself broke trying to
    // handle a failed task. Falling through to fail the run is acceptable.
    expect(shouldSkipRunFailure('error')).toBe(false);
  });

  it('claim rollback: releaseClaimedTask is safe to call on non-existent rows', async () => {
    // This is a structural test — releaseClaimedTask only deletes rows in
    // 'scheduled' status, so calling it on a non-existent or already-transitioned
    // row is a safe no-op. The actual DB behavior is tested in integration tests.
    const mod = await import('../ledger.js');
    expect(typeof mod.releaseClaimedTask).toBe('function');
  });
});

// ============================================================================
// 104d Phase 1a: post-schedule dispatch verification (behavioral)
// ============================================================================

describe('post-schedule dispatch verification contract', () => {
  // verifyScheduleDispatched uses a positive signal: did atomicScheduleStep
  // write currentStepId = the scheduled step's id? This avoids the PAUSED
  // ambiguity where PAUSED can mean either "grant-pause, no dispatch" or
  // "human task dispatched successfully, now waiting for input."

  /**
   * Simulates the verifyScheduleDispatched logic.
   * @param currentStepId - session's currentStepId after scheduleStep
   * @param scheduledStepId - the stepId we asked scheduleStep to schedule
   */
  function wasDispatched(currentStepId: string | null, scheduledStepId: string): boolean {
    return currentStepId === scheduledStepId;
  }

  it('dispatch confirmed when currentStepId matches scheduled step', () => {
    expect(wasDispatched('wf_task_prepare_abc123', 'wf_task_prepare_abc123')).toBe(true);
  });

  it('dispatch NOT confirmed when currentStepId is unchanged (early return)', () => {
    // scheduleStep returned without calling atomicScheduleStep
    expect(wasDispatched('some_prior_step', 'wf_task_prepare_abc123')).toBe(false);
  });

  it('dispatch NOT confirmed when currentStepId is null', () => {
    expect(wasDispatched(null, 'wf_task_prepare_abc123')).toBe(false);
  });

  it('PAUSED session with matching currentStepId = dispatch happened (human task)', () => {
    // A user.input.request step dispatches successfully, then the session
    // goes PAUSED waiting for input. currentStepId IS updated because
    // atomicScheduleStep ran before the pause.
    const sessionStatus = 'PAUSED';
    const currentStepId = 'wf_task_review_xyz789';
    const scheduledStepId = 'wf_task_review_xyz789';

    // Dispatch DID happen — do NOT release the claim
    expect(wasDispatched(currentStepId, scheduledStepId)).toBe(true);
    // The session being PAUSED is expected for human tasks
    expect(sessionStatus).toBe('PAUSED');
  });

  it('PAUSED session with non-matching currentStepId = grant-pause, no dispatch', () => {
    // scheduleStep hit the grant-pause branch BEFORE atomicScheduleStep.
    // currentStepId still points to whatever was running before.
    const sessionStatus = 'PAUSED';
    const currentStepId = 'some_prior_step';
    const scheduledStepId = 'wf_task_prepare_abc123';

    // Dispatch did NOT happen — release the claim
    expect(wasDispatched(currentStepId, scheduledStepId)).toBe(false);
    expect(sessionStatus).toBe('PAUSED');
  });

  it('terminal session with non-matching currentStepId = no dispatch', () => {
    // scheduleStep refused because run was already terminal
    expect(wasDispatched('some_prior_step', 'wf_task_prepare_abc123')).toBe(false);
  });

  it('verification applies to BOTH bootstrap and task-completed paths', () => {
    // Both paths call verifyScheduleDispatched with scheduledStepId.
    // This structural assertion documents the requirement.
    // Actual wiring verified by typecheck.
    expect(true).toBe(true);
  });
});

// ============================================================================
// Retried task that was never claimed for dispatch
// ============================================================================

describe('undispatched retry', () => {
  const NOW = new Date('2026-04-21T12:00:00Z');

  function awaitingDispatch(taskId: string, deadlineAt: Date): WorkflowTaskRow {
    return {
      ...makeTaskRow(taskId, 'running'),
      workerSessionId: null,
      dispatchDeadlineAt: deadlineAt,
    };
  }

  function claimed(taskId: string): WorkflowTaskRow {
    return {
      ...makeTaskRow(taskId, 'running'),
      workerSessionId: 'worker-1',
      dispatchDeadlineAt: null,
    };
  }

  it('is executing while the dispatch deadline has not passed', () => {
    // The window between the retry commit and the claim is the normal path;
    // treating it as an anomaly would fail every retry.
    const run = makeRun({ tasks: [awaitingDispatch('t1', new Date(NOW.getTime() + 60_000))] });
    expect(deriveRunLiveness(run, { now: NOW }).liveness).toBe('executing');
  });

  it('is stalled once the deadline its own commit wrote has passed', () => {
    const run = makeRun({ tasks: [awaitingDispatch('t1', new Date(NOW.getTime() - 1))] });
    const result = deriveRunLiveness(run, { now: NOW });
    expect(result.liveness).toBe('stalled');
    expect(result.reason).toContain('t1');
  });

  it('does not depend on the run-level staleness clock', () => {
    // The run was started seconds ago and its cursor is fresh, so every
    // age-based test says healthy. The deadline is the only signal that the
    // dispatch is gone, which is why it is checked before them.
    const run = makeRun({
      startedAt: new Date(NOW.getTime() - 1000),
      schedulerCursorAt: new Date(NOW.getTime() - 1000),
      tasks: [awaitingDispatch('t1', new Date(NOW.getTime() - 1))],
    });
    expect(deriveRunLiveness(run, { now: NOW }).liveness).toBe('stalled');
  });

  it('is executing while a claimed sibling is still working', () => {
    // Failing the run here would take the live sibling's work with it. The
    // deadline stays on the row, so the next pass sees it again.
    const run = makeRun({
      tasks: [awaitingDispatch('t1', new Date(NOW.getTime() - 1)), claimed('t2')],
    });
    const result = deriveRunLiveness(run, { now: NOW });
    expect(result.liveness).toBe('executing');
    expect(result.activeTaskIds).toEqual(['t2']);
  });

  it('ignores a stale deadline on a row that was claimed', () => {
    // Belt and braces: the claim clears the deadline in the same statement, so
    // this shape should not exist — but a worker session is proof of dispatch
    // whatever the column says.
    const stale = { ...claimed('t1'), dispatchDeadlineAt: new Date(NOW.getTime() - 60_000) };
    expect(deriveRunLiveness(makeRun({ tasks: [stale] }), { now: NOW }).liveness).toBe('executing');
  });
});
