import { describe, it, expect } from 'vitest';

import { SessionRunner } from './FlowRunner.js';
import type { ApiClient } from './ApiClient.js';
import type { Session } from '../auth/SessionStore.js';
import type { SessionRunStatusView } from './sessionViews.js';

const SESSION: Session = {
  id: 'mcp-session',
  auth: { method: 'none' },
  createdAt: 0,
  lastActivityAt: 0,
};

const SESSION_ID = 'sess-42';
const SPACE_ID = 'space-1';

function fakeApi(status: SessionRunStatusView): ApiClient {
  return {
    get: <T>(_session: Session, _path: string): Promise<T> =>
      Promise.resolve(status as unknown as T),
    post: <T>(_session: Session, _path: string, _body?: unknown): Promise<T> =>
      Promise.resolve({ sessionId: SESSION_ID, status: 'RUNNING', eventsUrl: '' } as unknown as T),
  } as unknown as ApiClient;
}

describe('SessionRunner timeout continuation', () => {
  it('points at watch_run when the session is blocked on a workflow run', async () => {
    const runner = new SessionRunner(
      fakeApi({
        sessionId: SESSION_ID,
        status: 'PAUSED',
        blockedOn: { kind: 'workflow_run', runId: 'run-99' },
      }),
    );

    const result = await runner.run(SESSION, {
      spaceId: SPACE_ID,
      operationId: 'workflow.run.start',
      timeoutMs: 100,
    });

    expect(result.timedOutWaiting).toBe(true);
    expect(result.continuation).toEqual({
      tool: 'watch_run',
      args: { run_id: 'run-99', space_id: SPACE_ID, until: 'pause', timeout_seconds: 1 },
    });
  });

  it('points at watch_session otherwise', async () => {
    const runner = new SessionRunner(fakeApi({ sessionId: SESSION_ID, status: 'RUNNING' }));

    const result = await runner.run(SESSION, {
      spaceId: SPACE_ID,
      operationId: 'memory.store.query',
      timeoutMs: 0,
    });

    expect(result.timedOutWaiting).toBe(true);
    expect(result.continuation).toEqual({
      tool: 'watch_session',
      args: { session_id: SESSION_ID, space_id: SPACE_ID, until: 'terminal', timeout_seconds: 1 },
    });
  });
});
