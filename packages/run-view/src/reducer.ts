/**
 * Run-view reducer — thin fold entry re-exporting state and dispatch.
 */
export {
  type RunViewState,
  type RunViewAction,
  type LiveDeltaAction,
  type HarnessActivityState,
  INITIAL_STATE,
} from './reducer/state.js';

import { INITIAL_STATE, type RunViewState, type RunViewAction } from './reducer/state.js';
import { applyLocalAction } from './reducer/localActions.js';
import { applySseEvent } from './reducer/applySseEvent.js';
import { applyLiveDelta } from './reducer/events/agentStreaming.js';

export function runViewReducer(state: RunViewState, action: RunViewAction): RunViewState {
  const local = applyLocalAction(state, action);
  if (local !== null) {
    return local;
  }

  if (action.type === 'SSE_EVENT') {
    return applySseEvent(state, action.event, action.flowName);
  }

  if (action.type === 'LIVE_DELTA') {
    return applyLiveDelta(state, action);
  }

  return state;
}

export const initialRunViewState = INITIAL_STATE;

export { unsettledHarnessSteps } from './reducer/events/harnessActivity.js';
