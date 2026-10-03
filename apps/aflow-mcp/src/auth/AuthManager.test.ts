/**
 * What a session is worth is decided by the credential its client supplied.
 *
 * This server mints nothing and verifies nothing — it forwards the credential
 * and the API answers. The only local decision left is whether to keep sending
 * one, and guessing that wrong is silent in both directions: a session that
 * believes an expired token is good reports `authenticated: true` while every
 * call 401s, and one that expires a good token early stops working before the
 * credential does.
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AuthManager } from './AuthManager.js';
import type { McpServerConfig } from '../config.js';
import type { Session } from './SessionStore.js';

const CONFIG = {
  apiUrl: 'http://localhost:3000',
  port: 3100,
  host: '127.0.0.1',
  logLevel: 'error',
  unauthenticatedFallback: false,
  allowBrowserOrigins: false,
  allowedHosts: [],
  cfOriginSecret: undefined,
  localAuthJsonPath: undefined,
} as const satisfies McpServerConfig;

function session(): Session {
  return { id: 'sess-1', auth: { method: 'none' }, createdAt: 0, lastActivityAt: 0 };
}

/** A token carrying whatever claims are asked for. Never verified, so unsigned. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

describe('a bearer token the client supplied', () => {
  const manager = new AuthManager(CONFIG);

  it('expires when the token says it does, not an hour from now', () => {
    const s = session();
    const expiresAt = Math.floor(Date.now() / 1000) + 8 * 3600;
    manager.initFromHeaders(s, { authorization: `Bearer ${token({ exp: expiresAt })}` });

    expect(s.auth.method).toBe('bearer_token');
    expect(s.auth.tokenExpiresAt).toBe(expiresAt * 1000);
    expect(manager.isAuthenticated(s)).toBe(true);
  });

  it('is not authenticated once the token says it has expired', () => {
    const s = session();
    manager.initFromHeaders(s, {
      authorization: `Bearer ${token({ exp: Math.floor(Date.now() / 1000) - 60 })}`,
    });
    expect(manager.isAuthenticated(s)).toBe(false);
  });

  it('lets the API judge a token that claims no expiry', () => {
    // Refusing here would deny a credential the API would have accepted, on
    // the strength of a claim the token never made.
    const s = session();
    manager.initFromHeaders(s, { authorization: `Bearer ${token({ sub: 'someone' })}` });
    expect(s.auth.tokenExpiresAt).toBeUndefined();
    expect(manager.isAuthenticated(s)).toBe(true);
  });

  it('survives a token whose payload is not decodable', () => {
    const s = session();
    manager.initFromHeaders(s, { authorization: 'Bearer eyJhbGciOiJub25lIn0.@@@.' });
    expect(s.auth.method).toBe('bearer_token');
    expect(manager.isAuthenticated(s)).toBe(true);
  });
});

describe('an API key the client supplied', () => {
  it('carries no expiry of its own and stays usable', () => {
    const s = session();
    new AuthManager(CONFIG).initFromHeaders(s, { authorization: 'Bearer phx_abc123' });
    expect(s.auth).toMatchObject({ method: 'api_key', apiKey: 'phx_abc123' });
  });
});

/**
 * The file is read strictly, and a refusal falls back to no credential with
 * nothing but a log line to say so — an example that does not parse as copied
 * leaves every session unauthenticated.
 */
describe('the local auth file example', () => {
  it('is accepted as copied', () => {
    const example = fileURLToPath(new URL('../../mcp.local.json.example', import.meta.url));
    const s = session();
    new AuthManager({ ...CONFIG, localAuthJsonPath: example }).initFromHeaders(s, {});
    expect(s.auth).toMatchObject({ method: 'api_key', apiKey: 'phx_replace_me' });
  });
});
