import { describe, it, expect } from 'vitest';
import { runViewReducer, initialRunViewState } from './reducer.js';
import type { LiveDeltaAction, RunViewState } from './reducer.js';
import type { SessionEvent } from './types.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const STEP_EXEC_1 = '33333333-3333-3333-3333-333333333331';
const STEP_EXEC_2 = '33333333-3333-3333-3333-333333333332';

function evt(
  eventType: string,
  opts: {
    eventId?: string;
    data?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    stepExecutionId?: string;
  } = {},
): SessionEvent {
  return {
    eventId: opts.eventId ?? crypto.randomUUID(),
    eventType,
    sessionId: SESSION_ID,
    timestamp: '2026-06-10T10:00:00.000Z',
    sequenceNumber: 0,
    eventVersion: 1,
    data: opts.data ?? {},
    ...(opts.stepExecutionId ? { stepExecutionId: opts.stepExecutionId } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  } as SessionEvent;
}

function live(stepExecutionId: string, delta: string): LiveDeltaAction {
  return {
    type: 'LIVE_DELTA',
    stepExecutionId,
    channel: 'text',
    offset: 0,
    delta,
    timestamp: '2026-06-10T10:00:00.000Z',
  };
}

/** Durable events and live frames interleaved, in arrival order. */
function fold(inputs: Array<SessionEvent | LiveDeltaAction>): RunViewState {
  let state = initialRunViewState;
  for (const input of inputs) {
    state =
      'eventType' in input
        ? runViewReducer(state, { type: 'SSE_EVENT', event: input })
        : runViewReducer(state, input);
  }
  return state;
}

function assistants(state: RunViewState) {
  return state.messages.filter((m) => m.role === 'assistant');
}

describe('SessionPaused agentResponse reconciliation (Plan 192 §5)', () => {
  it('anchor stratum: whitespace-divergent agentResponse upgrades the promoted streaming msg in place (id preserved)', () => {
    const streamed = 'Here are  the results.\nDone.';
    const canonical = 'Here are the results.\n\nDone.';

    const folded = fold([
      live(STEP_EXEC_1, streamed),
      evt('StepSucceeded', {
        eventId: 'ss-ws',
        stepExecutionId: STEP_EXEC_1,
        data: { stepExecutionId: STEP_EXEC_1 },
        metadata: { stepName: 'Helmsman', agentAction: 'pause_for_input' },
      }),
      evt('SessionPaused', {
        eventId: 'sp-ws',
        stepExecutionId: STEP_EXEC_1,
        data: { stepExecutionId: STEP_EXEC_1 },
        metadata: { stepName: 'Helmsman', agentResponse: canonical },
      }),
    ]);

    const msgs = assistants(folded);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.id).toBe(`streaming-${STEP_EXEC_1}`);
    expect(msgs[0]?.content).toBe(canonical);
  });

  it('anchor stratum: narration+prompt merge (strict extension of the streamed narration) upgrades in place, no duplicate', () => {
    // The mergeNarrationAndMessage producer shape — the case the deleted
    // prefix-match stratum was originally kept for. The pause carries the
    // narration step's id, so the anchor covers it.
    const narration = 'Let me check the campaign ledger.';
    const merged = 'Let me check the campaign ledger.\n\nWhat budget should I assume?';

    const folded = fold([
      live(STEP_EXEC_1, narration),
      evt('StepSucceeded', {
        eventId: 'ss-merge',
        stepExecutionId: STEP_EXEC_1,
        data: { stepExecutionId: STEP_EXEC_1 },
        metadata: { stepName: 'Helmsman', agentAction: 'pause_for_input' },
      }),
      evt('SessionPaused', {
        eventId: 'sp-merge',
        stepExecutionId: STEP_EXEC_1,
        data: { stepExecutionId: STEP_EXEC_1 },
        metadata: { stepName: 'Helmsman', agentResponse: merged },
      }),
    ]);

    const msgs = assistants(folded);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.id).toBe(`streaming-${STEP_EXEC_1}`);
    expect(msgs[0]?.content).toBe(merged);
  });

  it('interim stratum: exact-content interim from StepSucceeded is upgraded in place (isInterim cleared), not duplicated', () => {
    const text = 'What is your name?';

    const folded = fold([
      evt('StepSucceeded', {
        eventId: 'ss-interim',
        stepExecutionId: STEP_EXEC_1,
        data: { stepExecutionId: STEP_EXEC_1 },
        metadata: { stepName: 'Helmsman', agentMessage: text },
      }),
      evt('SessionPaused', {
        eventId: 'sp-interim',
        stepExecutionId: STEP_EXEC_1,
        data: { stepExecutionId: STEP_EXEC_1 },
        metadata: { stepName: 'Helmsman', agentResponse: text },
      }),
    ]);

    const msgs = assistants(folded);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.id).toBe('agent-msg-ss-interim');
    expect(msgs[0]?.content).toBe(text);
    expect(msgs[0]?.isInterim).toBeUndefined();
  });

  it('deleted stratum is gone: a prior assistant bubble that merely prefix-matches (not interim, not anchored) is NOT absorbed — a new message is appended', () => {
    const earlier = 'Hello';
    const later = 'Hello there — here is the full follow-up answer.';

    const folded = fold([
      evt('SessionPaused', {
        eventId: 'sp-turn1',
        stepExecutionId: STEP_EXEC_1,
        data: { stepExecutionId: STEP_EXEC_1 },
        metadata: { agentResponse: earlier },
      }),
      evt('SessionResumed', { eventId: 'sr-turn1' }),
      evt('SessionPaused', {
        eventId: 'sp-turn2',
        stepExecutionId: STEP_EXEC_2,
        data: { stepExecutionId: STEP_EXEC_2 },
        metadata: { agentResponse: later },
      }),
    ]);

    const msgs = assistants(folded);
    expect(msgs.map((m) => m.content)).toEqual([earlier, later]);
    expect(msgs[0]?.id).toBe('agent-resp-sp-turn1');
    expect(msgs[1]?.id).toBe('agent-resp-sp-turn2');
  });
});
