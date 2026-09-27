import { describe, it, expect } from 'vitest';
import { initialRunViewState, type RunViewState } from '@aflow/run-view';
import {
  clampSnapshotLimit,
  overlayBlockedOnFromHotState,
  withDurableSimulatedBindings,
  SNAPSHOT_MAX_PAGE_EVENTS,
  SNAPSHOT_PAGE_EVENTS,
} from './buildSessionSnapshot.js';

const RUN_ID = '11111111-1111-1111-1111-111111111111';
const STEP_EXEC = '33333333-3333-3333-3333-333333333333';
const CHILD = '44444444-4444-4444-4444-444444444444';

function pausedSnapshot(overrides: Partial<RunViewState> = {}): RunViewState {
  return {
    ...initialRunViewState,
    status: 'PAUSED',
    requiredInput: { stepExecutionId: STEP_EXEC },
    blockedOn: { kind: 'user_input', stepExecutionId: STEP_EXEC },
    ...overrides,
  };
}

describe('overlayBlockedOnFromHotState (Plan 192 Phase 2)', () => {
  it('overlays workflow_run from the hot-state park marker over a folded user_input', () => {
    // A pre-descriptor pause event mis-folds as user_input (the parked step
    // carries a stepExecutionId); the hot-state marker corrects it.
    const result = overlayBlockedOnFromHotState(pausedSnapshot(), {
      status: 'PAUSED',
      waitingOnWorkflowRunId: RUN_ID,
    });
    expect(result.blockedOn).toEqual({ kind: 'workflow_run', runId: RUN_ID });
  });

  it('overlays child_session for PAUSED + delegationPauseSource child_running', () => {
    const result = overlayBlockedOnFromHotState(pausedSnapshot(), {
      status: 'PAUSED',
      delegationPauseSource: 'child_running',
      waitingForChildSessionIds: [CHILD],
    });
    expect(result.blockedOn).toEqual({ kind: 'child_session', sessionIds: [CHILD] });
  });

  it('derives user_input from hot currentStepExecutionId when a pause is recorded there', () => {
    const result = overlayBlockedOnFromHotState(
      pausedSnapshot({ requiredInput: null, blockedOn: null }),
      {
        status: 'PAUSED',
        currentStepExecutionId: STEP_EXEC,
        pauseReason: 'input_required',
      },
    );
    expect(result.blockedOn).toEqual({ kind: 'user_input', stepExecutionId: STEP_EXEC });
  });

  it('falls back to the folded requiredInput stepExecutionId when hot state has no pause record', () => {
    const result = overlayBlockedOnFromHotState(pausedSnapshot({ blockedOn: null }), {
      status: 'PAUSED',
    });
    expect(result.blockedOn).toEqual({ kind: 'user_input', stepExecutionId: STEP_EXEC });
  });

  it('keeps the folded blockedOn when hot state is missing (evicted after flush)', () => {
    const snapshot = pausedSnapshot();
    expect(overlayBlockedOnFromHotState(snapshot, null)).toBe(snapshot);
  });

  it('skips the overlay when statuses disagree (events fresher than hot state)', () => {
    // Hot state still says PAUSED+workflow_run but the fold already saw the
    // resume — overlaying would pin a stale workflow_run on a RUNNING view.
    const snapshot: RunViewState = {
      ...initialRunViewState,
      status: 'RUNNING',
      blockedOn: null,
    };
    const result = overlayBlockedOnFromHotState(snapshot, {
      status: 'PAUSED',
      waitingOnWorkflowRunId: RUN_ID,
    });
    expect(result).toBe(snapshot);
  });

  it('clears a folded blockedOn when hot state agrees on status but derives null', () => {
    // WAITING_ON_CHILD on both sides but hot state has no child list and no
    // marker → derivation yields child_session with empty ids.
    const snapshot: RunViewState = {
      ...initialRunViewState,
      status: 'WAITING_ON_CHILD',
      blockedOn: { kind: 'child_session', sessionIds: [] },
    };
    const result = overlayBlockedOnFromHotState(snapshot, {
      status: 'WAITING_ON_CHILD',
      waitingForChildSessionIds: [CHILD],
    });
    expect(result.blockedOn).toEqual({ kind: 'child_session', sessionIds: [CHILD] });
  });

  it('preserves a folded needs_oauth_consent over the hot-state user_input derivation (cold mount)', () => {
    // The SessionPaused event metadata folds a rich needs_oauth_consent blockedOn;
    // hot-state derivation can only see a generic user_input. Downgrading it on cold
    // mount would let the chat resume-gate treat a consent pause as type-to-resume.
    const consent = {
      kind: 'needs_oauth_consent' as const,
      integrationKind: 'mcp' as const,
      resourceKey: 'server-1',
      bindingId: 'binding-1',
      ownerScope: 'user' as const,
      reason: 'never_connected' as const,
    };
    const result = overlayBlockedOnFromHotState(pausedSnapshot({ blockedOn: consent }), {
      status: 'PAUSED',
      currentStepExecutionId: STEP_EXEC,
      pauseReason: 'oauth_consent',
    });
    expect(result.blockedOn).toEqual(consent);
  });
});

