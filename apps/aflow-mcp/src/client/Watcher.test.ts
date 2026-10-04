import { describe, it, expect } from 'vitest';

import { Watcher, type WatchHttpClient } from './Watcher.js';
import { decodeSessionCursor, seenSteps } from './sessionCursor.js';
import type { Session } from '../auth/SessionStore.js';
import type { SessionDebugResponse, SessionRunStatusView } from './sessionViews.js';

const SESSION: Session = {
  id: 'mcp-session',
  auth: { method: 'none' },
  createdAt: 0,
  lastActivityAt: 0,
};

const SESSION_ID = 'sess-1';
const SPACE_ID = 'space-1';
const RUN_ID = 'run-1';

const POLL_INTERVAL_MS = 5;
const SHORT_TIMEOUT_SECONDS = 0.05;

interface SessionState {
  status?: SessionRunStatusView | undefined;
  debug?: SessionDebugResponse | undefined;
  debugError?: boolean;
  run?: unknown;
}

/** Serves scripted per-endpoint responses; the last entry repeats. */
function fakeClient(
  states: SessionState[],
): WatchHttpClient & { polls: () => number; debugPolls: () => number } {
  let statusCalls = 0;
  let debugCalls = 0;
  let runCalls = 0;

  const pick = (index: number): SessionState => states[Math.min(index, states.length - 1)]!;

  return {
    polls: () => Math.max(statusCalls, runCalls),
    debugPolls: () => debugCalls,
    get<T>(_session: Session, path: string): Promise<T> {
      if (path.includes('/workflow-runs/')) {
        return Promise.resolve(pick(runCalls++).run as T);
      }
      if (path.includes('/debug')) {
        const state = pick(debugCalls++);
        if (state.debugError) return Promise.reject(new Error('debug unavailable'));
        return Promise.resolve(state.debug as T);
      }
      return Promise.resolve(pick(statusCalls++).status as T);
    },
  };
}

function sessionStatus(over: Partial<SessionRunStatusView> = {}): SessionRunStatusView {
  return { sessionId: SESSION_ID, status: 'RUNNING', ...over };
}

function debugWithSteps(count: number): SessionDebugResponse {
  return {
    session: { sessionId: SESSION_ID, status: 'RUNNING' },
    dynamicSteps: Array.from({ length: count }, (_, i) => ({
      stepId: `step-${String(i + 1)}`,
      status: 'SUCCEEDED',
      operation: 'ai.generate.text',
    })),
  };
}

function debugWithEntries(entries: Array<[stepId: string, status: string]>): SessionDebugResponse {
  return {
    session: { sessionId: SESSION_ID, status: 'RUNNING' },
    dynamicSteps: entries.map(([stepId, status]) => ({ stepId, status })),
  };
}

function watcher(client: WatchHttpClient): Watcher {
  return new Watcher(client, POLL_INTERVAL_MS);
}

