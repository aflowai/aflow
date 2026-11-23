/**
 * Each OAuth-code binding's card states the token that binding resolves, by
 * its own owner scope. A space-owned token shows to every member of the
 * space. A user-owned token shows only to the user who owns it. A token one
 * scope owns never answers for a binding of the other scope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';

interface TokenRow {
  resourceKey: string;
  ownerScope: 'user' | 'space';
  ownerId: string;
  scopesJson: string[];
  accountIdentity: string | null;
  connectedAt: Date | null;
  expiresAt: Date;
  hasRefreshToken: boolean;
}

let tokens: TokenRow[] = [];
let reads = 0;
let lastWhere: SQL | undefined;

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb({
        select: () => ({
          from: () => ({
            where: (condition: SQL) => {
              reads += 1;
              lastWhere = condition;
              return Promise.resolve(tokens);
            },
          }),
        }),
      }),
  };
});

const { listBindingOAuthConnections } = await import('./oauthConnections.js');

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';
const OTHER_SPACE_ID = '00000000-0000-4000-8000-0000000000cc';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-000000000b0b';
const NOW = new Date('2026-11-20T12:00:00.000Z');
const CONNECTED_AT = new Date('2026-11-20T09:30:00.000Z');

function token(overrides: Partial<TokenRow> & Pick<TokenRow, 'resourceKey'>): TokenRow {
  return {
    ownerScope: 'space',
    ownerId: SPACE_ID,
    scopesJson: ['openid', 'email'],
    accountIdentity: null,
    connectedAt: CONNECTED_AT,
    expiresAt: new Date('2026-11-20T13:00:00.000Z'),
    hasRefreshToken: true,
    ...overrides,
  };
}

function oauthBinding(bindingId: string, apiId: string, ownerScope: 'user' | 'space') {
  return {
    bindingId,
    apiId,
    authJson: {
      type: 'oauth2_authorization_code',
      ownerScope,
      clientScope: 'tenant',
      issuerKey: 'google',
    },
  };
}

const BINDINGS = [
  oauthBinding('gmail-shared', 'gmail', 'space'),
  oauthBinding('calendar-mine', 'googlecalendar', 'user'),
  { bindingId: 'stripe', apiId: 'stripe', authJson: { type: 'bearer', credentialKey: 'k' } },
];

function list(viewer: { userId?: string; spaceId?: string }, bindings = BINDINGS) {
  return listBindingOAuthConnections(
    {} as Database,
    TENANT_ID,
    bindings,
    {
      ...(viewer.userId ? { userId: viewer.userId } : {}),
      spaceId: viewer.spaceId ?? SPACE_ID,
      tenantId: TENANT_ID,
    },
    NOW,
  );
}

afterEach(() => {
  tokens = [];
  reads = 0;
  lastWhere = undefined;
});

describe('listBindingOAuthConnections', () => {
  it('shows a space-owned token to every member of the space', async () => {
    tokens = [token({ resourceKey: 'gmail', accountIdentity: 'ops@example.com' })];

    for (const userId of [ALICE, BOB]) {
      const connections = await list({ userId });
      expect(connections.get('gmail-shared')).toEqual({
        account: 'ops@example.com',
        connectedAt: CONNECTED_AT.toISOString(),
        scopes: ['openid', 'email'],
        status: 'connected',
      });
    }
  });

  it('does not show a space-owned token in another space', async () => {
    tokens = [token({ resourceKey: 'gmail', accountIdentity: 'ops@example.com' })];

    const connections = await list({ userId: ALICE, spaceId: OTHER_SPACE_ID });
    expect(connections.get('gmail-shared')).toBeNull();
  });

  it('shows a user-owned token only to the user who owns it', async () => {
    tokens = [
      token({
        resourceKey: 'googlecalendar',
        ownerScope: 'user',
        ownerId: ALICE,
        accountIdentity: 'alice@example.com',
      }),
    ];

    expect((await list({ userId: ALICE })).get('calendar-mine')?.account).toBe('alice@example.com');
    expect((await list({ userId: BOB })).get('calendar-mine')).toBeNull();
    expect((await list({})).get('calendar-mine')).toBeNull();
  });

  it("never answers one owner scope's binding with the other scope's token", async () => {
    tokens = [
      token({ resourceKey: 'gmail', ownerScope: 'user', ownerId: ALICE, accountIdentity: 'a@x' }),
      token({ resourceKey: 'googlecalendar', accountIdentity: 'ops@example.com' }),
    ];

    const connections = await list({ userId: ALICE });
    expect(connections.get('gmail-shared')).toBeNull();
    expect(connections.get('calendar-mine')).toBeNull();
  });

  it('reports null before consent and leaves other auth types out', async () => {
    const connections = await list({ userId: ALICE });

    expect(connections.get('gmail-shared')).toBeNull();
    expect(connections.get('calendar-mine')).toBeNull();
    expect(connections.has('stripe')).toBe(false);
  });

  it('reads no tokens when no binding signs in with OAuth', async () => {
    const connections = await list({ userId: ALICE }, [BINDINGS[2]!]);

    expect(connections.size).toBe(0);
    expect(reads).toBe(0);
  });

  it('states a dead token as expired and a token from before migration 238 without a time', async () => {
    tokens = [
      token({
        resourceKey: 'gmail',
        connectedAt: null,
        hasRefreshToken: false,
        expiresAt: new Date('2026-11-20T11:00:00.000Z'),
      }),
    ];

    expect((await list({ userId: ALICE })).get('gmail-shared')).toEqual({
      account: null,
      connectedAt: null,
      scopes: ['openid', 'email'],
      status: 'expired',
    });
  });

  it("reads only the token rows the viewer's owner scopes can match", async () => {
    await list({ userId: ALICE });

    if (!lastWhere) throw new Error('no token read');
    const { sql, params } = new PgDialect().sqlToQuery(lastWhere);
    expect(sql).toContain('"owner_scope" = ');
    expect(sql).toContain('"owner_id" = ');
    expect(params).toEqual(
      expect.arrayContaining(['api', 'gmail', 'googlecalendar', 'space', SPACE_ID, 'user', ALICE]),
    );
    expect(params).not.toContain(BOB);
  });

  it('reads no user-owned rows for a viewer with no user id', async () => {
    await list({});

    if (!lastWhere) throw new Error('no token read');
    const { params } = new PgDialect().sqlToQuery(lastWhere);
    expect(params).not.toContain('user');
    expect(params).toEqual(expect.arrayContaining(['space', SPACE_ID]));
  });
});
