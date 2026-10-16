import { afterEach, describe, expect, it, vi } from 'vitest';
import { localRuntimeClient } from './ollamaRuntime.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('localRuntimeClient', () => {
  it('reports what the runtime holds, with each model’s size as loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: 'gemma4:26b',
                  size: 22_677_887_340,
                  context_length: 32_768,
                  expires_at: 'x',
                },
              ],
            }),
          ),
      ),
    );
    expect(await localRuntimeClient({}).loaded()).toEqual([
      { tag: 'gemma4:26b', sizeBytes: 22_677_887_340, contextLength: 32_768, expiresAt: 'x' },
    ]);
  });

  it('answers null, not an empty list, when the runtime does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await localRuntimeClient({}).loaded()).toBeNull();
  });

  it('loads at the window requests will use, and unloads by asking to keep nothing', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{}');
      }),
    );
    const client = localRuntimeClient({ keepAlive: '30m' });
    await client.warm('gemma4:26b', 32_768);
    await client.unload('gemma4:26b');
    expect(bodies).toEqual([
      { model: 'gemma4:26b', keep_alive: '30m', options: { num_ctx: 32_768 } },
      { model: 'gemma4:26b', keep_alive: 0 },
    ]);
  });
});