describe('watchSession', () => {
  it('returns all steps on the first call (no cursor) and a cursor for continuation', async () => {
    const client = fakeClient([{ status: sessionStatus(), debug: debugWithSteps(2) }]);

    const result = await watcher(client).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
    });

    expect(result.done).toBe(true);
    expect(result.status).toBe('RUNNING');
    expect(result.new_steps.map((s) => s.step_id)).toEqual(['step-1', 'step-2']);
    expect(result.cursor).toBeTruthy();
    expect(result.continuation).toBeUndefined();
  });

  it('returns only steps after the cursor on the next call', async () => {
    const first = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(2) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const second = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(3) }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: first.cursor,
    });

    expect(second.done).toBe(true);
    expect(second.new_steps.map((s) => s.step_id)).toEqual(['step-3']);
  });

  it('treats an unreadable cursor as a fresh watch', async () => {
    const result = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(2) }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: 'not-a-cursor!!',
    });

    expect(result.done).toBe(true);
    expect(result.new_steps).toHaveLength(2);
  });

  it("until 'update': an in-place step-status change is re-delivered", async () => {
    const first = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithEntries([['step-1', 'RUNNING']]) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const second = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithEntries([['step-1', 'SUCCEEDED']]) }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: first.cursor,
    });

    expect(second.done).toBe(true);
    expect(second.new_steps).toEqual([{ step_id: 'step-1', status: 'SUCCEEDED' }]);
  });

  it('cursor stays valid when the debug view falls back from hot-state steps to event-derived steps', async () => {
    const first = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(2) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const eventsFallback: SessionDebugResponse = {
      session: { sessionId: SESSION_ID, status: 'RUNNING' },
      recentEvents: [
        { eventType: 'StepSucceeded', data: { stepId: 'step-2' } },
        { eventType: 'StepStarted', data: { stepId: 'step-3' } },
      ],
    };
    const second = await watcher(
      fakeClient([{ status: sessionStatus(), debug: eventsFallback }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: first.cursor,
    });

    expect(second.done).toBe(true);
    expect(second.new_steps).toEqual([{ step_id: 'step-3', status: 'RUNNING' }]);
  });

  it('fetches the debug view only at conclusion, not on every tick', async () => {
    const client = fakeClient([{ status: sessionStatus(), debug: debugWithSteps(1) }]);

    const result = await watcher(client).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'terminal',
      timeout_seconds: SHORT_TIMEOUT_SECONDS,
    });

    expect(result.done).toBe(false);
    expect(client.polls()).toBeGreaterThan(1);
    expect(client.debugPolls()).toBe(1);
  });

  it("until 'update': re-inspects steps only when the light read shows movement", async () => {
    const first = await watcher(
      fakeClient([{ status: sessionStatus({ updatedAt: 'T1' }), debug: debugWithSteps(1) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const client = fakeClient([
      { status: sessionStatus({ updatedAt: 'T1' }), debug: debugWithSteps(1) },
      { status: sessionStatus({ updatedAt: 'T1' }), debug: debugWithSteps(2) },
      { status: sessionStatus({ updatedAt: 'T2' }), debug: debugWithSteps(2) },
    ]);
    const result = await watcher(client).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: first.cursor,
      timeout_seconds: 5,
    });

    expect(result.done).toBe(true);
    expect(result.new_steps.map((s) => s.step_id)).toEqual(['step-2']);
    expect(client.polls()).toBe(3);
    expect(client.debugPolls()).toBe(2);
  });

  it("until 'update': a status change alone satisfies the watch", async () => {
    const running = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(1) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const result = await watcher(
      fakeClient([
        { status: sessionStatus(), debug: debugWithSteps(1) },
        { status: sessionStatus({ status: 'SUCCEEDED' }), debug: debugWithSteps(1) },
      ]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: running.cursor,
      timeout_seconds: 5,
    });

    expect(result.done).toBe(true);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.new_steps).toEqual([]);
  });

  it("until 'update': a status change concludes the watch even when the step read fails", async () => {
    const running = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(1) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const degraded = await watcher(
      fakeClient([{ status: sessionStatus({ status: 'WAITING_ON_CHILD' }), debugError: true }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: running.cursor,
      timeout_seconds: 5,
    });

    expect(degraded.done).toBe(true);
    expect(degraded.status).toBe('WAITING_ON_CHILD');
    expect(degraded.new_steps).toEqual([]);

    const cursor = decodeSessionCursor(degraded.cursor);
    expect(cursor?.status).toBe('WAITING_ON_CHILD');
    expect(cursor?.seen).toEqual(seenSteps([{ step_id: 'step-1', status: 'SUCCEEDED' }]));
  });

  it('a degraded-read cursor does not re-trigger the same transition but still delivers step diffs', async () => {
    const running = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(1) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const degraded = await watcher(
      fakeClient([{ status: sessionStatus({ status: 'WAITING_ON_CHILD' }), debugError: true }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: running.cursor,
      timeout_seconds: 5,
    });

    const unchanged = await watcher(
      fakeClient([{ status: sessionStatus({ status: 'WAITING_ON_CHILD' }), debugError: true }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: degraded.cursor,
      timeout_seconds: SHORT_TIMEOUT_SECONDS,
    });
    expect(unchanged.done).toBe(false);

    const recovered = await watcher(
      fakeClient([
        { status: sessionStatus({ status: 'WAITING_ON_CHILD' }), debug: debugWithSteps(2) },
      ]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      cursor: degraded.cursor,
      timeout_seconds: 5,
    });
    expect(recovered.done).toBe(true);
    expect(recovered.new_steps.map((s) => s.step_id)).toEqual(['step-2']);
  });

  it("until 'pause': resolves when the session pauses, with required_input", async () => {
    const paused = sessionStatus({
      status: 'PAUSED',
      requiredInput: {
        stepExecutionId: 'se-9',
        prompt: 'Approve?',
        missingVariables: [
          {
            variableId: 'v1',
            responseOptions: { type: 'choice', options: [{ value: 'yes' }, { value: 'no' }] },
          },
        ],
      },
    });
    const client = fakeClient([
      { status: sessionStatus(), debug: debugWithSteps(1) },
      { status: paused, debug: debugWithSteps(2) },
    ]);

    const result = await watcher(client).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'pause',
      timeout_seconds: 5,
    });

    expect(result.done).toBe(true);
    expect(result.status).toBe('PAUSED');
    expect(result.required_input).toEqual({
      step_execution_id: 'se-9',
      prompt: 'Approve?',
      response_options: { type: 'choice', options: [{ value: 'yes' }, { value: 'no' }] },
    });
  });

  it("until 'pause': a PAUSED session blocked on a workflow run does not count", async () => {
    const client = fakeClient([
      {
        status: sessionStatus({
          status: 'PAUSED',
          blockedOn: { kind: 'workflow_run', runId: RUN_ID },
        }),
        debug: debugWithSteps(1),
      },
    ]);

    const result = await watcher(client).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'pause',
      timeout_seconds: SHORT_TIMEOUT_SECONDS,
      cursor: undefined,
    });

    expect(result.done).toBe(false);
    expect(result.required_input).toBeUndefined();
  });

  it("until 'terminal': resolves on SUCCEEDED", async () => {
    const client = fakeClient([
      { status: sessionStatus({ status: 'SUCCEEDED' }), debug: debugWithSteps(2) },
    ]);

    const result = await watcher(client).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'terminal',
    });

    expect(result.done).toBe(true);
    expect(result.status).toBe('SUCCEEDED');
  });

  it("until 'terminal': an input pause still concludes the watch (cannot progress without input)", async () => {
    const client = fakeClient([
      {
        status: sessionStatus({
          status: 'PAUSED',
          requiredInput: { stepExecutionId: 'se-3' },
        }),
        debug: debugWithSteps(1),
      },
    ]);

    const result = await watcher(client).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'terminal',
    });

    expect(result.done).toBe(true);
    expect(result.status).toBe('PAUSED');
    expect(result.required_input?.step_execution_id).toBe('se-3');
  });

  it('timeout: done=false with a continuation carrying the same args plus the cursor', async () => {
    const baseline = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(1) }]),
    ).watchSession(SESSION, { session_id: SESSION_ID, space_id: SPACE_ID });

    const result = await watcher(
      fakeClient([{ status: sessionStatus(), debug: debugWithSteps(1) }]),
    ).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'update',
      timeout_seconds: SHORT_TIMEOUT_SECONDS,
      cursor: baseline.cursor,
    });

    expect(result.done).toBe(false);
    expect(result.new_steps).toEqual([]);
    expect(result.continuation).toEqual({
      tool: 'watch_session',
      args: {
        session_id: SESSION_ID,
        space_id: SPACE_ID,
        until: 'update',
        timeout_seconds: SHORT_TIMEOUT_SECONDS,
        cursor: result.cursor,
      },
    });
  });
});

