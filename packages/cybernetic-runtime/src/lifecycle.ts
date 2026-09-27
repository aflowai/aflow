import type { ActiveSurfaceLifecycleReasonCode, ActiveSurfaceRunLifecycle } from '@aflow/schemas';

/** Default scheduler-stall threshold — 5 minutes. */
export const LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Normalized signal struct — the only input the precedence core knows about.
 * Adapters map their DB/Redis inputs into this shape; no precedence rule
 * may live in the adapter itself.
 */
export interface LifecycleSignals {
  /** `'completed' | 'failed' | 'cancelled'` for terminal runs/sessions; null otherwise. */
  terminal: 'completed' | 'failed' | 'cancelled' | null;
  /** Redis `interruptRequested` flag from the relevant session. */
  interruptRequested: boolean;
  /**
   * True if any task is paused on `user.input.request`, OR the session's
   * `delegationPauseSource` is `user_input`.
   */
  awaitingUserInput: boolean;
  /** True if waiting for a delegated child and there is no other live work. */
  awaitingChild: boolean;
  /** True for any other paused-state condition (programmatic pause, paused tasks). */
  paused: boolean;
  /** True when there is at least one live or scheduled task. */
  hasLiveWork: boolean;
  /** True when only scheduled-but-not-claimed tasks exist (no live tasks). */
  hasOnlyScheduledWork: boolean;
  /** Age of the scheduler cursor (or run startedAt as fallback) in ms. */
  schedulerStallAgeMs: number;
  /** Threshold above which `schedulerStallAgeMs` indicates a stall. */
  staleThresholdMs: number;
  /** True when at least one input read failed (Redis blip, missing hot state). */
  partialSignalRead: boolean;
}

export interface LifecycleResult {
  lifecycle: ActiveSurfaceRunLifecycle;
  reasonCode?: ActiveSurfaceLifecycleReasonCode;
}

export function deriveLifecycleFromSignals(s: LifecycleSignals): LifecycleResult {
  // 1. Terminal — short-circuits every flag.
  if (s.terminal === 'cancelled') return { lifecycle: 'cancelled' };
  if (s.terminal === 'failed') return { lifecycle: 'failed' };
  if (s.terminal === 'completed') return { lifecycle: 'completed' };

  // 2. Interrupt — wins over executing/paused while cancel drains.
  if (s.interruptRequested) {
    return { lifecycle: 'interrupting', reasonCode: 'interrupt_requested' };
  }

  // 3. Human / delegation blocks.
  if (s.awaitingUserInput) {
    return { lifecycle: 'awaiting_user', reasonCode: 'awaiting_user_input' };
  }
  if (s.awaitingChild) {
    return { lifecycle: 'awaiting_child', reasonCode: 'awaiting_child_session' };
  }

  // 4. Generic pause.
  if (s.paused) {
    return { lifecycle: 'paused', reasonCode: 'paused' };
  }

  // 5. Active work.
  if (s.hasLiveWork) {
    if (s.hasOnlyScheduledWork && s.schedulerStallAgeMs > s.staleThresholdMs) {
      return { lifecycle: 'stalled', reasonCode: 'scheduled_task_not_dispatched' };
    }
    return { lifecycle: 'executing' };
  }

  // 6. Idle with stale cursor.
  if (s.schedulerStallAgeMs > s.staleThresholdMs) {
    return { lifecycle: 'stalled', reasonCode: 'scheduler_stale' };
  }

  // 7. Should not happen in practice — telemetry path.
  return { lifecycle: 'unknown' };
}

/**
 * Apply the partial-signal-read annotation as a secondary `reasonCode`.
 *
 * If the derived lifecycle already has a reason code, we keep it (the
 * primary semantic wins) but the snapshot's `freshnessReason` and the
 * `active_surface_partial_signal_read_total` counter still surface the
 * Redis blip (wired in the aggregator, not here).
 *
 * If there is no primary reason code (e.g. plain `executing`), we promote
 * `partial_signal_read` to the slot so operators see "we think it's
 * running but Redis was flaky".
 */
export function applyPartialSignalAnnotation(
  result: LifecycleResult,
  partialSignalRead: boolean,
): LifecycleResult {
  if (!partialSignalRead) return result;
  if (result.reasonCode) return result;
  return { ...result, reasonCode: 'partial_signal_read' };
}
