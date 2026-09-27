/**
 * What the timeline and the banner know about a rehearsal.
 *
 * A mixed run holds real and fabricated facts side by side, so the run-level
 * marker cannot answer which message is which and the per-message marker cannot
 * answer whether the run is still a rehearsal after its opening events have
 * aged out. Both are folded, from the same event.
 */
import { describe, expect, it } from 'vitest';
import { runViewReducer, initialRunViewState } from './reducer.js';
import type { SessionEvent } from './types.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const STEP_EXEC_ID = '33333333-3333-3333-3333-333333333333';

function stepSucceeded(metadata: Record<string, unknown>): SessionEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType: 'StepSucceeded',
    sessionId: SESSION_ID,
    stepExecutionId: STEP_EXEC_ID,
    timestamp: '2026-08-29T10:00:00.000Z',
    sequenceNumber: 0,
    eventVersion: 1,
    data: { displayOutput: 'Refund rf_1 created for €400.' },
    metadata: { stepName: '↪ API bnpl-core.createRefund', displayOutput: true, ...metadata },
  } as SessionEvent;
}

describe('the simulated marker in the run-view fold', () => {
  it('names the binding on the run and marks the message it came from', () => {
    const state = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: stepSucceeded({
        operationId: 'api.http.call',
        simulated: true,
        simulatedBindingId: 'bind_bnpl',
      }),
    });

    expect(state.simulatedBindings).toEqual(['bind_bnpl']);
    expect(state.messages.at(-1)?.simulated).toBe(true);
  });

  it('leaves a live step unmarked, in the same run', () => {
    let state = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: stepSucceeded({
        operationId: 'api.http.call',
        simulated: true,
        simulatedBindingId: 'bind_bnpl',
      }),
    });
    state = runViewReducer(state, {
      type: 'SSE_EVENT',
      event: stepSucceeded({ operationId: 'memory.store.put' }),
    });

    expect(state.messages.at(-1)?.simulated).toBeUndefined();
    // The run stays a rehearsal — the banner does not come down because one
    // later fact was real.
    expect(state.simulatedBindings).toEqual(['bind_bnpl']);
  });

  it('records each binding once, in first-seen order', () => {
    let state = initialRunViewState;
    for (const bindingId of ['bind_bnpl', 'bind_crm', 'bind_bnpl']) {
      state = runViewReducer(state, {
        type: 'SSE_EVENT',
        event: stepSucceeded({
          operationId: 'api.http.call',
          simulated: true,
          simulatedBindingId: bindingId,
        }),
      });
    }

    expect(state.simulatedBindings).toEqual(['bind_bnpl', 'bind_crm']);
  });
});
