import { describe, it, expect } from 'vitest';
import { ConnectorCatalogEntrySchema, type ConnectorAuthKind } from './connectorCatalog.js';

function entryWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    catalogId: 'acme',
    version: 1,
    name: 'Acme',
    tagline: 'Acme API.',
    description: 'Acme API connector.',
    honestyLabel: 'curated',
    authKind: 'api_key' satisfies ConnectorAuthKind,
    definition: {
      apiId: 'acme',
      name: 'Acme',
      baseUrl: 'https://api.acme.test',
      endpoints: [
        {
          endpointId: 'ping',
          name: 'Ping',
          method: 'GET',
          pathTemplate: '/ping',
        },
      ],
    },
    ...overrides,
  };
}

describe('ConnectorCatalogEntrySchema apiKeyHeaderName', () => {
  it('accepts a header name on an api_key connector', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entryWith({ apiKeyHeaderName: 'Authorization' }),
    );
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (result.success) expect(result.data.apiKeyHeaderName).toBe('Authorization');
  });

  it('rejects a header name on a non-api_key connector', () => {
    for (const authKind of ['bearer', 'basic', 'none'] satisfies ConnectorAuthKind[]) {
      const result = ConnectorCatalogEntrySchema.safeParse(
        entryWith({ authKind, apiKeyHeaderName: 'Authorization' }),
      );
      expect(result.success, `authKind ${authKind}`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join('.') === 'apiKeyHeaderName')).toBe(true);
      }
    }
  });

  it('rejects header names outside the safe charset', () => {
    for (const bad of ['X API Key', 'X-Key:', 'bad\nheader', '-leading', '']) {
      const result = ConnectorCatalogEntrySchema.safeParse(entryWith({ apiKeyHeaderName: bad }));
      expect(result.success, `header '${bad}'`).toBe(false);
    }
  });

  it('stays optional — an api_key connector without it still parses', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(entryWith({}));
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (result.success) expect(result.data.apiKeyHeaderName).toBeUndefined();
  });
});

describe('ConnectorCatalogEntrySchema apiKeyQueryParamName', () => {
  it('accepts a query-param name on an api_key connector', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entryWith({ apiKeyQueryParamName: 'api_key' }),
    );
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (result.success) expect(result.data.apiKeyQueryParamName).toBe('api_key');
  });

  it('rejects a query-param name on a non-api_key connector', () => {
    for (const authKind of ['bearer', 'basic', 'none'] satisfies ConnectorAuthKind[]) {
      const result = ConnectorCatalogEntrySchema.safeParse(
        entryWith({ authKind, apiKeyQueryParamName: 'api_key' }),
      );
      expect(result.success, `authKind ${authKind}`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join('.') === 'apiKeyQueryParamName')).toBe(
          true,
        );
      }
    }
  });

  it('rejects query-param names outside the safe charset', () => {
    for (const bad of ['api key', 'api_key:', 'bad\nparam', '-leading', '']) {
      const result = ConnectorCatalogEntrySchema.safeParse(
        entryWith({ apiKeyQueryParamName: bad }),
      );
      expect(result.success, `param '${bad}'`).toBe(false);
    }
  });

  it('rejects setting both a header name and a query-param name (ambiguous placement)', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entryWith({ apiKeyHeaderName: 'X-API-Key', apiKeyQueryParamName: 'api_key' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'apiKeyQueryParamName')).toBe(
        true,
      );
    }
  });

  it('a header-only api_key connector still parses (query-param name absent)', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entryWith({ apiKeyHeaderName: 'X-API-Key' }),
    );
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (result.success) {
      expect(result.data.apiKeyHeaderName).toBe('X-API-Key');
      expect(result.data.apiKeyQueryParamName).toBeUndefined();
    }
  });
});

describe('ConnectorCatalogEntrySchema oauthScopes', () => {
  it('accepts scopes on an oauth2_authorization_code connector', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entryWith({
        authKind: 'oauth2_authorization_code' satisfies ConnectorAuthKind,
        oauthIssuerKey: 'slack',
        oauthScopes: ['channels:read', 'chat:write'],
      }),
    );
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (result.success) expect(result.data.oauthScopes).toEqual(['channels:read', 'chat:write']);
  });

  it('rejects scopes on a non-oauth connector', () => {
    for (const authKind of ['bearer', 'api_key', 'basic', 'none'] satisfies ConnectorAuthKind[]) {
      const result = ConnectorCatalogEntrySchema.safeParse(
        entryWith({ authKind, oauthScopes: ['channels:read'] }),
      );
      expect(result.success, `authKind ${authKind}`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join('.') === 'oauthScopes')).toBe(true);
      }
    }
  });

  it('stays optional — an oauth connector without scopes still parses', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entryWith({
        authKind: 'oauth2_authorization_code' satisfies ConnectorAuthKind,
        oauthIssuerKey: 'slack',
      }),
    );
    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (result.success) expect(result.data.oauthScopes).toBeUndefined();
  });

  it('rejects empty scope strings', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entryWith({
        authKind: 'oauth2_authorization_code' satisfies ConnectorAuthKind,
        oauthIssuerKey: 'slack',
        oauthScopes: [''],
      }),
    );
    expect(result.success).toBe(false);
  });
});
