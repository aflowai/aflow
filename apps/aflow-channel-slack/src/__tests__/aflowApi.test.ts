/**
 * A resolve that fails may still have been applied. Only a failure that proves
 * no connection was made says the request never reached Aflow.
 */
import { describe, expect, it } from 'vitest';

import { createAflowApi, neverConnected } from '../aflowApi.js';

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
