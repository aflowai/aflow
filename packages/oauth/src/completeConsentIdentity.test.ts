/**
 * Consent completion stores which account it connected, read inside the same
 * call that exchanges the code. Google reports it as the id token's email
 * claim, or from its userinfo endpoint. A provider that reports nothing stores
 * NULL, so the page says "Connected" and names no account.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const CLIENT_ID = 'google-client-123.apps.googleusercontent.com';

const STATE_ROW = {
  state: 'x',
  integrationKind: 'api',
  resourceKey: 'gmail',
  bindingId: 'gmail-default',
  spaceId: '00000000-0000-4000-8000-0000000000bb',
  ownerScope: 'space',
  ownerId: '00000000-0000-4000-8000-0000000000bb',
  clientScope: 'tenant',
  codeVerifier: 'verifier',
  redirectUri: 'http://localhost:3000/v1/oauth/callback',
  resource: null,
  scopesJson: ['openid', 'email', 'profile'],
  expiresAt: new Date(Date.now() + 60_000),
};

const executed: SQL[] = [];
const insertedStates: Array<Record<string, unknown>> = [];

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([STATE_ROW]) }) }),
      }),
      execute: (query: SQL) => {
        executed.push(query);
        return Promise.resolve([]);
      },
      delete: () => ({ where: () => Promise.resolve() }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          insertedStates.push(row);
          return Promise.resolve();
        },
      }),
    }),
  oauthState: { state: 'state' },
  oauthTokens: {},
  encryptCredentialEnvelope: (plain: string) => Promise.resolve(`enc:${plain}`),
  decryptCredentialAsync: (enc: string) => Promise.resolve(enc.replace(/^enc:/, '')),
}));

vi.mock('@aflow/network-safety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/network-safety')>();
  return {
    ...actual,
    validateCredentialedUrl: (raw: string) => Promise.resolve({ url: new URL(raw) }),
  };
});

vi.mock('./clientResolution.js', () => ({
  resolveOAuthClient: () => Promise.resolve({ clientId: CLIENT_ID, clientSecret: 'secret' }),
}));

const GOOGLE_METADATA = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
};

vi.mock('./asMetadata.js', () => ({
  discoverAsMetadata: () => Promise.resolve(GOOGLE_METADATA),
}));

const { completeConsent, generateStateToken, startConsent } = await import('./tokenManager.js');

/** The scopes the curated Gmail connector names, and nothing else. */
const GMAIL_CONNECTOR_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The stored token row, column by column, as the upsert writes it. */
function storedRow(): Record<string, unknown> {
  const query = executed.find((q) =>
    new PgDialect().sqlToQuery(q).sql.includes('INSERT INTO oauth_tokens'),
  );
  if (!query) throw new Error('no token row was written');
  const { sql, params } = new PgDialect().sqlToQuery(query);
  const match = /INSERT INTO oauth_tokens \(([^)]*)\)\s*VALUES \(([\s\S]*?)\)\s*ON CONFLICT/.exec(
    sql,
  );
  if (!match?.[1] || !match[2]) throw new Error(`unexpected upsert: ${sql}`);
  const columns = match[1].split(',').map((c) => c.trim());
  const values = match[2].split(',').map((v) => v.trim());
  return Object.fromEntries(
    columns.map((column, i) => {
      const placeholder = /\$(\d+)/.exec(values[i] ?? '');
      return [column, placeholder ? params[Number(placeholder[1]) - 1] : values[i]];
    }),
  );
}

async function complete(issuerKey: string, fetchImpl: typeof fetch) {
  return completeConsent({
    state: generateStateToken(TENANT_ID),
    code: 'auth-code',
    db: {},
    resolveContext: () => Promise.resolve({ tenantId: TENANT_ID, issuerKey }),
    fetchImpl,
  });
}

afterEach(() => {
  executed.length = 0;
  insertedStates.length = 0;
});

async function start(issuerKey: string, scopes: string[]) {
  return startConsent({
    tenantId: TENANT_ID,
    spaceId: STATE_ROW.spaceId,
    target: {
      integrationKind: 'api',
      resourceKey: 'gmail',
      bindingId: 'gmail-default',
      ownerScope: 'space',
      ownerId: STATE_ROW.ownerId,
      clientScope: 'tenant',
      issuerKey,
    },
    scopes,
    redirectUri: STATE_ROW.redirectUri,
    db: {},
  });
}

describe('startConsent requests the scopes the identity read needs', () => {
  it("adds Google's openid and email to the Gmail connector's own scopes", async () => {
    const result = await start('google', GMAIL_CONNECTOR_SCOPES);

    const requested = new URL(result.authorizationUrl).searchParams.get('scope')?.split(' ');
    expect(requested).toEqual([...GMAIL_CONNECTOR_SCOPES, 'openid', 'email']);
    expect(insertedStates[0]?.['scopesJson']).toEqual(requested);
  });

  it('asks for each scope once when the binding already names it', async () => {
    const result = await start('google', ['openid', 'email', 'profile']);

    expect(new URL(result.authorizationUrl).searchParams.get('scope')).toBe('openid email profile');
  });

  it('adds nothing for an issuer without identity scopes', async () => {
    const result = await start('github', ['read:user']);

    expect(new URL(result.authorizationUrl).searchParams.get('scope')).toBe('read:user');
  });
});

