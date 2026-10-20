/**
 * A command step's live output is never a conversation message.
 *
 * What a folder check or a host command prints is the step's work, not the
 * run speaking. Folded as a message it reads as the conversation's agent —
 * a live frame carries no step name, so the client names it with the flow's —
 * and it disappears on refresh, because no durable event ever replaces it.
 * It folds under the step, as a harness's feed does.
 */
import { describe, expect, it } from 'vitest';
import type { HarnessActivityLine } from '@aflow/schemas';
import { initialRunViewState, runViewReducer, unsettledHarnessSteps } from './reducer.js';
import type { LiveDeltaAction, RunViewState } from './reducer.js';
import type { SessionEvent } from './types.js';

const STEP = '55555555-5555-5555-5555-555555555555';
const TIMESTAMP = '2026-10-20T18:09:00.000Z';
const FLOW_NAME = 'Workspace Agent';

const PRINTED: HarnessActivityLine[] = [
  { kind: 'output', at: 0, text: 'building @aflow/schemas' },
  { kind: 'output', at: 1_200, text: 'ok   build @aflow/schemas' },
  { kind: 'output', at: 4_800, text: 'ok   tsc apps/aflow-executor-host/tsconfig.json' },
];

/** As the host executor streams it: one JSON line per printed line, in order. */
function framesOf(lines: HarnessActivityLine[]): LiveDeltaAction[] {
  let offset = 0;
  return lines.map((line) => {
    const delta = `${JSON.stringify(line)}\n`;
    const frame: LiveDeltaAction = {
      type: 'LIVE_DELTA',
      stepExecutionId: STEP,
      channel: 'activity',
      offset,
      delta,
      timestamp: TIMESTAMP,
      // What the chat attaches to every live frame, for want of a step name.
      senderName: FLOW_NAME,
    };
    offset += Buffer.byteLength(delta);
    return frame;
  });
}

function stepSucceeded(operationId: string): SessionEvent {
  return {
    eventId: `StepSucceeded-${STEP}`,
    eventType: 'StepSucceeded',
    sessionId: '11111111-1111-1111-1111-111111111111',
    stepExecutionId: STEP,
    timestamp: TIMESTAMP,
    sequenceNumber: 2,
    eventVersion: 1,
    data: {},
    metadata: { operationId },
  } as SessionEvent;
}

function fold(actions: LiveDeltaAction[]): RunViewState {
  return actions.reduce(runViewReducer, initialRunViewState);
}

describe.each(['host.commit.check', 'host.process.exec'])(
  'the live output of a %s step',
  (operationId) => {
    it('produces no message and claims no streaming step', () => {
      const state = fold(framesOf(PRINTED));
      expect(state.messages).toEqual([]);
      expect(state.streamingStepExecutionId).toBeNull();
    });

    it('folds under its step, line by line', () => {
      const state = fold(framesOf(PRINTED));
      expect(state.harnessActivity[STEP]?.lines).toEqual(PRINTED);
      expect(unsettledHarnessSteps(state.harnessActivity, state.messages)).toEqual([STEP]);
    });

    it('stays out of the conversation once the step ends, and leaves the running set', () => {
      const done = runViewReducer(fold(framesOf(PRINTED)), {
        type: 'SSE_EVENT',
        event: stepSucceeded(operationId),
        flowName: FLOW_NAME,
      });
      for (const message of done.messages) {
        expect(message.content).not.toContain('building @aflow/schemas');
        expect(message.senderName).not.toBe(FLOW_NAME);
      }
      expect(done.harnessActivity[STEP]?.lines).toEqual(PRINTED);
      expect(unsettledHarnessSteps(done.harnessActivity, done.messages)).toEqual([]);
    });
  },
);
