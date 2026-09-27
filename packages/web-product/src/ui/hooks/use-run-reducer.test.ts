import { describe, it, expect } from 'vitest';
import {
  carryInFlightMessages,
  deeperPageWouldAdvance,
  sseStartupForRun,
  supersedesLiveActivity,
  type LiveStreamActivity,
  type SseStartup,
} from './use-run-reducer';
import { initialRunViewState, type Message, type RunViewState } from '@aflow/run-view';
import type { SessionEvent } from '@aflow/web-product/ui';

const STEP = '33333333-3333-3333-3333-333333333333';
const OTHER_STEP = '44444444-4444-4444-4444-444444444444';

function evt(eventType: string, stepExecutionId?: string, metadata?: Record<string, unknown>) {
  return { eventType, stepExecutionId, metadata } as unknown as SessionEvent;
}

const live: LiveStreamActivity = { stepExecutionId: STEP, channel: 'text', atMs: 1 };

describe('sseStartupForRun', () => {
  const tailA: SseStartup = {
    runId: 'session-a',
    mode: 'snapshot-tail',
    cursor: 'evt-a',
    skipCatchup: true,
  };

  it('passes the startup state through when it describes the current session', () => {
    expect(sseStartupForRun(tailA, 'session-a')).toBe(tailA);
  });

  it('gates a startup state stamped with the previous session', () => {
    expect(sseStartupForRun(tailA, 'session-b')).toEqual({ runId: 'session-b', mode: 'gated' });
  });

  it('gates when the session goes away', () => {
    expect(sseStartupForRun(tailA, null)).toEqual({ runId: null, mode: 'gated' });
  });

  it('gates a stale fallback state too — a fallback tails from the stream start', () => {
    const fallbackA: SseStartup = { runId: 'session-a', mode: 'fallback' };
    expect(sseStartupForRun(fallbackA, 'session-b')).toEqual({
      runId: 'session-b',
      mode: 'gated',
    });
  });

  it('passes a matching gated state through unchanged', () => {
    const gated: SseStartup = { runId: 'session-a', mode: 'gated' };
    expect(sseStartupForRun(gated, 'session-a')).toBe(gated);
  });
});

describe('supersedesLiveActivity', () => {
  it('never supersedes when there is no live signal', () => {
    expect(supersedesLiveActivity(evt('StepSucceeded', STEP), null)).toBe(false);
  });

  it('clears when the streaming step ends (StepSucceeded is not otherwise terminal)', () => {
    expect(supersedesLiveActivity(evt('StepSucceeded', STEP), live)).toBe(true);
  });

  it('clears when the run rests', () => {
    expect(supersedesLiveActivity(evt('SessionPaused', STEP), live)).toBe(true);
    expect(supersedesLiveActivity(evt('SessionCompleted'), live)).toBe(true);
  });

  it('clears when a different step takes over', () => {
    expect(supersedesLiveActivity(evt('StepStarted', OTHER_STEP), live)).toBe(true);
  });

  it('does NOT clear on a retryable failure — the retry re-streams the same step', () => {
    expect(supersedesLiveActivity(evt('StepFailed', STEP, { willRetry: true }), live)).toBe(false);
  });

  it('clears on a non-retrying failure of the streaming step', () => {
    expect(supersedesLiveActivity(evt('StepFailed', STEP), live)).toBe(true);
  });

  it('ignores unrelated events for the same step (e.g. a surface update)', () => {
    expect(supersedesLiveActivity(evt('SurfaceUpdate', STEP), live)).toBe(false);
  });
});

/**
 * Reading further back re-folds the conversation from the durable log, and the
 * durable log has not heard of the step streaming right now or a message still
 * on its way to the orchestrator. Hydrating over them blanks the answer
 * mid-sentence.
 */
describe('carryInFlightMessages', () => {
  function msg(over: Partial<Message> & { id: string }): Message {
    return { role: 'assistant', content: '', timestamp: '2026-01-01T00:00:00.000Z', ...over };
  }
  function withMessages(messages: Message[]): RunViewState {
    return { ...initialRunViewState, messages };
  }

  it('keeps the answer that is streaming right now', () => {
    const previous = [msg({ id: 'streaming-step-1', semanticType: 'streaming_text' })];
    const result = carryInFlightMessages(withMessages([msg({ id: 'older' })]), previous);
    expect(result.messages.map((m) => m.id)).toEqual(['older', 'streaming-step-1']);
  });

  it('keeps a thinking preview too', () => {
    const previous = [msg({ id: 'thinking-step-1', semanticType: 'streaming_thinking' })];
    expect(carryInFlightMessages(initialRunViewState, previous).messages).toHaveLength(1);
  });

  it('keeps a user message still being delivered', () => {
    const previous = [msg({ id: 'optimistic', role: 'user', deliveryState: 'queued' })];
    expect(carryInFlightMessages(initialRunViewState, previous).messages).toHaveLength(1);
  });

  it('leaves settled history behind — the fold is the authority on that', () => {
    // Carrying these would resurrect messages an older page legitimately
    // re-folded, and outrank the server on what the conversation contains.
    const previous = [msg({ id: 'agent-resp-1' }), msg({ id: 'agent-msg-2', isInterim: true })];
    expect(carryInFlightMessages(initialRunViewState, previous).messages).toEqual([]);
  });

  it('does not duplicate one the fold already reached', () => {
    // The step finished while the page was in flight, so the durable answer is
    // in the snapshot under the same id the stream was building.
    const previous = [msg({ id: 'streaming-step-1', semanticType: 'streaming_text' })];
    const snapshot = withMessages([msg({ id: 'streaming-step-1', content: 'final' })]);
    const result = carryInFlightMessages(snapshot, previous);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe('final');
  });

  it('returns the snapshot untouched when nothing is in flight', () => {
    const snapshot = withMessages([msg({ id: 'a' })]);
    expect(carryInFlightMessages(snapshot, [])).toBe(snapshot);
  });
});

/**
 * When asking for more history stops being worth offering.
 *
 * The server caps how deep one fold goes and still reports that older history
 * exists, which is true. A client that reads that as an invitation asks again,
 * gets the same clamped page, and offers the button again — a control that
 * promises more and delivers the same screen, forever.
 */
describe('deeperPageWouldAdvance', () => {
  it('allows the first deeper ask, having nothing to compare against', () => {
    expect(deeperPageWouldAdvance(null, 200)).toBe(true);
  });

  it('allows an ask that reached further back', () => {
    expect(deeperPageWouldAdvance(200, 400)).toBe(true);
  });

  it('stops when the deeper ask came back no deeper', () => {
    // The ceiling answering: the client asked for 2,200 and got 2,000 again.
    expect(deeperPageWouldAdvance(2000, 2000)).toBe(false);
  });

  it('stops when a session simply ran out before the ceiling', () => {
    // 680 events folded whole; asking deeper cannot add to that either.
    expect(deeperPageWouldAdvance(680, 680)).toBe(false);
  });

  it('stops on a fold that came back shorter', () => {
    expect(deeperPageWouldAdvance(2000, 1800)).toBe(false);
  });
});
