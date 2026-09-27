import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import type { ProviderConfig } from '../types.js';
import { AIClientError } from '../errors.js';

const safeFetch = vi.fn();

vi.mock('@aflow/network-safety', async () => {
  const actual =
    await vi.importActual<typeof import('@aflow/network-safety')>('@aflow/network-safety');
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => safeFetch(...args),
    validateCredentialedUrl: async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:') {
        throw new actual.SsrfBlockedError(
          `Blocked: credentialed request requires https (got ${url.protocol})`,
          rawUrl,
          { kind: 'invalid-protocol' },
        );
      }
      return { url, resolvedHost: { hostname: url.hostname, ip: '203.0.113.7', family: 4 } };
    },
  };
});

const { createGoogleVideoAdapter } = await import('./googleVideo.js');

const CONFIG: ProviderConfig = { apiKey: 'test-key' };

function adapterFor(response: Record<string, unknown>) {
  const client = {
    operations: {
      getVideosOperation: vi.fn().mockResolvedValue({ done: true, response }),
    },
  } as unknown as GoogleGenAI;
  return createGoogleVideoAdapter(client, CONFIG);
}

function pollRequest() {
  return { handle: { providerJobId: 'operations/abc' }, model: 'veo-3.0-generate-001' };
}

beforeEach(() => {
  safeFetch.mockReset();
});

describe('pollVideoJob video retrieval', () => {
  it('returns inline bytes when the response carries videoBytes', async () => {
    const adapter = adapterFor({
      generatedVideos: [{ video: { videoBytes: 'aW5saW5l', mimeType: 'video/mp4' } }],
    });

    const poll = await adapter.pollVideoJob({ ...pollRequest(), durationSeconds: 8 });

    expect(poll.status).toBe('succeeded');
    if (poll.status !== 'succeeded') throw new Error('unreachable');
    expect(poll.response.videos).toEqual([
      { data: 'aW5saW5l', mimeType: 'video/mp4', durationSeconds: 8 },
    ]);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('fetches the bytes when the response carries only a uri', async () => {
    safeFetch.mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    );
    const adapter = adapterFor({
      generatedVideos: [
        {
          video: {
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media',
          },
        },
      ],
    });

    const poll = await adapter.pollVideoJob({ ...pollRequest(), durationSeconds: 8 });

    expect(poll.status).toBe('succeeded');
    if (poll.status !== 'succeeded') throw new Error('unreachable');
    expect(poll.response.videos).toEqual([
      {
        data: Buffer.from([0, 1, 2, 3]).toString('base64'),
        mimeType: 'video/mp4',
        durationSeconds: 8,
      },
    ]);
  });

  it('sends the api key and pins the host to the provider that issued it', async () => {
    safeFetch.mockResolvedValue(new Response(new Uint8Array([9]), { status: 200 }));
    const adapter = adapterFor({
      generatedVideos: [
        { video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/xyz:download' } },
      ],
    });

    await adapter.pollVideoJob(pollRequest());

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [, init] = safeFetch.mock.calls[0] as [URL, Record<string, unknown>];
    expect(init['allowedHosts']).toEqual(['generativelanguage.googleapis.com']);
    expect(init['headers']).toMatchObject({ 'x-goog-api-key': 'test-key' });
  });

  it('names the retrieval failure rather than reporting no video', async () => {
    safeFetch.mockResolvedValue(new Response('nope', { status: 404 }));
    const adapter = adapterFor({
      generatedVideos: [
        { video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/xyz:download' } },
      ],
    });

    await expect(adapter.pollVideoJob(pollRequest())).rejects.toThrow(/files\/xyz:download.*404/s);
    await expect(adapter.pollVideoJob(pollRequest())).rejects.not.toThrow(/returned no video/);
  });

  it('refuses a uri that is not the provider host', async () => {
    const adapter = adapterFor({
      generatedVideos: [{ video: { uri: 'http://169.254.169.254/latest/meta-data' } }],
    });

    await expect(adapter.pollVideoJob(pollRequest())).rejects.toBeInstanceOf(AIClientError);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('still reports no video when the response carries neither bytes nor a uri', async () => {
    const adapter = adapterFor({ generatedVideos: [{ video: { mimeType: 'video/mp4' } }] });

    const poll = await adapter.pollVideoJob(pollRequest());

    expect(poll).toEqual({
      status: 'failed',
      message: 'Veo completed the render but returned no video',
    });
  });
});

describe('a stored render answered with a redirect', () => {
  const STORED = 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media';
  const STORAGE = 'https://storage.googleapis.com/veo/abc.mp4?sig=x';

  function storedAdapter() {
    return adapterFor({ generatedVideos: [{ video: { uri: STORED } }] });
  }

  it('follows the location, and does not carry the key to it', async () => {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    const answers = [
      new Response(null, { status: 302, headers: { location: STORAGE } }),
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    ];
    safeFetch.mockImplementation((url: unknown, init: unknown) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      seen.push({ url: String(url), key: headers.get('x-goog-api-key') ?? undefined });
      return Promise.resolve(answers.shift());
    });

    const poll = await storedAdapter().pollVideoJob(pollRequest());
    expect(poll.status).toBe('succeeded');

    expect(seen).toHaveLength(2);
    // The credential authenticates to the api host and stops there. A redirect
    // target is named by the remote and carries its own authorization.
    expect(seen[0]?.key).toBe('test-key');
    expect(seen[1]?.url).toBe(STORAGE);
    expect(seen[1]?.key).toBeUndefined();
  });

  it('refuses a redirect that names nowhere to read', async () => {
    safeFetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(storedAdapter().pollVideoJob(pollRequest())).rejects.toThrow(/naming nowhere/);
  });
});
