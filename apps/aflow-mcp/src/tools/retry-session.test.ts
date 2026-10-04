import { describe, expect, it } from 'vitest';

import { ApiError } from '../client/ApiClient.js';
import type { Session } from '../auth/SessionStore.js';
import { retrySession } from './retry-session.js';

const SESSION: Session = {
  id: 'mcp-session',
  auth: { method: 'none' },
  createdAt: 0,
  lastActivityAt: 0,
};
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const SPACE_ID = '66666666-7777-4888-8999-000000000000';

function parsed(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('retry_session', () => {
  it('calls the route the web UI’s Retry calls, and says how to follow the retry', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const result = await retrySession(
      {
        post: <T>(_session: Session, path: string, body?: unknown): Promise<T> => {
          posts.push({ path, body });
          return Promise.resolve({ status: 'RUNNING', retryCount: 1, traceId: 'trace-1' } as T);
        },
      },
      SESSION,
      SESSION_ID,
      SPACE_ID,
    );

    expect(posts).toEqual([
      { path: `/v1/sessions/${SESSION_ID}/retry?spaceId=${SPACE_ID}`, body: {} },
    ]);
    expect(result.isError).toBeUndefined();
    expect(parsed(result)['data']).toEqual({
      session_id: SESSION_ID,
      status: 'RUNNING',
      retry_count: 1,
      continuation: {
        tool: 'watch_session',
        args: { session_id: SESSION_ID, space_id: SPACE_ID, until: 'terminal' },
      },
    });
  });

  it('passes the route’s own refusal through when the session is not failed', async () => {
    const refusal = `Run ${SESSION_ID} is not failed (current status: RUNNING)`;
    const result = await retrySession(
      {
        post: () =>
          Promise.reject(
            new ApiError(
              409,
              JSON.stringify({ error: 'Conflict', message: refusal }),
              `/v1/sessions/${SESSION_ID}/retry`,
            ),
          ),
      },
      SESSION,
      SESSION_ID,
      SPACE_ID,
    );

    expect(result.isError).toBe(true);
    expect(parsed(result)['error']).toEqual({
      code: 'RETRY_REFUSED',
      message: refusal,
      hint: 'Only a FAILED session can be retried; inspect_session shows its status.',
    });
  });
});