/**
 * The one accumulating fact a bounded page cannot carry.
 *
 * Everything else the mount folds is either current (a status, a pause, the
 * last error) or attached to a message inside the page. This list is neither:
 * it never clears, because one fabricated fact makes the whole room a rehearsal
 * and keeps it one. Folding only the newest events would drop the banner from
 * exactly the sessions that have rehearsed longest — the invariant inverted,
 * and silently.
 */
describe('withDurableSimulatedBindings', () => {
  it('carries a rehearsal the page is too recent to have seen', () => {
    const result = withDurableSimulatedBindings(initialRunViewState, ['bnpl-sim']);
    expect(result.simulatedBindings).toEqual(['bnpl-sim']);
  });

  it('keeps the durable ones first — they are the older ones', () => {
    const folded = { ...initialRunViewState, simulatedBindings: ['fresh-sim'] };
    const result = withDurableSimulatedBindings(folded, ['old-sim']);
    expect(result.simulatedBindings).toEqual(['old-sim', 'fresh-sim']);
  });

  it('does not repeat a binding the page folded and the log also holds', () => {
    const folded = { ...initialRunViewState, simulatedBindings: ['bnpl-sim'] };
    const result = withDurableSimulatedBindings(folded, ['bnpl-sim']);
    expect(result.simulatedBindings).toEqual(['bnpl-sim']);
  });

  it('leaves a session that never rehearsed untouched', () => {
    const result = withDurableSimulatedBindings(initialRunViewState, []);
    expect(result).toBe(initialRunViewState);
  });

  it('keeps what the page folded when the durable read finds nothing', () => {
    // The events are in Redis and have not flushed yet, so the log cannot
    // answer for them and the fold is the only source.
    const folded = { ...initialRunViewState, simulatedBindings: ['unflushed-sim'] };
    expect(withDurableSimulatedBindings(folded, []).simulatedBindings).toEqual(['unflushed-sim']);
  });
});

/**
 * How deep a reader is allowed to ask.
 *
 * Reading further back re-folds from one end rather than stitching a page onto
 * the last one, so depth is cost. Uncapped, scrolling back through a long
 * session arrives at the whole-history fold this replaced.
 */
describe('clampSnapshotLimit', () => {
  it('opens at one page when no depth is asked for', () => {
    expect(clampSnapshotLimit(undefined)).toBe(SNAPSHOT_PAGE_EVENTS);
  });

  it('gives a reader the depth they asked for', () => {
    expect(clampSnapshotLimit(SNAPSHOT_PAGE_EVENTS * 3)).toBe(SNAPSHOT_PAGE_EVENTS * 3);
  });

  it('caps a deeper ask at the ceiling rather than refusing it', () => {
    // The reader wants more conversation. The honest answer is the deepest page
    // there is room for, with `hasOlder` still true above it.
    expect(clampSnapshotLimit(SNAPSHOT_MAX_PAGE_EVENTS * 5)).toBe(SNAPSHOT_MAX_PAGE_EVENTS);
  });

  it('falls back to one page for a depth that is not a usable number', () => {
    expect(clampSnapshotLimit(0)).toBe(SNAPSHOT_PAGE_EVENTS);
    expect(clampSnapshotLimit(-100)).toBe(SNAPSHOT_PAGE_EVENTS);
    expect(clampSnapshotLimit(Number.NaN)).toBe(SNAPSHOT_PAGE_EVENTS);
    expect(clampSnapshotLimit(Number.POSITIVE_INFINITY)).toBe(SNAPSHOT_PAGE_EVENTS);
  });

  it('reads a whole number of events', () => {
    expect(clampSnapshotLimit(250.7)).toBe(250);
  });
});
