/**
 * The harness feed folds under the step, and survives being sent twice.
 *
 * A reconnect re-reads the step's buffer from the start, so the same lines
 * arrive again with `offset: 0`. A fold that appended them would show every
 * tool call twice for the rest of the run.
 */
import { describe, it, expect } from 'vitest';
import type { HarnessActivityLine } from '@aflow/schemas';
import { runViewReducer, initialRunViewState, unsettledHarnessSteps } from './reducer.js';
import type { LiveDeltaAction, RunViewState } from './reducer.js';
import type { SessionEvent } from './types.js';

const STEP = '33333333-3333-3333-3333-333333333333';
const TIMESTAMP = '2026-09-24T10:00:00.000Z';

const STATUS: HarnessActivityLine = { kind: 'status', at: 0, text: 'Model claude-opus-5' };
const THOUGHT: HarnessActivityLine = { kind: 'thought', at: 120, text: 'Reading the parser.' };
const TOOL: HarnessActivityLine = {
  kind: 'tool',
  at: 300,
  tool: 'Read',
  text: 'Read src/parser.ts',
};
const TOOL_RESULT: HarnessActivityLine = {
  kind: 'tool_result',
  at: 480,
  tool: 'Read',
  ok: true,
  text: 'export function parse( (+240 more lines)',
};

