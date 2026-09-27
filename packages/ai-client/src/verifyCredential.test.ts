import { describe, it, expect, vi } from 'vitest';
import { verifyProviderKey, isVerifiableProvider } from './verifyCredential.js';

const okFetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
const unauthorizedFetch = vi.fn(async () => ({
  ok: false,
  status: 401,
})) as unknown as typeof fetch;
const failingFetch = vi.fn(async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof fetch;

describe('verifyProviderKey', () => {
  it('marks non-verifiable providers unsupported without any network call', async () => {
    for (const providerId of ['zai', 'brave', 'ses', 'unknown']) {
      expect(isVerifiableProvider(providerId)).toBe(false);
      expect(await verifyProviderKey(providerId, { api_key: 'x' }, {}, failingFetch)).toEqual({
        supported: false,
      });
    }
  });

  it('returns ok on a 200 probe', async () => {
    const outcome = await verifyProviderKey('openai', { api_key: 'sk-x' }, {}, okFetch);
    expect(outcome).toEqual({ supported: true, ok: true });
  });

  it('maps 401 to a rejected-key error', async () => {
    const outcome = await verifyProviderKey('anthropic', { api_key: 'bad' }, {}, unauthorizedFetch);
    expect(outcome).toMatchObject({ supported: true, ok: false, errorCode: '401' });
  });

  it('maps network failures to network_error', async () => {
    const outcome = await verifyProviderKey('fireworks', { api_key: 'fw' }, {}, failingFetch);
    expect(outcome).toMatchObject({ supported: true, ok: false, errorCode: 'network_error' });
  });

  it('sends the google key as a query param, not a header', async () => {
    const seen: string[] = [];
    const spyFetch = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    await verifyProviderKey('google', { api_key: 'g-key' }, {}, spyFetch);
    expect(seen[0]).toContain('key=g-key');
  });
});
