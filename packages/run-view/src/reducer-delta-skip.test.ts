import { describe, it, expect } from 'vitest';
import { runViewReducer, initialRunViewState } from './reducer.js';
import type { LiveDeltaAction, RunViewState } from './reducer.js';
import type { SessionEvent } from './types.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const STEP_EXEC_ID = '33333333-3333-3333-3333-333333333333';
const TIMESTAMP = '2026-05-19T10:00:00.000Z';

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
    timestamp: '2026-05-19T10:00:00.000Z',
    sequenceNumber: 0,
    eventVersion: 1,
    data: opts.data ?? {},
    ...(opts.stepExecutionId ? { stepExecutionId: opts.stepExecutionId } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  } as SessionEvent;
}

/** Frames arrive in order, so each one starts where the previous one ended. */
function liveFrames(
  channel: LiveDeltaAction['channel'],
  stepExecutionId: string,
  deltas: string[],
): LiveDeltaAction[] {
  let offset = 0;
  return deltas.map((delta) => {
    const frame: LiveDeltaAction = {
      type: 'LIVE_DELTA',
      stepExecutionId,
      channel,
      offset,
      delta,
      timestamp: TIMESTAMP,
    };
    offset += Buffer.byteLength(delta);
    return frame;
  });
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

function assistantContents(state: RunViewState): string[] {
  return state.messages.filter((m) => m.role === 'assistant').map((m) => m.content ?? '');
}

describe('snapshot fold without persisted deltas (Plan 154)', () => {
  it('StepSucceeded with agentMessage produces the same final text whether deltas were present or not', () => {
    const stepSucceeded = evt('StepSucceeded', {
      eventId: 'ss-1',
      stepExecutionId: STEP_EXEC_ID,
      metadata: { stepName: 'agent_turn', agentMessage: 'Hello, world!' },
    });

    // Live path — deltas streamed token-by-token, then StepSucceeded.
    const withDeltas = fold([
      ...liveFrames('text', STEP_EXEC_ID, ['Hello, ', 'world!']),
      stepSucceeded,
    ]);

    // Snapshot path — deltas filtered at the writer; only StepSucceeded
    // reaches the fold.
    const noDeltas = fold([stepSucceeded]);

    expect(assistantContents(withDeltas)).toEqual(['Hello, world!']);
    expect(assistantContents(noDeltas)).toEqual(['Hello, world!']);
  });

  it('SessionPaused with agentResponse produces the same final text whether deltas were present or not', () => {
    const stepSucceeded = evt('StepSucceeded', {
      eventId: 'ss-pause',
      stepExecutionId: STEP_EXEC_ID,
      metadata: { stepName: 'agent_turn', agentAction: 'pause_for_input' },
    });
    const sessionPaused = evt('SessionPaused', {
      eventId: 'sp-1',
      stepExecutionId: STEP_EXEC_ID,
      data: { stepExecutionId: STEP_EXEC_ID },
      metadata: { agentResponse: 'What is your name?' },
    });

    const withDeltas = fold([
      ...liveFrames('text', STEP_EXEC_ID, ['What is ', 'your name?']),
      stepSucceeded,
      sessionPaused,
    ]);

    const noDeltas = fold([stepSucceeded, sessionPaused]);

    expect(assistantContents(withDeltas)).toEqual(['What is your name?']);
    expect(assistantContents(noDeltas)).toEqual(['What is your name?']);
  });

  it('thinking-frame absence produces zero thinking messages either way', () => {
    // Thinking is explicitly ephemeral — reducer deletes the placeholder
    // on StepSucceeded regardless. Without the deltas, the placeholder
    // is never created and the deletion is a no-op. Either way: no
    // thinking msg survives a completed step.
    const stepSucceeded = evt('StepSucceeded', {
      eventId: 'ss-think',
      stepExecutionId: STEP_EXEC_ID,
      metadata: { stepName: 'agent_turn', agentMessage: 'Final answer.' },
    });

    const withDeltas = fold([
      ...liveFrames('thinking', STEP_EXEC_ID, ['Thinking...']),
      stepSucceeded,
    ]);

    const noDeltas = fold([stepSucceeded]);

    const thinkingMsgs = (s: RunViewState) =>
      s.messages.filter((m) => m.id.startsWith('thinking-'));

    expect(thinkingMsgs(withDeltas)).toHaveLength(0);
    expect(thinkingMsgs(noDeltas)).toHaveLength(0);

    // And the final assistant text is the same.
    expect(assistantContents(withDeltas)).toEqual(['Final answer.']);
    expect(assistantContents(noDeltas)).toEqual(['Final answer.']);
  });

  it('subagent complete: SessionCompleted.metadata.agentMessage materializes the assistant text without deltas', () => {
    // Regression test for the reviewer-flagged gap: subagent complete
    // path emits a StepSucceeded WITHOUT agentMessage and then a
    // SessionCompleted WITH agentMessage. Pre-Plan-154, persisted
    // streaming deltas left a `streaming-${stepExec}` msg that
    // accidentally became the final visible text. Post-Plan-154, the
    // reducer must read SessionCompleted.metadata.agentMessage directly.
    const stepSucceededNoMsg = evt('StepSucceeded', {
      eventId: 'ss-subagent',
      stepExecutionId: STEP_EXEC_ID,
      data: { stepExecutionId: STEP_EXEC_ID },
      metadata: {
        stepName: 'agent_turn',
        agentAction: 'complete',
        agentRole: 'subagent',
      },
    });
    const sessionCompleted = evt('SessionCompleted', {
      eventId: 'sc-subagent',
      stepExecutionId: STEP_EXEC_ID,
      data: { stepExecutionId: STEP_EXEC_ID },
      metadata: {
        agentRole: 'subagent',
        agentMessage: 'Subagent final answer.',
      },
    });

    // Live path — deltas present; final text accumulated via streaming
    // msg, then SessionCompleted promotes it in-place to agentMessage.
    const withDeltas = fold([
      ...liveFrames('text', STEP_EXEC_ID, ['Subagent ', 'final answer.']),
      stepSucceededNoMsg,
      sessionCompleted,
    ]);

    // Snapshot path — no deltas; reducer surfaces agentMessage via the
    const noDeltas = fold([stepSucceededNoMsg, sessionCompleted]);

    expect(assistantContents(withDeltas)).toEqual(['Subagent final answer.']);
    expect(assistantContents(noDeltas)).toEqual(['Subagent final answer.']);
  });

  it('two distinct subagent turns with identical agentMessage text both render (dedup is per-event, not global)', () => {
    // Reviewer-flagged regression: an earlier dedup pass matched by
    // content alone, suppressing the second turn whenever a prior
    // assistant message happened to carry the same text (e.g. "Done."
    // twice). Dedup must scope to the same SessionCompleted event.
    const turn1Step = '88888888-8888-8888-8888-888888888881';
    const turn2Step = '88888888-8888-8888-8888-888888888882';

    const turn1Succ = evt('StepSucceeded', {
      eventId: 'ss-t1',
      stepExecutionId: turn1Step,
      data: { stepExecutionId: turn1Step },
      metadata: { stepName: 'agent_turn', agentRole: 'subagent', agentAction: 'complete' },
    });
    const turn1Done = evt('SessionCompleted', {
      eventId: 'sc-t1',
      stepExecutionId: turn1Step,
      data: { stepExecutionId: turn1Step },
      metadata: { agentRole: 'subagent', agentMessage: 'Done.' },
    });

    const turn2Succ = evt('StepSucceeded', {
      eventId: 'ss-t2',
      stepExecutionId: turn2Step,
      data: { stepExecutionId: turn2Step },
      metadata: { stepName: 'agent_turn', agentRole: 'subagent', agentAction: 'complete' },
    });
    const turn2Done = evt('SessionCompleted', {
      eventId: 'sc-t2',
      stepExecutionId: turn2Step,
      data: { stepExecutionId: turn2Step },
      metadata: { agentRole: 'subagent', agentMessage: 'Done.' },
    });

    const folded = fold([turn1Succ, turn1Done, turn2Succ, turn2Done]);
    expect(assistantContents(folded)).toEqual(['Done.', 'Done.']);
  });

  it('LIVE delivery: SessionPaused agentResponse with markdown differing from streamed deltas upgrades in place (no duplicate)', () => {
    // Real-world bug: deltas stream plain text "The Kaggle ML Experiment
    // skill has run successfully!" but the canonical `decision.message`
    // (mapped to `agentResponse` on SessionPaused) has markdown bold
    // "The **Kaggle ML Experiment** skill has run successfully!".
    // Pre-fix: `agentResponse.startsWith(streamedText)` returned false
    // (markdown bytes don't prefix-match plain text), so the reducer
    // fell through to create a new `agent-resp-${eventId}` alongside
    // the already-promoted `streaming-${stepExec}` msg — two visible
    // Helmsman-labeled messages with the same rendered content.
    // Post-fix: anchor by `stepExecutionId`, upgrade the streaming msg
    // in place regardless of byte-level prefix match.
    const stepExec = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const streamedPlain = 'The Kaggle ML Experiment skill has run successfully! Done.';
    const finalMarkdown = 'The **Kaggle ML Experiment** skill has run successfully! Done.';

    const folded = fold([
      ...liveFrames('text', stepExec, [streamedPlain]),
      evt('StepSucceeded', {
        eventId: 'ss-stream',
        stepExecutionId: stepExec,
        data: { stepExecutionId: stepExec },
        metadata: { stepName: 'Helmsman', agentAction: 'pause_for_input' },
      }),
      evt('SessionPaused', {
        eventId: 'sp-stream',
        stepExecutionId: stepExec,
        data: { stepExecutionId: stepExec },
        metadata: { stepName: 'Helmsman', agentResponse: finalMarkdown },
      }),
    ]);

    const assistant = folded.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toBe(finalMarkdown);
    expect(assistant[0]?.senderName).toBe('Helmsman');
  });

  it('SessionCompleted with agentMessage skips re-render when a StepSucceeded already produced an anchored msg', () => {
    // Live mode: deltas streamed → streaming-${stepExec} msg. StepSucceeded
    // for the same step (without agentMessage) "promotes" the streaming msg
    // in-place, leaving it anchored to stepExecutionId. Then
    // SessionCompleted carrying agentMessage fires. Without the
    // stepExecutionId-anchored dedup, the SessionCompleted fallback would
    // add a SECOND assistant message ("agent-msg-${eventId}") with the
    // same content — that's the duplication bug the screenshot showed.
    const stepExec = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const folded = fold([
      ...liveFrames('text', stepExec, ['Hey ', 'Karim!']),
      evt('StepSucceeded', {
        eventId: 'ss-anchor',
        stepExecutionId: stepExec,
        data: { stepExecutionId: stepExec },
        metadata: { stepName: 'Helmsman', agentRole: 'subagent', agentAction: 'complete' },
      }),
      evt('SessionCompleted', {
        eventId: 'sc-anchor',
        stepExecutionId: stepExec,
        data: { stepExecutionId: stepExec },
        metadata: { agentRole: 'subagent', agentMessage: 'Hey Karim!' },
      }),
    ]);
    expect(assistantContents(folded)).toEqual(['Hey Karim!']);
  });

  it('subagent complete with outputVariables AND agentMessage → no duplicate assistant messages', () => {
    // Both code paths in the SessionCompleted handler can fire. Make
    // sure they don't double-render. agentMessage matches the output
    // variable content (a common case when the subagent emits a
    // single text result variable carrying the same content as its
    // narration); we want one visible message, not two.
    const sessionCompleted = evt('SessionCompleted', {
      eventId: 'sc-both',
      stepExecutionId: STEP_EXEC_ID,
      data: {
        stepExecutionId: STEP_EXEC_ID,
        outputVariables: [
          {
            key: 'answer',
            value: { kind: 'inline', value: 'Hello!' },
            semanticType: 'text',
          },
        ],
      },
      metadata: { agentMessage: 'Hello!' },
    });

    const folded = fold([sessionCompleted]);
    expect(assistantContents(folded)).toEqual(['Hello!']);
  });

  it('a re-subscribe mid-step resends the whole partial and replaces it rather than doubling it', () => {
    // A dropped socket re-subscribes, and the server reads the step's buffer
    // from the start again. The frame says where its bytes begin, so an
    // offset-0 frame is the whole value, not an increment.
    const stepExec = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const folded = fold([
      ...liveFrames('text', stepExec, ['Half a ', 'sentence']),
      ...liveFrames('text', stepExec, ['Half a sentence, then more']),
    ]);

    expect(assistantContents(folded)).toEqual(['Half a sentence, then more']);
  });

  it('StepSucceeded with no agentMessage and no preceding deltas → no assistant message (tool-call-only turn)', () => {
    // Agents that emit only tool calls (no narration) produce neither
    // deltas nor agentMessage. Snapshot fold should match live fold:
    // zero assistant messages from this step.
    const stepSucceeded = evt('StepSucceeded', {
      eventId: 'ss-tool',
      stepExecutionId: STEP_EXEC_ID,
      metadata: {
        stepName: 'agent_turn',
        agentAction: 'invoke_step',
        invokedTools: [{ toolId: 'search', name: 'Search', operation: 'api.search.get' }],
      },
    });

    expect(assistantContents(fold([stepSucceeded]))).toEqual([]);
  });
});
