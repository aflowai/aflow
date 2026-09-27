import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  generatePkce,
  generateStateToken,
  parseStateToken,
  postToTokenEndpoint,
} from './tokenManager.js';
import { resolveOAuthOwner } from './resolver.js';

describe('generatePkce', () => {
  it('produces a verifier with 43+ characters (RFC 7636 §4.1)', () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('verifier uses the allowed alphabet (RFC 7636 — unreserved + - _ . ~)', () => {
    const { verifier } = generatePkce();
    // base64url is a subset of the allowed set
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('challenge is the S256 hash of verifier, base64url-encoded', () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('each invocation yields fresh entropy', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('generateStateToken / parseStateToken', () => {
  it('round-trips a tenantId through state token', () => {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const state = generateStateToken(tenantId);
    const parsed = parseStateToken(state);
    expect(parsed).not.toBeNull();
    expect(parsed!.tenantId).toBe(tenantId);
  });

  it('token has form {tenantBase64}.{randomBase64}', () => {
    const state = generateStateToken('tenant-1');
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('random portion has ≥256 bits of entropy', () => {
    const state = generateStateToken('tenant-1');
    const randomPart = state.split('.')[1]!;
    // base64url-encoded 32 bytes = 43 chars (no padding)
    expect(randomPart.length).toBeGreaterThanOrEqual(43);
  });

  it('two invocations for the same tenant yield distinct random parts', () => {
    const a = generateStateToken('tenant-1');
    const b = generateStateToken('tenant-1');
    expect(a).not.toBe(b);
    expect(parseStateToken(a)!.randomPart).not.toBe(parseStateToken(b)!.randomPart);
  });

  it('parseStateToken rejects missing dot separator', () => {
    expect(parseStateToken('nodothere')).toBeNull();
  });

  it('parseStateToken rejects empty tenant part', () => {
    expect(parseStateToken('.suffix')).toBeNull();
  });

  it('parseStateToken rejects empty random part', () => {
    expect(parseStateToken('prefix.')).toBeNull();
  });

  it('parseStateToken rejects invalid base64url chars', () => {
    expect(parseStateToken('not!base.url@chars')).toBeNull();
  });

  it('parseStateToken handles tenantIds with special chars (UUIDs)', () => {
    const tenant = 'tenant-with-dashes-and-numbers-123';
    const state = generateStateToken(tenant);
    expect(parseStateToken(state)!.tenantId).toBe(tenant);
  });
});

describe('resolveOAuthOwner (pinned identity, no fallback)', () => {
  const ctx = { userId: 'user-1', spaceId: 'space-1', tenantId: 'tenant-1' };

  it('user scope pins the userId', () => {
    expect(resolveOAuthOwner('user', ctx)).toEqual({ ownerId: 'user-1' });
  });

  it('space scope pins the spaceId (never the user)', () => {
    expect(resolveOAuthOwner('space', ctx)).toEqual({ ownerId: 'space-1' });
  });

  it('user scope without a user identity needs consent (no fallback to space)', () => {
    expect(resolveOAuthOwner('user', { spaceId: 'space-1', tenantId: 'tenant-1' })).toEqual({
      needsConsent: 'no_user_identity',
    });
  });

  it('space scope resolves even when userId is absent (no precedence walk)', () => {
    expect(resolveOAuthOwner('space', { spaceId: 'space-1', tenantId: 'tenant-1' })).toEqual({
      ownerId: 'space-1',
    });
  });
});

describe('postToTokenEndpoint SSRF guard', () => {
  function trackingFetch(
    calls: Array<{ url: string; init: RequestInit | undefined }>,
    response: () => Response,
  ): typeof fetch {
    return (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, init });
      return response();
    }) as unknown as typeof fetch;
  }

  function post(tokenEndpoint: string, fetchImpl: typeof fetch, clientSecret?: string) {
    return postToTokenEndpoint({
      tokenEndpoint,
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c' }),
      clientId: 'client-1',
      ...(clientSecret ? { clientSecret } : {}),
      failureCode: 'oauth_token_exchange_failed',
      missingTokenCode: 'oauth_token_response_missing_access_token',
      fetchImpl,
    });
  }

  it('rejects an http token endpoint before any network activity', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = trackingFetch(calls, () => new Response('{}', { status: 200 }));
    await expect(post('http://8.8.8.8/token', fetchImpl)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-protocol',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a loopback token endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = trackingFetch(calls, () => new Response('{}', { status: 200 }));
    await expect(post('https://127.0.0.1/token', fetchImpl)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects the cloud metadata endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = trackingFetch(calls, () => new Response('{}', { status: 200 }));
    await expect(post('https://169.254.169.254/token', fetchImpl)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
    expect(calls).toHaveLength(0);
  });

  it('POSTs to a validated endpoint with redirects refused and Basic auth for confidential clients', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = trackingFetch(
      calls,
      () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }),
    );
    const token = await post('https://8.8.8.8/token', fetchImpl, 'secret-1');
    expect(token.access_token).toBe('tok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://8.8.8.8/token');
    expect(calls[0]!.init?.redirect).toBe('error');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      'Basic ' + Buffer.from('client-1:secret-1').toString('base64'),
    );
  });

  it('throws the failure code on a non-2xx response', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = trackingFetch(calls, () => new Response('denied', { status: 401 }));
    await expect(post('https://8.8.8.8/token', fetchImpl)).rejects.toThrow(
      /oauth_token_exchange_failed: 401/,
    );
  });

  it('throws the missing-token code when access_token is absent', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = trackingFetch(
      calls,
      () => new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 }),
    );
    await expect(post('https://8.8.8.8/token', fetchImpl)).rejects.toThrow(
      /oauth_token_response_missing_access_token/,
    );
  });
});