function wire(lines: HarnessActivityLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

/** Frames arrive in order, so each one starts where the previous one ended. */
function frames(deltas: string[], stepExecutionId = STEP): LiveDeltaAction[] {
  let offset = 0;
  return deltas.map((delta) => {
    const frame: LiveDeltaAction = {
      type: 'LIVE_DELTA',
      stepExecutionId,
      channel: 'activity',
      offset,
      delta,
      timestamp: TIMESTAMP,
    };
    offset += Buffer.byteLength(delta);
    return frame;
  });
}

/** The whole buffer resent from the start, as a re-subscribe delivers it. */
function replay(whole: string, stepExecutionId = STEP): LiveDeltaAction {
  return {
    type: 'LIVE_DELTA',
    stepExecutionId,
    channel: 'activity',
    offset: 0,
    delta: whole,
    timestamp: TIMESTAMP,
  };
}

function fold(actions: LiveDeltaAction[], from: RunViewState = initialRunViewState): RunViewState {
  return actions.reduce(runViewReducer, from);
}

function feed(state: RunViewState, stepExecutionId = STEP): HarnessActivityLine[] {
  return state.harnessActivity[stepExecutionId]?.lines ?? [];
}

describe('the harness feed folds under its step', () => {
  it('appends every line a frame completes, in order', () => {
    const state = fold(frames([wire([STATUS, THOUGHT]), wire([TOOL, TOOL_RESULT])]));
    expect(feed(state)).toEqual([STATUS, THOUGHT, TOOL, TOOL_RESULT]);
  });

  it('holds a line split across frames until the frame that completes it', () => {
    const whole = wire([TOOL]);
    const cut = Math.floor(whole.length / 2);
    const mid = fold(frames([whole.slice(0, cut)]));
    expect(feed(mid)).toEqual([]);

    const done = fold(frames([whole.slice(0, cut), whole.slice(cut)]));
    expect(feed(done)).toEqual([TOOL]);
  });

  it('a re-subscribe resends the whole buffer and rebuilds the same feed', () => {
    const whole = wire([STATUS, THOUGHT, TOOL]);
    const live = fold(frames([wire([STATUS, THOUGHT]), wire([TOOL])]));
    const afterReplay = runViewReducer(live, replay(whole));

    expect(feed(afterReplay)).toEqual([STATUS, THOUGHT, TOOL]);
  });

  it('a frame overlapping what is already folded adds only its tail', () => {
    const first = wire([STATUS, THOUGHT]);
    const state = fold(frames([first]));
    const overlapping: LiveDeltaAction = {
      type: 'LIVE_DELTA',
      stepExecutionId: STEP,
      channel: 'activity',
      offset: Buffer.byteLength(wire([STATUS])),
      delta: wire([THOUGHT, TOOL]),
      timestamp: TIMESTAMP,
    };

    expect(feed(runViewReducer(state, overlapping))).toEqual([STATUS, THOUGHT, TOOL]);
  });

  it('a frame carrying nothing new leaves the state identical', () => {
    const state = fold(frames([wire([STATUS])]));
    const resent: LiveDeltaAction = {
      type: 'LIVE_DELTA',
      stepExecutionId: STEP,
      channel: 'activity',
      offset: 0,
      delta: wire([STATUS]),
      timestamp: TIMESTAMP,
    };
    const again = runViewReducer(state, resent);
    expect(feed(again)).toEqual([STATUS]);
  });

  it('drops a line that is not JSON and one the schema refuses, and keeps reading', () => {
    const state = fold(
      frames([
        'not json at all\n',
        `${JSON.stringify({ kind: 'invented', at: 1, text: 'x' })}\n`,
        `${JSON.stringify({ kind: 'tool', tool: 'Read' })}\n`,
        wire([TOOL_RESULT]),
      ]),
    );
    expect(feed(state)).toEqual([TOOL_RESULT]);
  });

  it('keeps each step apart', () => {
    const other = '44444444-4444-4444-4444-444444444444';
    const state = fold([...frames([wire([STATUS])]), ...frames([wire([TOOL])], other)]);
    expect(feed(state)).toEqual([STATUS]);
    expect(feed(state, other)).toEqual([TOOL]);
  });
});

/**
 * A surface judging silence needs one clock, and a line's `at` is on the
 * harness's. The frame's timestamp is the reader's, so it is what dates the
 * feed — but only where the feed grew, since a reconnect re-sends the whole
 * buffer and dating that as work would clear the silence it should report.
 */
describe('when the feed last moved', () => {
  function movedAt(state: RunViewState, stepExecutionId = STEP): number | undefined {
    return state.harnessActivity[stepExecutionId]?.lastActivityAtMs;
  }

  function frameAt(timestamp: string, delta: string, offset = 0): LiveDeltaAction {
    return {
      type: 'LIVE_DELTA',
      stepExecutionId: STEP,
      channel: 'activity',
      offset,
      delta,
      timestamp,
    };
  }

  it('marks the frame that carried the newest lines', () => {
    const state = fold(frames([wire([STATUS, THOUGHT])]));
    expect(movedAt(state)).toBe(Date.parse(TIMESTAMP));
  });

  it('advances with each frame, so the mark is the latest one', () => {
    const later = '2026-09-24T10:04:00.000Z';
    const first = wire([STATUS]);
    const state = runViewReducer(
      fold(frames([first])),
      frameAt(later, wire([TOOL]), Buffer.byteLength(first)),
    );
    expect(movedAt(state)).toBe(Date.parse(later));
  });

  it('counts a frame that carried only half a line, since the harness is writing', () => {
    const whole = wire([TOOL]);
    const state = fold(frames([whole.slice(0, Math.floor(whole.length / 2))]));
    expect(feed(state)).toEqual([]);
    expect(movedAt(state)).toBe(Date.parse(TIMESTAMP));
  });

  it('leaves the mark where it was when a reconnect re-sends the same buffer', () => {
    const state = fold(frames([wire([STATUS, THOUGHT])]));
    const resent = runViewReducer(
      state,
      frameAt('2026-09-24T10:09:00.000Z', wire([STATUS, THOUGHT])),
    );
    expect(feed(resent)).toEqual([STATUS, THOUGHT]);
    expect(movedAt(resent)).toBe(Date.parse(TIMESTAMP));
  });

  it('moves it when that replay carries a line the feed had not seen', () => {
    const later = '2026-09-24T10:09:00.000Z';
    const state = fold(frames([wire([STATUS, THOUGHT])]));
    const resent = runViewReducer(state, frameAt(later, wire([STATUS, THOUGHT, TOOL])));
    expect(feed(resent)).toEqual([STATUS, THOUGHT, TOOL]);
    expect(movedAt(resent)).toBe(Date.parse(later));
  });
});

describe('the feed is never the conversation', () => {
  it('an activity frame writes no message and claims no streaming step', () => {
    const state = fold(frames([wire([STATUS, THOUGHT, TOOL, TOOL_RESULT])]));
    expect(state.messages).toEqual([]);
    expect(state.streamingStepExecutionId).toBeNull();
  });

  it('a text frame on the same step still becomes the message it always did', () => {
    const state = fold([
      ...frames([wire([THOUGHT])]),
      {
        type: 'LIVE_DELTA',
        stepExecutionId: STEP,
        channel: 'text',
        offset: 0,
        delta: 'The parser is fixed.',
        timestamp: TIMESTAMP,
      },
    ]);
    expect(state.messages.map((m) => m.content)).toEqual(['The parser is fixed.']);
    expect(feed(state)).toEqual([THOUGHT]);
  });
});

describe('mount hydration', () => {
  it('keeps a running step feed the snapshot cannot carry', () => {
    const live = fold(frames([wire([STATUS, TOOL])]));
    const hydrated = runViewReducer(live, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: { ...initialRunViewState, status: 'running' },
    });

    expect(feed(hydrated)).toEqual([STATUS, TOOL]);
    expect(hydrated.status).toBe('running');
  });

  it('RESET drops it', () => {
    const live = fold(frames([wire([STATUS])]));
    expect(feed(runViewReducer(live, { type: 'RESET' }))).toEqual([]);
  });
});

/**
 * A step inside a skill run belongs to a task, not to the session watching it.
 * The fold keys on the step either way — and the run card finds the feed by the
 * step the task row records, so the two have to agree on that id.
 */
