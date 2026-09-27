import type { ApiSessionEvent } from '@aflow/schemas';
import {
  runViewReducer,
  initialRunViewState,
  type RunViewState,
  type SessionEvent as ReducerSessionEvent,
} from '@aflow/run-view';

export interface SnapshotFoldResult {
  /** Materialized RunViewState after folding all events. */
  snapshot: RunViewState;
  /** Number of synthetic catch-up events folded after the durable ones. */
  catchupEventCount: number;
}

/**
 * Fold a page of durable events, then the synthetic catch-up ones, into the
 * state a mount renders.
 *
 * The catch-up events go last because they describe workflow-run surfaces as
 * they stand now, not as the page left them.
 */
export function foldEventsToSnapshot(
  durableEvents: ApiSessionEvent[],
  catchupEvents: ApiSessionEvent[],
): SnapshotFoldResult {
  let state = initialRunViewState;

  for (const event of durableEvents) {
    state = runViewReducer(state, {
      type: 'SSE_EVENT',
      event: event as ReducerSessionEvent,
    });
  }

  for (const event of catchupEvents) {
    state = runViewReducer(state, {
      type: 'SSE_EVENT',
      event: event as ReducerSessionEvent,
    });
  }

  return {
    snapshot: state,
    catchupEventCount: catchupEvents.length,
  };
}
