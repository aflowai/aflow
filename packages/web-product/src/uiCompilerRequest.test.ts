/** Who may ask the compiler, which is the only part a route file contributes. */
import { describe, expect, it } from 'vitest';

import { handleCompileRequest } from './uiCompiler.js';
import type { RequestAuthorization } from './webIdentity.js';

const asking = (body: unknown): Request =>
  new Request('http://127.0.0.1/api/ui/compile', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const identity = (answer: RequestAuthorization) => ({
  authenticateRequest: (): Promise<RequestAuthorization> => Promise.resolve(answer),
});

describe('handleCompileRequest', () => {
  it.each([
    [{ kind: 'unauthenticated' } as const, 401],
    [{ kind: 'refused', reason: 'not on loopback' } as const, 403],
    [{ kind: 'unavailable', reason: 'no instance secret' } as const, 503],
  ])('answers %j with %i', async (answer, status) => {
    const response = await handleCompileRequest(asking({ source: 'x' }), identity(answer));
    expect(response.status).toBe(status);
  });

  it('carries the refusal reason, so the cause is not guessed from a status', async () => {
    const response = await handleCompileRequest(
      asking({ source: 'x' }),
      identity({ kind: 'refused', reason: 'not on loopback' }),
    );
    expect(await response.json()).toMatchObject({ message: 'not on loopback' });
  });

  it('compiles for an authorized caller', async () => {
    const response = await handleCompileRequest(
      asking({ source: 'export default function App() { return <div>hi</div>; }' }),
      identity({ kind: 'authorized' }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).html).toContain('<!DOCTYPE html>');
  });

  it('refuses a body with no source rather than compiling nothing', async () => {
    const response = await handleCompileRequest(asking({}), identity({ kind: 'authorized' }));
    expect(response.status).toBe(400);
  });
});
