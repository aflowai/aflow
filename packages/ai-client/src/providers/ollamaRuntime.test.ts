import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localRuntimeClient,
  servesWithoutLoading,
  type LoadedLocalModel,
} from './ollamaRuntime.js';

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
      {
        tag: 'gemma4:26b',
        sizeBytes: 22_677_887_340,
        contextLength: 32_768,
        expiresAt: 'x',
        runner: null,
        gpuBytes: null,
      },
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

describe('downloads', () => {
  it('fails a pull whose stream ends without the runtime saying it succeeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`${JSON.stringify({ status: 'pulling 48eb98ec' })}\n`)),
    );
    await expect(
      localRuntimeClient({}).pull('gemma4:26b', () => undefined, new AbortController().signal),
    ).rejects.toThrow('stopped before it finished');
  });

  it('reports a pull line by line as the runtime streams it, and fails on an error line', async () => {
    const lines = [
      { status: 'pulling manifest' },
      { status: 'pulling 48eb98ec', completed: 1_000, total: 16_000 },
      { error: 'max retries exceeded' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')),
    );
    const progress: unknown[] = [];

    await expect(
      localRuntimeClient({}).pull(
        'gemma4:26b',
        (p) => progress.push(p),
        new AbortController().signal,
      ),
    ).rejects.toThrow('max retries exceeded');
    expect(progress).toEqual([
      { status: 'pulling manifest', completedBytes: 0, totalBytes: null },
      { status: 'pulling 48eb98ec', completedBytes: 1_000, totalBytes: 16_000 },
    ]);
  });

  it('lists what is downloaded, marking a model the runtime forwards to its cloud', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                { name: 'gemma4:26b', size: 16, digest: 'abc' },
                { name: 'gpt-oss:120b-cloud', size: 1, digest: 'def', remote_host: 'ollama.com' },
              ],
            }),
          ),
      ),
    );

    expect(await localRuntimeClient({}).installed()).toEqual([
      { tag: 'gemma4:26b', sizeBytes: 16, digest: 'abc', remoteHost: null },
      { tag: 'gpt-oss:120b-cloud', sizeBytes: 1, digest: 'def', remoteHost: 'ollama.com' },
    ]);
  });
});

describe('servesWithoutLoading', () => {
  const held = (runner: string, contextLength: number): LoadedLocalModel => ({
    tag: 'qwen3.5:9b',
    sizeBytes: 1,
    contextLength,
    expiresAt: null,
    runner,
    gpuBytes: null,
  });

  it('is false when the model is not loaded', () => {
    expect(servesWithoutLoading([], 'qwen3.5:9b', 32_768)).toBe(false);
  });

  it('is true for a llama.cpp model only at the window it holds, since another window reloads it', () => {
    expect(servesWithoutLoading([held('llamacpp', 32_768)], 'qwen3.5:9b', 32_768)).toBe(true);
    expect(servesWithoutLoading([held('llamacpp', 8_192)], 'qwen3.5:9b', 32_768)).toBe(false);
  });

  it('is true for an MLX model at any window, since that runner never reloads for one', () => {
    expect(servesWithoutLoading([held('mlx', 8_192)], 'qwen3.5:9b', 32_768)).toBe(true);
  });

  it('reads a tag without a version as :latest', () => {
    const latest = { ...held('mlx', 1), tag: 'gemma4:latest' };
    expect(servesWithoutLoading([latest], 'gemma4', 32_768)).toBe(true);
  });
});