describe('a step inside a run', () => {
  const RUN = '55555555-5555-5555-5555-555555555555';
  const WORKER_STEP = '66666666-6666-6666-6666-666666666666';

  const taskRunning: SessionEvent = {
    eventId: 'task-running',
    eventType: 'WorkflowTaskUpdate',
    sessionId: '11111111-1111-1111-1111-111111111111',
    timestamp: TIMESTAMP,
    sequenceNumber: 0,
    eventVersion: 1,
    data: {
      workflowTaskUpdate: {
        runId: RUN,
        taskId: 'review',
        label: 'Review the changes',
        status: 'running',
        attempt: 1,
        taskType: 'operation',
        operationId: 'host.harness.run',
        workerSessionId: WORKER_STEP,
      },
    },
  } as SessionEvent;

  it("folds under the task's step and writes no message", () => {
    const state = fold(frames([wire([STATUS, TOOL])], WORKER_STEP), initialRunViewState);
    expect(feed(state, WORKER_STEP)).toEqual([STATUS, TOOL]);
    expect(state.messages).toEqual([]);
    expect(state.streamingStepExecutionId).toBeNull();
  });

  it('keys the feed by the id the task row carries', () => {
    const withTask = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: taskRunning,
    });
    const state = fold(frames([wire([TOOL])], WORKER_STEP), withTask);
    const task = state.workflowRuns[RUN]?.tasks['review'];

    expect(task?.workerSessionId).toBe(WORKER_STEP);
    expect(feed(state, task?.workerSessionId ?? '')).toEqual([TOOL]);
  });

  it('keeps that id when the terminal update omits it', () => {
    const running = runViewReducer(initialRunViewState, {
      type: 'SSE_EVENT',
      event: taskRunning,
    });
    const done = runViewReducer(running, {
      type: 'SSE_EVENT',
      event: {
        ...taskRunning,
        eventId: 'task-succeeded',
        data: {
          workflowTaskUpdate: {
            runId: RUN,
            taskId: 'review',
            label: 'Review the changes',
            status: 'succeeded',
            attempt: 1,
          },
        },
      } as SessionEvent,
    });

    expect(done.workflowRuns[RUN]?.tasks['review']?.workerSessionId).toBe(WORKER_STEP);
  });
});

/**
 * The chat pins a running step's card below the transcript until the step
 * ends. The end is the step's terminal event, not a result message: a step
 * whose output is not displayed writes none, and the card would stay pinned.
 */
describe('a step that settles leaves the unsettled set', () => {
  const OTHER_STEP = '44444444-4444-4444-4444-444444444444';

  function stepEvent(
    eventType: 'StepSucceeded' | 'StepFailed',
    stepExecutionId = STEP,
    metadata: Record<string, unknown> = { operationId: 'host.harness.run' },
  ): SessionEvent {
    return {
      eventId: `${eventType}-${stepExecutionId}`,
      eventType,
      sessionId: '11111111-1111-1111-1111-111111111111',
      stepExecutionId,
      timestamp: TIMESTAMP,
      sequenceNumber: 1,
      eventVersion: 1,
      data: {},
      metadata,
    } as SessionEvent;
  }

  function settle(state: RunViewState, event: SessionEvent): RunViewState {
    return runViewReducer(state, { type: 'SSE_EVENT', event });
  }

  function unsettled(state: RunViewState): string[] {
    return unsettledHarnessSteps(state.harnessActivity, state.messages);
  }

  it('is in the set while its feed runs, and out once it succeeds', () => {
    const running = fold(frames([wire([STATUS, TOOL])]));
    expect(unsettled(running)).toEqual([STEP]);

    const done = settle(running, stepEvent('StepSucceeded'));
    expect(unsettled(done)).toEqual([]);
    expect(feed(done)).toEqual([STATUS, TOOL]);
  });

  it('leaves on a failure that ends it, not on one that retries it', () => {
    const running = fold(frames([wire([STATUS])]));

    const retrying = settle(
      running,
      stepEvent('StepFailed', STEP, { operationId: 'host.harness.run', willRetry: true }),
    );
    expect(unsettled(retrying)).toEqual([STEP]);

    const failed = settle(retrying, stepEvent('StepFailed'));
    expect(unsettled(failed)).toEqual([]);
  });

  it('two runs leave the set one at a time', () => {
    const both = fold(frames([wire([STATUS])], OTHER_STEP), fold(frames([wire([STATUS])])));
    expect(unsettled(both).sort()).toEqual([STEP, OTHER_STEP].sort());

    const first = settle(both, stepEvent('StepSucceeded'));
    expect(unsettled(first)).toEqual([OTHER_STEP]);

    const second = settle(first, stepEvent('StepSucceeded', OTHER_STEP));
    expect(unsettled(second)).toEqual([]);
  });

  it('a late frame of the same step does not put it back', () => {
    const done = settle(fold(frames([wire([STATUS])])), stepEvent('StepSucceeded'));
    const resent = fold([replay(wire([STATUS, TOOL]))], done);
    expect(unsettled(resent)).toEqual([]);
  });

  it('names its step on the displayed result, where the card folds the feed', () => {
    const running = fold(frames([wire([STATUS, TOOL])]));
    const done = settle(
      running,
      stepEvent('StepSucceeded', STEP, {
        operationId: 'host.harness.run',
        displayOutput: true,
        resolvedOutput: { kind: 'inline', value: { summary: 'The parser is fixed.' } },
      }),
    );

    expect(done.messages.map((m) => m.stepExecutionId)).toEqual([STEP]);
  });
});
