import { describe, expect, it } from 'vitest';

import type { Session } from '../auth/SessionStore.js';
import type { PayloadReadClient } from './payloads.js';
import {
  CONTROL_STEP_OPERATION,
  DEFAULT_INSPECT_LAST_N_STEPS,
  inspectSession,
  type InspectSessionArgs,
} from './sessionInspection.js';
import type { DebugStepEntry, SessionDebugResponse } from './sessionViews.js';

const SESSION: Session = {
  id: 'mcp-session',
  auth: { method: 'none' },
  createdAt: 0,
  lastActivityAt: 0,
};
const SESSION_ID = 'sess-long';
const SPACE_ID = 'space-1';

function client(debug: SessionDebugResponse): PayloadReadClient {
  return {
    get: <T>(_session: Session, path: string): Promise<T> => {
      if (path.includes('/debug')) return Promise.resolve(debug as T);
      return Promise.reject(new Error(`unexpected read ${path}`));
    },
  };
}

/**
 * A conversation thirty rounds in: 300 steps, every tool step behind an
 * `agent.control.run_step` wrapper, two tool steps failed along the way and the
 * newest still running.
 */
function longConversation(): SessionDebugResponse {
  const dynamicSteps: DebugStepEntry[] = [];
  for (let i = 0; i < 150; i++) {
    dynamicSteps.push({
      stepId: `run_step_${String(i)}`,
      operation: CONTROL_STEP_OPERATION,
      status: 'SUCCEEDED',
    });
    const operation = i % 2 === 0 ? 'browser.page.open' : 'memory.store.query';
    const status = i === 149 ? 'RUNNING' : i === 40 || i === 90 ? 'FAILED' : 'SUCCEEDED';
    dynamicSteps.push({
      stepId: `dynamic_tool_${String(i)}`,
      operation,
      status,
      ...(status === 'FAILED' ? { error: { message: 'page refused' } } : {}),
    });
  }
  return {
    session: {
      sessionId: SESSION_ID,
      status: 'RUNNING',
      target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
    },
    dynamicSteps,
    stepEvents: { read: 900, complete: true },
    hotState: 'present',
    recentEvents: [
      {
        eventType: 'StepSucceeded',
        metadata: { agentMessage: 'Opened the page; reading it now.' },
        timestamp: '2026-10-01T10:00:00.000Z',
      },
    ],
  };
}

function inspect(debug: SessionDebugResponse, args: Partial<InspectSessionArgs> = {}) {
  return inspectSession(client(debug), SESSION, {
    session_id: SESSION_ID,
    space_id: SPACE_ID,
    ...args,
  });
}

