import { describe, it, expect } from 'vitest';
import { toOAuthConnection, deriveConnectionDisplayName } from './oauthConnections.js';

describe('deriveConnectionDisplayName', () => {
  it('prefers the curated issuer registry display name', () => {
    expect(deriveConnectionDisplayName('My Google binding', 'google', 'gmail-api')).toBe('Google');
  });

  it('falls back to the binding name for an unregistered issuer', () => {
    expect(deriveConnectionDisplayName('Acme CRM', 'acme-crm', 'acme-api')).toBe('Acme CRM');
  });

  it('falls back to the binding name when no issuerKey is present (MCP)', () => {
    expect(deriveConnectionDisplayName('Kaggle MCP', undefined, 'kaggle')).toBe('Kaggle MCP');
  });

  it('falls back to the raw resource key when no name and no issuer', () => {
    expect(deriveConnectionDisplayName(undefined, undefined, 'some-resource')).toBe(
      'some-resource',
    );
    expect(deriveConnectionDisplayName('   ', undefined, 'some-resource')).toBe('some-resource');
  });
});

describe('toOAuthConnection', () => {
  const now = new Date('2026-06-24T12:00:00.000Z');

  it('marks a future-expiry token connected and never returns token material', () => {
    const conn = toOAuthConnection(
      {
        integrationKind: 'api',
        resourceKey: 'gmail-api',
        scopesJson: ['email', 'profile'],
        expiresAt: new Date('2026-06-24T13:00:00.000Z'),
        hasRefreshToken: false,
      },
      'Google',
      now,
    );
    expect(conn).toEqual({
      integrationKind: 'api',
      resourceKey: 'gmail-api',
      displayName: 'Google',
      scopes: ['email', 'profile'],
      expiresAt: '2026-06-24T13:00:00.000Z',
      status: 'connected',
    });
    expect(Object.keys(conn)).not.toContain('accessTokenEnc');
    expect(Object.keys(conn)).not.toContain('refreshTokenEnc');
  });

  it('a refresh token keeps a past-expiry connection connected — access tokens expire hourly by design', () => {
    const renewable = toOAuthConnection(
      {
        integrationKind: 'api',
        resourceKey: 'gmail-api',
        scopesJson: ['email'],
        expiresAt: new Date('2026-06-24T11:00:00.000Z'),
        hasRefreshToken: true,
      },
      'Google',
      now,
    );
    expect(renewable.status).toBe('connected');
  });

  it('marks an at-or-past-expiry token WITHOUT a refresh token expired', () => {
    const expired = toOAuthConnection(
      {
        integrationKind: 'mcp',
        resourceKey: 'kaggle',
        scopesJson: [],
        expiresAt: new Date('2026-06-24T11:00:00.000Z'),
        hasRefreshToken: false,
      },
      'Kaggle MCP',
      now,
    );
    expect(expired.status).toBe('expired');

    const exactlyNow = toOAuthConnection(
      {
        integrationKind: 'mcp',
        resourceKey: 'kaggle',
        scopesJson: [],
        expiresAt: now,
        hasRefreshToken: false,
      },
      'Kaggle MCP',
      now,
    );
    expect(exactlyNow.status).toBe('expired');
  });
});
