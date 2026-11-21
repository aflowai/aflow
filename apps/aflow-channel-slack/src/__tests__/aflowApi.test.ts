/**
 * A resolve that fails may still have been applied. Only a failure that proves
 * no connection was made says the request never reached Aflow.
 */
import { describe, expect, it } from 'vitest';

import { createAflowApi, isHelmsmanRoot, neverConnected } from '../aflowApi.js';

function connectError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:3000`), { code });
}

/** The shape `fetch` throws for a socket error: a TypeError whose cause holds the code. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function resolveWith(fetchImpl: typeof fetch) {
  const api = createAflowApi({ apiUrl: 'http://127.0.0.1:3000', apiKey: 'key', fetchImpl });
  return api.resolveItem('space-1', 'step:1', { type: 'step' }, { kind: 'approve' });
}

function answering(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function throwing(error: unknown): typeof fetch {
  return () => Promise.reject(error);
}

describe('a resolve that fails', () => {
  it('reached nothing when the connection was refused before the request left', async () => {
    const answer = await resolveWith(throwing(fetchFailed(connectError('ECONNREFUSED'))));
    expect(answer).toMatchObject({ ok: false, status: 0, retryable: true, outcomeUnknown: false });
  });

  it('reached nothing when every address refused the connection', async () => {
    const cause = new AggregateError([connectError('ECONNREFUSED'), connectError('EHOSTUNREACH')]);
    expect(neverConnected(fetchFailed(cause))).toBe(true);
    const mixed = new AggregateError([connectError('ECONNREFUSED'), connectError('ECONNRESET')]);
    expect(neverConnected(fetchFailed(mixed))).toBe(false);
  });

  it('may have reached Aflow after a timeout, since the request may have left', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const answer = await resolveWith(throwing(timeout));
    expect(answer).toMatchObject({ ok: false, status: 0, retryable: true, outcomeUnknown: true });
  });

  it('may have reached Aflow after a connection reset mid-request', async () => {
    const answer = await resolveWith(throwing(fetchFailed(connectError('ECONNRESET'))));
    expect(answer).toMatchObject({ retryable: true, outcomeUnknown: true });
  });

  it('may have been applied when Aflow answers 500 DISPATCH_FAILED', async () => {
    const answer = await resolveWith(
      answering(500, { error: 'DISPATCH_FAILED', message: 'The resume could not be dispatched.' }),
    );
    expect(answer).toMatchObject({
      ok: false,
      status: 500,
      error: 'DISPATCH_FAILED',
      retryable: true,
      outcomeUnknown: true,
    });
  });

  it('was not applied when Aflow answers 429 or a refusal', async () => {
    expect(await resolveWith(answering(429, { error: 'RATE_LIMITED' }))).toMatchObject({
      retryable: true,
      outcomeUnknown: false,
    });
    expect(await resolveWith(answering(422, { error: 'INVALID_RESOLUTION' }))).toMatchObject({
      retryable: false,
      outcomeUnknown: false,
    });
  });
});

describe('the reads a send makes', () => {
  const helmsman = { kind: 'platform-role', systemRole: 'cybernetic-helmsman' };

  it('reads the session in its space, and calls only a Helmsman no session delegated a root', async () => {
    const urls: string[] = [];
    const api = createAflowApi({
      apiUrl: 'http://127.0.0.1:3000',
      apiKey: 'key',
      fetchImpl: (url) => {
        urls.push(String(url));
        return Promise.resolve(Response.json({ sessionId: 'session-1', target: helmsman }));
      },
    });

    expect(await api.readSession('space-1', 'session-1')).toEqual({ ok: true, helmsmanRoot: true });
    expect(urls).toEqual(['http://127.0.0.1:3000/v1/sessions/session-1?spaceId=space-1']);
  });

  it.each([
    ['a Helmsman conversation', { target: helmsman }, true],
    ['a Helmsman another session delegated', { target: helmsman, parentSessionId: 's-0' }, false],
    ['a custom agent', { target: { kind: 'custom-agent', agentId: 'a-1' } }, false],
    ['another platform role', { target: { kind: 'platform-role', systemRole: 'runner' } }, false],
    ['a session with no target', {}, false],
  ])('tells whether %s is a Helmsman root session', (_case, details, root) => {
    expect(isHelmsmanRoot(details)).toBe(root);
  });

  it('reads the space’s name, and refuses a space with none', async () => {
    const named = createAflowApi({
      apiUrl: 'http://127.0.0.1:3000',
      apiKey: 'key',
      fetchImpl: answering(200, { id: 'space-1', name: ' Trading Joe ' }),
    });
    const nameless = createAflowApi({
      apiUrl: 'http://127.0.0.1:3000',
      apiKey: 'key',
      fetchImpl: answering(200, { id: 'space-1' }),
    });

    expect(await named.spaceName('space-1')).toEqual({ ok: true, name: 'Trading Joe' });
    expect(await nameless.spaceName('space-1')).toMatchObject({ ok: false, retryable: false });
  });
});
