import { describe, expect, it } from 'vitest';
import { probeRehearsalApi } from './apiProbe.js';

/** A stack that serves `GET /health` at its root and answers 404 on every other path. */
function healthOnlyStack() {
  const seen: string[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    const path = url.replace('http://stack', '');
    seen.push(path);
    const served = (init?.method ?? 'GET') === 'GET' && path === '/health';
    return Promise.resolve(new Response('{}', { status: served ? 200 : 404 }));
  }) as typeof fetch;
  return { impl, seen };
}

describe('the rehearsal API probe', () => {
  it('probes the root /health route, outside /v1, and finds a stack that answers it reachable', async () => {
    const stack = healthOnlyStack();
    await expect(probeRehearsalApi('http://stack', stack.impl)).resolves.toBeNull();
    expect(stack.seen).toEqual(['/health']);
  });

  it('names the status and the route when the health route answers 404', async () => {
    const stack = healthOnlyStack();
    await expect(probeRehearsalApi('http://stack/elsewhere', stack.impl)).resolves.toBe(
      'the API at http://stack/elsewhere answered 404 on /health',
    );
  });

  it('names the transport error when nothing answers', async () => {
    const refused = (() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
      )) as typeof fetch;
    await expect(probeRehearsalApi('http://stack', refused)).resolves.toBe(
      'the API at http://stack did not answer: ECONNREFUSED',
    );
  });
});
