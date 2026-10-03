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
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { AuthManager } from './AuthManager.js';
import type { McpServerConfig } from '../config.js';
import {
  CREDENTIAL_LESS_REFUSAL,
  NO_SESSION_TOKEN_REFUSAL,
  WRONG_TOKEN_REFUSAL,
  admitRequest,
  requestGatePolicy,
  type AdmittedHeaders,
} from '../requestGate.js';
import type { Session } from './SessionStore.js';

const CONFIG = {
  apiUrl: 'http://localhost:3000',
  port: 3100,
  host: '127.0.0.1',
  logLevel: 'error',
  unauthenticatedFallback: false,
  allowBrowserOrigins: false,
  allowedOrigins: [],
  allowedHosts: [],
  cfOriginSecret: undefined,
  localAuthJsonPath: undefined,
} as const satisfies McpServerConfig;

/** Headers as they reach a session: only through the gate. */
function admitted(headers: Record<string, string>): AdmittedHeaders {
  const decision = admitRequest(requestGatePolicy(CONFIG), {
    host: `localhost:${String(CONFIG.port)}`,
    ...headers,
  });
  if (!decision.admitted) throw new Error(decision.reason);
  return decision.headers;
}

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
    manager.initFromHeaders(s, admitted({ authorization: `Bearer ${token({ exp: expiresAt })}` }));

    expect(s.auth.method).toBe('bearer_token');
    expect(s.auth.tokenExpiresAt).toBe(expiresAt * 1000);
    expect(manager.isAuthenticated(s)).toBe(true);
  });

  it('is not authenticated once the token says it has expired', () => {
    const s = session();
    manager.initFromHeaders(
      s,
      admitted({
        authorization: `Bearer ${token({ exp: Math.floor(Date.now() / 1000) - 60 })}`,
      }),
    );
    expect(manager.isAuthenticated(s)).toBe(false);
  });

  it('lets the API judge a token that claims no expiry', () => {
    // Refusing here would deny a credential the API would have accepted, on
    // the strength of a claim the token never made.
    const s = session();
    manager.initFromHeaders(s, admitted({ authorization: `Bearer ${token({ sub: 'someone' })}` }));
    expect(s.auth.tokenExpiresAt).toBeUndefined();
    expect(manager.isAuthenticated(s)).toBe(true);
  });

  it('survives a token whose payload is not decodable', () => {
    const s = session();
    manager.initFromHeaders(s, admitted({ authorization: 'Bearer eyJhbGciOiJub25lIn0.@@@.' }));
    expect(s.auth.method).toBe('bearer_token');
    expect(manager.isAuthenticated(s)).toBe(true);
  });
});

describe('an API key the client supplied', () => {
  it('carries no expiry of its own and stays usable', () => {
    const s = session();
    new AuthManager(CONFIG).initFromHeaders(s, admitted({ authorization: 'Bearer phx_abc123' }));
    expect(s.auth).toMatchObject({ method: 'api_key', apiKey: 'phx_abc123' });
  });
});

/**
 * The file is read strictly, and a refusal falls back to no credential with
 * nothing but a log line to say so — an example that does not parse as copied
 * leaves every session unauthenticated.
 */
const EXAMPLE = fileURLToPath(new URL('../../mcp.local.json.example', import.meta.url));
const EXAMPLE_FIELDS = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as Record<string, unknown>;
const SESSION_TOKEN = randomBytes(32).toString('hex');
const AUTH_DIR = mkdtempSync(join(tmpdir(), 'mcp-auth-'));
const SET_UP = join(AUTH_DIR, 'mcp.local.json');
writeFileSync(SET_UP, JSON.stringify({ ...EXAMPLE_FIELDS, sessionToken: SESSION_TOKEN }));
afterAll(() => {
  rmSync(AUTH_DIR, { recursive: true, force: true });
});
const withSetUpFile = new AuthManager({ ...CONFIG, localAuthJsonPath: SET_UP });

describe('the local auth file example', () => {
  /** A published token would give the owner's key to any process that sent it. */
  it('carries no session token, so as copied it gives the key to nobody', () => {
    expect(EXAMPLE_FIELDS['sessionToken']).toBe('');
    const s = session();
    const outcome = new AuthManager({ ...CONFIG, localAuthJsonPath: EXAMPLE }).initFromHeaders(
      s,
      admitted({ authorization: 'Bearer anything' }),
    );
    expect(outcome).toMatchObject({ accepted: false, reason: NO_SESSION_TOKEN_REFUSAL });
    expect(s.auth.apiKey).toBeUndefined();
  });

  it('is accepted once a session token is set, by a session presenting it', () => {
    const s = session();
    const outcome = withSetUpFile.initFromHeaders(
      s,
      admitted({ authorization: `Bearer ${SESSION_TOKEN}` }),
    );
    expect(outcome).toEqual({ accepted: true });
    expect(s.auth).toMatchObject({ method: 'api_key', apiKey: 'phx_replace_me' });
  });
});

describe('the owner’s key, from the local auth file', () => {
  it('is refused to a session that presents another token, and says how to set it up', () => {
    const s = session();
    const outcome = withSetUpFile.initFromHeaders(s, admitted({ authorization: 'Bearer guess' }));
    expect(outcome).toMatchObject({ accepted: false, reason: WRONG_TOKEN_REFUSAL });
    expect(s.auth.apiKey).toBeUndefined();
  });

  /** The gate refuses this first; the key is not left to the gate alone. */
  it('is refused to a session that presents nothing', () => {
    const s = session();
    expect(withSetUpFile.initFromHeaders(s, admitted({}))).toMatchObject({
      accepted: false,
      reason: CREDENTIAL_LESS_REFUSAL,
    });
    expect(s.auth.apiKey).toBeUndefined();
  });

  /** A file written before session tokens has no such field; it is unset, not unreadable. */
  it('is given to nobody from a file with no session token, and says how to set one up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-auth-'));
    try {
      const file = join(dir, 'mcp.local.json');
      writeFileSync(file, JSON.stringify({ apiKey: 'phx_owner', tenantId: 't' }));
      const s = session();
      const outcome = new AuthManager({ ...CONFIG, localAuthJsonPath: file }).initFromHeaders(
        s,
        admitted({ authorization: 'Bearer anything' }),
      );
      expect(outcome).toMatchObject({ accepted: false, reason: NO_SESSION_TOKEN_REFUSAL });
      if (outcome.accepted) throw new Error('expected a refusal');
      expect(outcome.reason).toContain('yarn mcp:setup');
      expect(s.auth.apiKey).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a session that brings its own key alone', () => {
    const s = session();
    withSetUpFile.initFromHeaders(s, admitted({ authorization: 'Bearer phx_own' }));
    expect(s.auth).toMatchObject({ method: 'api_key', apiKey: 'phx_own' });
  });
});
