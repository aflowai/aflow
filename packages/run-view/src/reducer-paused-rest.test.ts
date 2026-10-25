/**
 * A paused session has nothing working in it.
 *
 * The Helmsman asks a question with `human.chat.ask` and the session pauses on
 * it. Live frames travel apart from the durable stream, so the turn's last
 * thinking or text frame can land after the turn's own `StepSucceeded` — and
 * after the pause. Folded as it arrives, it mounts a thinking box under the
 * question, or turns the turn's settled reply back into a streaming one, and
 * the completed turn reads as still in progress below the question.
 */
import { describe, expect, it } from 'vitest';
import type { HarnessActivityLine } from '@aflow/schemas';
import { initialRunViewState, runViewReducer, unsettledHarnessSteps } from './reducer.js';
import type { LiveDeltaAction, RunViewState } from './reducer.js';
import type { SessionEvent } from './types.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const TURN = '33333333-3333-3333-3333-333333333331';
const ASK = '33333333-3333-3333-3333-333333333332';
const CHILD = '33333333-3333-3333-3333-333333333333';
const COMMAND = '33333333-3333-3333-3333-333333333334';
const TIMESTAMP = '2026-10-25T10:00:00.000Z';

function evt(
  eventType: string,
  stepExecutionId: string | undefined,
  metadata: Record<string, unknown> = {},
): SessionEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    sessionId: SESSION_ID,
    timestamp: TIMESTAMP,
    sequenceNumber: 0,
    eventVersion: 1,
    data: stepExecutionId ? { stepExecutionId } : {},
    ...(stepExecutionId ? { stepExecutionId } : {}),
    metadata,
  } as SessionEvent;
}

function live(
  stepExecutionId: string,
  channel: LiveDeltaAction['channel'],
  delta: string,
  offset = 0,
): LiveDeltaAction {
  return { type: 'LIVE_DELTA', stepExecutionId, channel, offset, delta, timestamp: TIMESTAMP };
}

function fold(inputs: Array<SessionEvent | LiveDeltaAction>, from = initialRunViewState) {
  let state: RunViewState = from;
  for (const input of inputs) {
    state =
      'eventType' in input
        ? runViewReducer(state, { type: 'SSE_EVENT', event: input })
        : runViewReducer(state, input);
  }
  return state;
}

const OUTPUT_LINE: HarnessActivityLine = { kind: 'output', at: 0, text: 'pulled luna' };

/** The model-swap conversation up to the moment the Helmsman pauses on its question. */
const askedAndPaused: Array<SessionEvent | LiveDeltaAction> = [
  evt('SessionStarted', undefined, { userMessage: 'Swap the Helmsman to a local model' }),
  evt('StepStarted', TURN, { stepName: 'Helmsman', operationId: 'ai.agent.turn' }),
  live(TURN, 'thinking', 'The operator should pick the model.'),
  live(TURN, 'text', 'Two models fit this machine.'),
  evt('StepSucceeded', TURN, {
    stepName: 'Helmsman',
    operationId: 'ai.agent.turn',
    agentAction: 'invoke_step',
    agentMessage: 'Two models fit this machine.',
  }),
  evt('StepSucceeded', ASK, { stepName: 'Ask the user', operationId: 'human.chat.ask' }),
  evt('StepStarted', CHILD, {
    stepName: '↪ Ask user (in chat)',
    operationId: 'user.interaction.ask',
  }),
  evt('SessionPaused', CHILD, {
    stepName: '↪ Ask user (in chat)',
    pauseReason: 'input_required',
    placement: 'chat_inline',
    kind: 'input',
    prompt: 'Which model should run the Helmsman?',
    inputSchema: { type: 'string', enum: ['glm-pro', 'luna'] },
    uiHints: { mode: 'choices' },
  }),
];

function inFlight(state: RunViewState) {
  return state.messages.filter(
    (m) => m.semanticType === 'streaming_text' || m.semanticType === 'streaming_thinking',
  );
}

