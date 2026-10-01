/**
 * A run's wakeup is a card in the transcript, in the order it landed: it is
 * why the agent speaks next, so the agent's reply follows it.
 */
import { describe, expect, it } from 'vitest';
import { applySseEvent } from '../applySseEvent.js';
import { INITIAL_STATE } from '../state.js';
import type { SessionEvent } from '../../types.js';

const SESSION = '00000000-0000-4000-8000-0000000000aa';
const RUN = '11111111-2222-3333-4444-555555555555';
const TURN = '00000000-0000-4000-8000-0000000000b1';

function wakeup(seq: number, metadata: Record<string, unknown>, payloadRef?: string): SessionEvent {
  return {
    eventId: `wake-${String(seq)}`,
    eventType: 'WorkflowRunWakeup',
    sessionId: SESSION,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    sequenceNumber: seq,
    eventVersion: 1,
    data: payloadRef ? { payloadRef } : {},
    metadata,
  } as unknown as SessionEvent;
}

function agentReply(seq: number, text: string): SessionEvent {
  return {
    eventId: `turn-${String(seq)}`,
    eventType: 'StepSucceeded',
    sessionId: SESSION,
    stepExecutionId: TURN,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    sequenceNumber: seq,
    eventVersion: 1,
    data: {},
    metadata: { operationId: 'ai.agent.turn', agentMessage: text },
  } as unknown as SessionEvent;
}

function fold(events: SessionEvent[]) {
  return events.reduce((state, event) => applySseEvent(state, event), INITIAL_STATE);
}

describe('WorkflowRunWakeup fold', () => {
  it('becomes a run_wakeup card naming the run, what happened and where the envelope is', () => {
    const state = fold([
      wakeup(1, { runId: RUN, outcome: 'paused', waiterId: 'w1' }, 'gs://bucket/wakeup'),
    ]);

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: 'run-wakeup-wake-1',
        role: 'system',
        semanticType: 'run_wakeup',
        richContent: { runId: RUN, outcome: 'paused', envelopeRef: 'gs://bucket/wakeup' },
      }),
    ]);
  });

  it('sits before the reply it caused', () => {
    const state = fold([
      wakeup(1, { runId: RUN, outcome: 'completed', waiterId: 'w1' }, 'gs://bucket/wakeup'),
      agentReply(2, 'The review approved the change.'),
    ]);

    expect(state.messages.map((m) => m.semanticType ?? m.content)).toEqual([
      'run_wakeup',
      'The review approved the change.',
    ]);
  });

  it('is folded once when the event is delivered twice', () => {
    const event = wakeup(1, { runId: RUN, outcome: 'failed', waiterId: 'w1' });
    expect(fold([event, event]).messages).toHaveLength(1);
  });

  it('leaves the transcript alone when the event does not say which run or what happened', () => {
    expect(fold([wakeup(1, { outcome: 'completed' })]).messages).toEqual([]);
    expect(fold([wakeup(2, { runId: RUN, outcome: 'exploded' })]).messages).toEqual([]);
  });
});
