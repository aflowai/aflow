/**
 * A connector whose calls are answered by a world rather than a host.
 *
 * The listing carries the CONTRACT — the API definition — and never a world. A
 * connector shipping seed rows would be smuggling content into an integration,
 * and the world it would ship belongs to the space that installed it.
 */
import { describe, expect, it } from 'vitest';
import { ConnectorCatalogEntrySchema } from './connectorCatalog.js';

const definition = {
  apiId: 'bnpl-support',
  name: 'Support Desk core',
  baseUrl: 'https://api.support-desk.example.com',
  version: '1',
  callMode: 'endpoint' as const,
  tags: [],
  endpoints: [
    {
      endpointId: 'getOrder',
      name: 'Get order',
      method: 'GET' as const,
      pathTemplate: '/orders/{orderId}',
      params: [
        { name: 'orderId', location: 'path' as const, required: true, schema: { type: 'string' } },
      ],
      tags: [],
      responseSchemas: { '2xx': { type: 'object' } },
    },
  ],
};

const entry = (over: Record<string, unknown> = {}) => ({
  catalogId: 'support-desk',
  version: 1,
  name: 'Support Desk',
  tagline: 'A BNPL support desk with no backend.',
  description: 'A BNPL support desk that answers from a declared world.',
  tags: ['simulation'],
  honestyLabel: 'curated',
  authKind: 'none',
  definition,
  ...over,
});

describe('ConnectorCatalogEntrySchema — fulfillment', () => {
  it('defaults to live, so an existing connector is unchanged', () => {
    const parsed = ConnectorCatalogEntrySchema.parse(entry({ authKind: 'api_key' }));
    // Absent, not 'live' — the entries written before this existed carry
    // nothing, and every read treats absent as live.
    expect(parsed.fulfillment).toBeUndefined();
  });

  it('accepts a simulated connector that holds no credential', () => {
    const parsed = ConnectorCatalogEntrySchema.parse(entry({ fulfillment: 'simulated' }));
    expect(parsed.fulfillment).toBe('simulated');
    expect(parsed.authKind).toBe('none');
  });

  it('refuses a simulated connector that asks for one', () => {
    // Its calls never reach a host, so a credential prompt would ask an
    // operator for a secret the integration can never use — and leave a
    // binding that already works waiting to be configured.
    const result = ConnectorCatalogEntrySchema.safeParse(
      entry({ fulfillment: 'simulated', authKind: 'api_key' }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/answered by a world/);
  });

  it('refuses a simulated OAuth connector for the same reason', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(
      entry({
        fulfillment: 'simulated',
        authKind: 'oauth2_authorization_code',
        oauthIssuerKey: 'google',
      }),
    );
    expect(result.success).toBe(false);
  });
});
