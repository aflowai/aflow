import { describe, expect, it } from 'vitest';

import type { Session } from '../auth/SessionStore.js';
import { inspectSession } from './sessionInspection.js';
import { Watcher } from './Watcher.js';
import type { SessionDebugResponse, SessionRunStatusView } from './sessionViews.js';

const SESSION: Session = {
  id: 'mcp-session',
  auth: { method: 'none' },
  createdAt: 0,
  lastActivityAt: 0,
};
const SESSION_ID = 'sess-failed';
const SPACE_ID = 'space-1';
const STORED_ERROR_REF = 'gs://payloads/tenants/t1/errors/agent-turn.json';

/** What the provider said, as the executor stored it. */
const STORED_ERROR = {
  code: 'PROVIDER_ERROR',
  message: 'Anthropic refused the request: credit balance is too low.',
  classification: 'provider',
  retryable: false,
  details: {
    provider: 'anthropic',
    providerErrorCode: 'invalid_request_error',
    providerRequestId: 'req_example_1',
    providerMessage: 'Your credit balance is too low to access the Anthropic API.',
  },
  stack: 'Error: at adapter (provider.ts:1)',
  timestamp: '2026-10-01T10:00:00.000Z',
};

/**
 * A session that failed on its model provider: the failure event carries the
 * sentence shown to a person, the stored error carries the provider's own.
 */
function failedDebug(): SessionDebugResponse {
  return {
    session: { sessionId: SESSION_ID, status: 'FAILED', errorRef: STORED_ERROR_REF },
    hotState: 'present',
    stepEvents: { read: 40, complete: true },
    dynamicSteps: [
      {
        stepId: 'dynamic_browser_page_open_1',
        operation: 'browser.page.open',
        status: 'SUCCEEDED',
      },
    ],
    currentStep: {
      stepExecutionId: 'exec-turn-7',
      stepId: 'agent-turn',
      operationId: 'ai.agent.turn',
      status: 'FAILED',
      errorRef: STORED_ERROR_REF,
    },
    recentEvents: [
      {
        eventType: 'SessionFailed',
        stepExecutionId: 'exec-turn-7',
        data: { stepId: 'agent-turn', errorRef: STORED_ERROR_REF },
        metadata: {
          stepName: 'Agent turn',
          operationId: 'ai.agent.turn',
          errorCode: 'PROVIDER_ERROR',
          errorMessage: 'The model provider could not complete the request.',
          errorClassification: 'provider',
        },
      },
    ],
  };
}

function client(debug: SessionDebugResponse, status?: SessionRunStatusView) {
  const reads: string[] = [];
  return {
    reads,
    get: <T>(_session: Session, path: string): Promise<T> => {
      reads.push(path);
      if (path.startsWith('/v1/payloads')) return Promise.resolve(STORED_ERROR as T);
      if (path.includes('/debug')) return Promise.resolve(debug as T);
      if (status) return Promise.resolve(status as T);
      return Promise.reject(new Error(`unexpected read ${path}`));
    },
  };
}

const EXPECTED_FAILURE = {
  step_id: 'agent-turn',
  step_execution_id: 'exec-turn-7',
  operation: 'ai.agent.turn',
  step_name: 'Agent turn',
  code: 'PROVIDER_ERROR',
  message: 'Anthropic refused the request: credit balance is too low.',
  classification: 'provider',
  retryable: false,
  provider: {
    provider: 'anthropic',
    error_code: 'invalid_request_error',
    request_id: 'req_example_1',
    message: 'Your credit balance is too low to access the Anthropic API.',
  },
  error_ref: STORED_ERROR_REF,
};

describe('a failed session', () => {
  it('inspect_session resolves the failing step and its stored error', async () => {
    const api = client(failedDebug());

    const result = await inspectSession(api, SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
    });

    expect(result.status).toBe('FAILED');
    expect(result.failure).toMatchObject(EXPECTED_FAILURE);
    expect(result.failure?.next).toContain('retry_session');
    expect(JSON.stringify(result)).not.toContain('provider.ts');
    expect(api.reads).toContain(
      `/v1/payloads?ref=${encodeURIComponent(STORED_ERROR_REF)}&spaceId=${SPACE_ID}`,
    );
  });

  it('decodes an inline stored error without a read', async () => {
    const inline = `inline:${Buffer.from(JSON.stringify(STORED_ERROR)).toString('base64')}`;
    const debug = failedDebug();
    debug.session.errorRef = inline;
    debug.recentEvents = [];
    delete debug.currentStep;
    const api = client(debug);

    const result = await inspectSession(api, SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
    });

    expect(result.failure?.message).toBe(STORED_ERROR.message);
    expect(result.failure?.provider?.provider).toBe('anthropic');
    expect(api.reads.some((p) => p.startsWith('/v1/payloads'))).toBe(false);
  });

  it('says what could not be read rather than reporting nothing', async () => {
    const result = await inspectSession(
      client({
        session: { sessionId: SESSION_ID, status: 'FAILED' },
        hotState: 'expired',
        recentEvents: [],
      }),
      SESSION,
      { session_id: SESSION_ID, space_id: SPACE_ID },
    );

    expect(result.failure?.message).toBe(
      'The session failed, but no failure event is among its 0 newest events, and neither the ' +
        'session nor a failed step names a stored error; its hot state has expired.',
    );
  });

  it('watch_session ending FAILED carries the same failure', async () => {
    const api = client(failedDebug(), { sessionId: SESSION_ID, status: 'FAILED' });

    const result = await new Watcher(api, 5).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'terminal',
    });

    expect(result.done).toBe(true);
    expect(result.failure).toMatchObject(EXPECTED_FAILURE);
  });

  it('watch_session reports what the status read said when nothing else can be read', async () => {
    const api = {
      get: <T>(_session: Session, path: string): Promise<T> => {
        if (path.includes('/debug')) return Promise.reject(new Error('debug unavailable'));
        const status: SessionRunStatusView = {
          sessionId: SESSION_ID,
          status: 'FAILED',
          error: { code: 'INPUT_INVALID', message: 'The agent input is missing `prompt`.' },
        };
        return Promise.resolve(status as T);
      },
    };

    const result = await new Watcher(api, 5).watchSession(SESSION, {
      session_id: SESSION_ID,
      space_id: SPACE_ID,
      until: 'terminal',
    });

    expect(result.failure?.message).toBe('The agent input is missing `prompt`.');
    expect(result.failure?.code).toBe('INPUT_INVALID');
  });
});