describe('inspect_session on a long conversation', () => {
  it('returns the newest few tool steps by default, and a census of the rest', async () => {
    const result = await inspect(longConversation());

    expect(result.steps).toHaveLength(DEFAULT_INSPECT_LAST_N_STEPS);
    expect(result.steps.at(-1)).toEqual({
      step_id: 'dynamic_tool_149',
      operation: 'memory.store.query',
      status: 'RUNNING',
    });
    expect(result.steps.every((s) => s.operation !== CONTROL_STEP_OPERATION)).toBe(true);
    expect(result.census).toEqual({
      total: 300,
      shown: 10,
      left_out: [
        {
          count: 140,
          by_status: { SUCCEEDED: 138, FAILED: 2 },
          why: 'older than the last 10 that match',
          returned_by: 'last_n_steps: 150',
        },
        {
          count: 150,
          by_status: { SUCCEEDED: 150 },
          why: `${CONTROL_STEP_OPERATION} wrappers, which carry nothing of their own`,
          returned_by: 'include_control_steps: true',
        },
      ],
    });
  });

  it('stays small however long the conversation runs', async () => {
    const result = await inspect(longConversation());

    expect(JSON.stringify(result).length).toBeLessThan(5_000);
  });

  it("carries the agent's latest reply", async () => {
    const result = await inspect(longConversation());

    expect(result.latest_reply).toEqual({
      message: 'Opened the page; reading it now.',
      at: '2026-10-01T10:00:00.000Z',
    });
  });

  it('returns the control-step wrappers only when asked', async () => {
    const result = await inspect(longConversation(), {
      include_control_steps: true,
      last_n_steps: 4,
    });

    expect(result.steps.map((s) => s.step_id)).toEqual([
      'run_step_148',
      'dynamic_tool_148',
      'run_step_149',
      'dynamic_tool_149',
    ]);
    expect(result.census?.left_out.map((g) => g.returned_by)).toEqual(['last_n_steps: 300']);
  });

  it('filters by status, and counts what the filter left out', async () => {
    const result = await inspect(longConversation(), { status: ['failed'] });

    expect(result.steps.map((s) => s.step_id)).toEqual(['dynamic_tool_40', 'dynamic_tool_90']);
    expect(result.steps[0]?.error).toBe('page refused');
    expect(result.census?.left_out).toContainEqual({
      count: 148,
      by_status: { SUCCEEDED: 147, RUNNING: 1 },
      why: 'not in status FAILED',
      returned_by: 'status (leave it out)',
    });
  });

  it('filters by operation', async () => {
    const result = await inspect(longConversation(), {
      operation: ['browser.page.open'],
      last_n_steps: 100,
    });

    expect(result.steps).toHaveLength(75);
    expect(result.steps.every((s) => s.operation === 'browser.page.open')).toBe(true);
    expect(result.census?.left_out).toContainEqual(
      expect.objectContaining({ count: 75, returned_by: 'operation (leave it out)' }),
    );
  });

  it('returns only what is new since the cursor it handed back', async () => {
    const first = await inspect(longConversation());

    const moved = longConversation();
    const running = moved.dynamicSteps?.find((s) => s.stepId === 'dynamic_tool_149');
    if (running) running.status = 'SUCCEEDED';
    moved.dynamicSteps?.push({
      stepId: 'dynamic_tool_150',
      operation: 'browser.page.open',
      status: 'RUNNING',
    });

    const second = await inspect(moved, { cursor: first.cursor });

    expect(second.steps.map((s) => [s.step_id, s.status])).toEqual([
      ['dynamic_tool_149', 'SUCCEEDED'],
      ['dynamic_tool_150', 'RUNNING'],
    ]);
    expect(second.census?.left_out).toContainEqual(
      expect.objectContaining({ count: 299, returned_by: 'cursor (leave it out)' }),
    );
  });

  it('hands back a cursor far smaller than the step ids it covers', async () => {
    const result = await inspect(longConversation());

    expect(result.cursor.length).toBeLessThan(300 * 7);
  });

  it('says a status could not be read rather than calling it unknown', async () => {
    const debug = longConversation();
    debug.stepEvents = { read: 10_000, complete: false };
    const first = debug.dynamicSteps?.[1];
    if (first) delete first.status;

    const result = await inspect(debug, { status: ['NOT_READ'] });

    expect(result.steps).toEqual([
      { step_id: 'dynamic_tool_0', operation: 'browser.page.open', status: 'NOT_READ' },
    ]);
    expect(result.step_state).toContain('further back than the 10000 events read');
    expect(JSON.stringify(result)).not.toContain('unknown');
  });

  it('says the hot state has expired when the steps come from events alone', async () => {
    const result = await inspect({
      session: { sessionId: SESSION_ID, status: 'SUCCEEDED' },
      hotState: 'expired',
      recentEvents: [
        {
          eventType: 'StepSucceeded',
          data: { stepId: 'agent-turn' },
          metadata: { operationId: 'ai.agent.turn' },
        },
      ],
    });

    expect(result.steps).toEqual([
      { step_id: 'agent-turn', operation: 'ai.agent.turn', status: 'SUCCEEDED' },
    ]);
    expect(result.step_state).toContain('hot state has expired');
  });
});

describe('inspect_session on a paused session', () => {
  it('carries the question the agent is waiting on and how to answer it', async () => {
    const result = await inspect({
      session: {
        sessionId: SESSION_ID,
        status: 'PAUSED',
        requiredInput: { stepExecutionId: 'exec-pause' },
      },
      recentEvents: [
        { eventType: 'StepPaused', metadata: { agentMessage: 'Which profile should I use?' } },
      ],
    });

    expect(result.pending_question).toEqual({
      step_execution_id: 'exec-pause',
      prompt: 'Which profile should I use?',
      resume_with: `start_session with conversation_id "${SESSION_ID}", the same space_id, and input`,
    });
    expect(result.latest_reply).toBeUndefined();
  });
});