describe('the Gmail connector records its account', () => {
  it('stores the email Google reports for a consent the connector started', async () => {
    await start('google', GMAIL_CONNECTOR_SCOPES);
    const requested = insertedStates[0]?.['scopesJson'] as string[];
    // Google grants what consent asked for, and the openid scope adds an id token.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          access_token: 'access',
          expires_in: 3600,
          scope: requested.join(' '),
          id_token: idToken({ aud: CLIENT_ID, email: 'operator@example.com' }),
        }),
      ),
    );

    const result = await complete('google', fetchImpl as unknown as typeof fetch);

    expect(result.accountIdentity).toBe('operator@example.com');
    expect(storedRow()['account_identity']).toBe('operator@example.com');
  });
});

describe('completeConsent stores the account identity', () => {
  it('stores the email claim of a Google id token', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          access_token: 'access',
          expires_in: 3600,
          scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
          id_token: idToken({
            iss: 'https://accounts.google.com',
            aud: CLIENT_ID,
            email: 'operator@example.com',
          }),
        }),
      ),
    );

    const result = await complete('google', fetchImpl as unknown as typeof fetch);

    expect(result.accountIdentity).toBe('operator@example.com');
    const row = storedRow();
    expect(row['account_identity']).toBe('operator@example.com');
    expect(row['connected_at']).toBe('NOW()');
    // The id token answered, so the userinfo endpoint is never called.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads Google's userinfo endpoint when the token response carries no id token", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      urls.push(url);
      if (url === GOOGLE_METADATA.userinfo_endpoint) {
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer access');
        return Promise.resolve(jsonResponse({ sub: '1', email: 'operator@example.com' }));
      }
      return Promise.resolve(jsonResponse({ access_token: 'access', expires_in: 3600 }));
    });

    const result = await complete('google', fetchImpl as unknown as typeof fetch);

    expect(urls).toEqual([GOOGLE_METADATA.token_endpoint, GOOGLE_METADATA.userinfo_endpoint]);
    expect(result.accountIdentity).toBe('operator@example.com');
    expect(storedRow()['account_identity']).toBe('operator@example.com');
  });

  it('ignores an id token minted for another client', async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url === GOOGLE_METADATA.userinfo_endpoint
          ? jsonResponse({})
          : jsonResponse({
              access_token: 'access',
              id_token: idToken({ aud: 'someone-else', email: 'other@example.com' }),
            }),
      ),
    );

    const result = await complete('google', fetchImpl as unknown as typeof fetch);

    expect(result.accountIdentity).toBeNull();
    expect(storedRow()['account_identity']).toBeNull();
  });

  it('stores NULL for a provider that reports no identity', async () => {
    // GitHub carries explicit endpoints, no OIDC discovery and no userinfo
    // endpoint, and its token response has no id token.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ access_token: 'access', scope: 'read:user' })),
    );

    const result = await complete('github', fetchImpl as unknown as typeof fetch);

    expect(result.accountIdentity).toBeNull();
    const row = storedRow();
    expect(row['account_identity']).toBeNull();
    expect(row['connected_at']).toBe('NOW()');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('completes the consent when the userinfo read fails', async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url === GOOGLE_METADATA.userinfo_endpoint
          ? new Response('nope', { status: 500 })
          : jsonResponse({ access_token: 'access' }),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await complete('google', fetchImpl as unknown as typeof fetch);

    expect(result.accountIdentity).toBeNull();
    expect(storedRow()['account_identity']).toBeNull();
    warn.mockRestore();
  });
});

describe('a re-consent keeps the account the row has recorded', () => {
  /** The SET clause the upsert applies to the row it conflicts with. */
  function onConflictSet(): string {
    const query = executed.find((q) =>
      new PgDialect().sqlToQuery(q).sql.includes('INSERT INTO oauth_tokens'),
    );
    if (!query) throw new Error('no token row was written');
    const { sql } = new PgDialect().sqlToQuery(query);
    const set = /DO UPDATE SET([\s\S]*)$/.exec(sql)?.[1];
    if (!set) throw new Error(`unexpected upsert: ${sql}`);
    return set.replace(/\s+/g, ' ');
  }

  it('writes NULL as the new account and keeps the recorded one on conflict', async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url === GOOGLE_METADATA.userinfo_endpoint
          ? new Response('nope', { status: 500 })
          : jsonResponse({ access_token: 'access' }),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await complete('google', fetchImpl as unknown as typeof fetch);

    expect(storedRow()['account_identity']).toBeNull();
    expect(onConflictSet()).toContain(
      'account_identity = COALESCE(EXCLUDED.account_identity, oauth_tokens.account_identity)',
    );
    warn.mockRestore();
  });

  it('replaces the other token fields on every re-consent', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ access_token: 'access' })));

    await complete('github', fetchImpl as unknown as typeof fetch);

    const set = onConflictSet();
    for (const column of ['access_token_enc', 'scopes_json', 'connected_at']) {
      expect(set).toContain(`${column} = EXCLUDED.${column}`);
    }
  });
});
