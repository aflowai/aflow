import { describe, expect, it } from 'vitest';
import { deriveRunControlVisibility } from './workflowRunSurfaceHelpers.js';
import type { SpaceRole } from './workflowRunSurfaceHelpers.js';
import type { WorkflowSurfaceRunStatus, WorkflowSurfaceTaskState } from '../../lib/types.js';

type TaskInput = Record<string, Pick<WorkflowSurfaceTaskState, 'status' | 'humanIntent'>>;

function vis(opts: {
  status: WorkflowSurfaceRunStatus;
  effectiveStatus?: WorkflowSurfaceRunStatus;
  pausedReason?: string;
  isFrozen?: boolean;
  tasks?: TaskInput;
  role?: SpaceRole;
}) {
  return deriveRunControlVisibility({
    status: opts.status,
    effectiveStatus: opts.effectiveStatus ?? opts.status,
    // Default to the operator `manual` cause so the resume-affordance tests
    // exercise the acknowledge path unless a test overrides the cause.
    pausedReason: 'pausedReason' in opts ? opts.pausedReason : 'manual',
    isFrozen: opts.isFrozen ?? false,
    tasks: opts.tasks ?? {},
    // `null` is a valid role (no access) — only fall back to editor when unset.
    role: opts.role === undefined ? 'editor' : opts.role,
  });
}

describe('deriveRunControlVisibility', () => {
  it('running run → Pause + Cancel, no Resume', () => {
    const v = vis({ status: 'running', tasks: { t1: { status: 'running' } } });
    expect(v.showPause).toBe(true);
    expect(v.showCancel).toBe(true);
    expect(v.showRunLevelResume).toBe(false);
    expect(v.pausing).toBe(false);
  });

  it('run-level paused (no human task) → Resume + Cancel, no Pause', () => {
    const v = vis({ status: 'paused', tasks: { t1: { status: 'succeeded' } } });
    expect(v.showPause).toBe(false);
    expect(v.showRunLevelResume).toBe(true);
    expect(v.showCancel).toBe(true);
  });

  it('paused for a pending human task → run-level Resume suppressed (per-row owns it)', () => {
    const v = vis({
      status: 'paused',
      tasks: { t1: { status: 'paused', humanIntent: 'approve' } },
    });
    expect(v.showRunLevelResume).toBe(false);
    expect(v.showCancel).toBe(true); // cancel is still available
  });

  it.each(['subagent_handoff', 'needs_credentials', 'task_contract_violation', 'transient_error'])(
    'paused for a non-manual cause (%s) → no run-level acknowledge Resume, Cancel still available',
    (cause) => {
      // The acknowledge Resume button only fits the operator `manual` pause;
      // other causes have contract-specific modes the surface state can't drive.
      const v = vis({
        status: 'paused',
        pausedReason: cause,
        tasks: { t1: { status: 'succeeded' } },
      });
      expect(v.showRunLevelResume).toBe(false);
      expect(v.showCancel).toBe(true);
    },
  );

  it('"Pausing…" window: status paused but a task is still running → Resume shown + pausing flag', () => {
    const v = vis({
      status: 'paused',
      tasks: { t1: { status: 'running' }, t2: { status: 'succeeded' } },
    });
    expect(v.pausing).toBe(true);
    expect(v.showRunLevelResume).toBe(true);
  });

  it('frozen / historical snapshot → no write controls even while paused', () => {
    const v = vis({ status: 'paused', isFrozen: true });
    expect(v.canManage).toBe(false);
    expect(v.showPause).toBe(false);
    expect(v.showRunLevelResume).toBe(false);
    expect(v.showCancel).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'terminal run (%s) → nothing manageable',
    (status) => {
      const v = vis({ status, effectiveStatus: status });
      expect(v.canManage).toBe(false);
      expect(v.showPause).toBe(false);
      expect(v.showCancel).toBe(false);
    },
  );

  it('viewer role → no write controls on a running run', () => {
    const v = vis({ status: 'running', role: 'viewer', tasks: { t1: { status: 'running' } } });
    expect(v.canManage).toBe(false);
    expect(v.showPause).toBe(false);
    expect(v.showCancel).toBe(false);
  });

  it('null role (no access) → no write controls', () => {
    const v = vis({ status: 'running', role: null });
    expect(v.canManage).toBe(false);
  });

  it('admin role behaves like editor (write allowed)', () => {
    const v = vis({ status: 'running', role: 'admin', tasks: { t1: { status: 'running' } } });
    expect(v.showPause).toBe(true);
  });

  it('uses effectiveStatus for running/paused gating (display reconciliation)', () => {
    // Ledger still says running, but the reconciled status settled to completed
    // (terminal display) — controls follow the displayed pill, so nothing shows.
    const v = vis({ status: 'running', effectiveStatus: 'completed' });
    expect(v.showPause).toBe(false);
    expect(v.canManage).toBe(false);
  });
});