describe('a session paused on a chat question', () => {
  it('reads as paused with the question last and nothing streaming', () => {
    const state = fold(askedAndPaused);
    expect(state.status).toBe('PAUSED');
    expect(state.streamingStepExecutionId).toBeNull();
    expect(inFlight(state)).toEqual([]);
    expect(state.messages.at(-1)?.semanticType).toBe('inline_hitl');
  });

  it('does not mount a late thinking frame of the finished turn below the question', () => {
    const state = fold([
      ...askedAndPaused,
      live(TURN, 'thinking', 'The operator should pick the model. Then swap.'),
    ]);
    expect(inFlight(state)).toEqual([]);
    expect(state.messages.at(-1)?.semanticType).toBe('inline_hitl');
  });

  it('does not turn the finished turn’s reply back into a streaming message', () => {
    const state = fold([
      ...askedAndPaused,
      live(TURN, 'text', ' Pick one.', Buffer.byteLength('Two models fit this machine.')),
    ]);
    expect(state.streamingStepExecutionId).toBeNull();
    expect(inFlight(state)).toEqual([]);
    const reply = state.messages.find((m) => m.id === `streaming-${TURN}`);
    expect(reply?.content).toBe('Two models fit this machine.');
  });

  it('settles a feed whose step never reported its end before the pause', () => {
    const state = fold([
      evt('SessionStarted', undefined),
      evt('StepStarted', COMMAND, { operationId: 'host.command.run' }),
      live(COMMAND, 'activity', `${JSON.stringify(OUTPUT_LINE)}\n`),
      ...askedAndPaused.slice(1),
    ]);
    expect(state.status).toBe('PAUSED');
    expect(unsettledHarnessSteps(state.harnessActivity, state.messages)).toEqual([]);
  });

  it('leaves a workflow task’s running feed alone when the session pauses or finishes', () => {
    const WORKFLOW_TASK = '44444444-4444-4444-4444-444444444444';
    const taskFrame = (text: string, offset: number) =>
      live(
        WORKFLOW_TASK,
        'activity',
        `${JSON.stringify({ kind: 'output', at: offset, text })}\n`,
        offset,
      );
    const first = taskFrame('building', 0);
    const second = taskFrame('testing', Buffer.byteLength(first.delta));

    const paused = fold([
      evt('SessionStarted', undefined),
      evt('StepStarted', COMMAND, { operationId: 'host.command.run' }),
      live(COMMAND, 'activity', `${JSON.stringify(OUTPUT_LINE)}\n`),
      // The workflow run's task streams its feed into this view; its steps
      // report through workflow events, never as this session's own steps.
      first,
      ...askedAndPaused.slice(1),
    ]);
    expect(paused.status).toBe('PAUSED');
    expect(paused.harnessActivity[COMMAND]?.settled).toBe(true);
    expect(paused.harnessActivity[WORKFLOW_TASK]?.settled).toBe(false);
    expect(unsettledHarnessSteps(paused.harnessActivity, paused.messages)).toEqual([WORKFLOW_TASK]);

    const stillRunning = fold([second, evt('SessionSucceeded', undefined)], paused);
    expect(stillRunning.harnessActivity[WORKFLOW_TASK]).toMatchObject({ settled: false });
    expect(stillRunning.harnessActivity[WORKFLOW_TASK]?.lines.map((l) => l.text)).toEqual([
      'building',
      'testing',
    ]);
  });

  it('keeps work under a pause that waits on a child — the child is working', () => {
    const state = fold([
      evt('SessionStarted', undefined),
      evt('StepStarted', COMMAND, { operationId: 'host.command.run' }),
      live(COMMAND, 'activity', `${JSON.stringify(OUTPUT_LINE)}\n`),
      evt('SessionPaused', COMMAND, { pauseType: 'subflow_waiting', subflowWaiting: true }),
    ]);
    expect(state.status).toBe('WAITING_ON_CHILD');
    expect(unsettledHarnessSteps(state.harnessActivity, state.messages)).toEqual([COMMAND]);
  });

  it('streams the next turn once the session resumes', () => {
    const NEXT = '33333333-3333-3333-3333-333333333335';
    const state = fold([
      ...askedAndPaused,
      evt('SessionResumed', undefined, { userMessage: 'luna' }),
      evt('StepStarted', NEXT, { stepName: 'Helmsman', operationId: 'ai.agent.turn' }),
      live(NEXT, 'text', 'Swapping to luna.'),
    ]);
    expect(state.status).toBe('RUNNING');
    expect(state.streamingStepExecutionId).toBe(NEXT);
    expect(inFlight(state).map((m) => m.content)).toEqual(['Swapping to luna.']);
  });
});