describe('watchRun', () => {
  const pausedDetail = {
    run: { runId: RUN_ID, status: 'paused', pausedReason: 'waiting_human' },
    tasks: [
      { taskId: 't1', status: 'succeeded', label: 'Fetch data' },
      { taskId: 't2', status: 'waiting_human', label: 'Approve submission' },
    ],
    resumeContract: {
      suggestedResumeCall: {
        operation: 'workflow.run.resume',
        args: { runId: RUN_ID, pauseVersion: 3 },
      },
    },
  };

  it('paused run: done=true with the verbatim resume contract and task statuses', async () => {
    const client = fakeClient([{ run: pausedDetail }]);

    const result = await watcher(client).watchRun(SESSION, {
      run_id: RUN_ID,
      space_id: SPACE_ID,
    });

    expect(result.done).toBe(true);
    expect(result.run).toEqual({
      run_id: RUN_ID,
      status: 'paused',
      paused_reason: 'waiting_human',
    });
    expect(result.tasks).toEqual([
      { task_id: 't1', status: 'succeeded', label: 'Fetch data' },
      { task_id: 't2', status: 'waiting_human', label: 'Approve submission' },
    ]);
    expect(result.resume_contract).toEqual(pausedDetail.resumeContract);
    expect(result.continuation).toBeUndefined();
  });

  it('running run: times out with done=false and a continuation carrying the same args', async () => {
    const client = fakeClient([{ run: { run: { runId: RUN_ID, status: 'running' }, tasks: [] } }]);

    const result = await watcher(client).watchRun(SESSION, {
      run_id: RUN_ID,
      space_id: SPACE_ID,
      until: 'terminal',
      timeout_seconds: SHORT_TIMEOUT_SECONDS,
    });

    expect(result.done).toBe(false);
    expect(result.run.status).toBe('running');
    expect(result.continuation).toEqual({
      tool: 'watch_run',
      args: {
        run_id: RUN_ID,
        space_id: SPACE_ID,
        until: 'terminal',
        timeout_seconds: SHORT_TIMEOUT_SECONDS,
      },
    });
    expect(client.polls()).toBeGreaterThan(1);
  });

  it('terminal run: done=true without a resume contract', async () => {
    const client = fakeClient([
      {
        run: {
          run: { runId: RUN_ID, status: 'completed' },
          tasks: [{ taskId: 't1', status: 'succeeded' }],
          resumeContract: undefined,
        },
      },
    ]);

    const result = await watcher(client).watchRun(SESSION, {
      run_id: RUN_ID,
      space_id: SPACE_ID,
      until: 'terminal',
    });

    expect(result.done).toBe(true);
    expect(result.run.status).toBe('completed');
    expect(result).not.toHaveProperty('resume_contract');
  });
});
