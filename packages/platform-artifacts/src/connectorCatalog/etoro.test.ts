import { describe, it, expect } from 'vitest';
import {
  ApiDefinitionSchema,
  ConnectorCatalogEntrySchema,
  effectiveWriteRiskTier,
  writeRiskTierGatedByDefault,
  type ConnectorCatalogEntry,
} from '@aflow/schemas';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';
import { ETORO_MARKET_DATA_CONNECTOR } from './etoroMarketData.js';
import { ETORO_ACCOUNT_CONNECTOR } from './etoroAccount.js';
import { ETORO_TRADING_CONNECTOR } from './etoroTrading.js';
import { ETORO_API_KEY_CREDENTIAL, ETORO_USER_KEY_CREDENTIAL } from './etoroShared.js';

const ENTRIES: ReadonlyArray<[string, ConnectorCatalogEntry]> = [
  ['etoro-market-data', ETORO_MARKET_DATA_CONNECTOR],
  ['etoro-account', ETORO_ACCOUNT_CONNECTOR],
  ['etoro-trading', ETORO_TRADING_CONNECTOR],
];

const READ_ONLY = [ETORO_MARKET_DATA_CONNECTOR, ETORO_ACCOUNT_CONNECTOR];

describe('eToro connector catalog entries', () => {
  it.each(ENTRIES)('%s parses through ConnectorCatalogEntrySchema', (_id, entry) => {
    const result = ConnectorCatalogEntrySchema.safeParse(entry);
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it.each(ENTRIES)('%s embeds a definition passing ApiDefinitionSchema', (_id, entry) => {
    const result = ApiDefinitionSchema.safeParse(entry.definition);
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it.each(ENTRIES)('%s is registered in the catalog', (id, entry) => {
    expect(getConnectorCatalogEntry(id)).toEqual(entry);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain(id);
  });

  it.each(ENTRIES)('%s pins a fixed baseUrl with no template', (_id, entry) => {
    expect(entry.definition.baseUrl).toBe('https://public-api.etoro.com');
    expect(entry.definition.baseUrlTemplate).toBeUndefined();
    expect(entry.definition.variables).toBeUndefined();
  });

  it.each(ENTRIES)('%s declares the dual-header auth eToro requires', (_id, entry) => {
    expect(entry.authKind).toBe('api_key_pair');
    expect(entry.apiKeyPairHeaderNames).toEqual({
      primary: 'x-api-key',
      secondary: 'x-user-key',
    });
    expect(entry.apiKeyHeaderName).toBeUndefined();
    expect(entry.apiKeyQueryParamName).toBeUndefined();
  });

  it.each(ENTRIES)(
    '%s declares the request-id header eToro requires on every call',
    (_id, entry) => {
      expect(entry.definition.requestIdHeader).toBe('x-request-id');
    },
  );

  it('all three pin the SAME credential keys, so one pasted pair serves every binding', () => {
    for (const [, entry] of ENTRIES) {
      const byField = Object.fromEntries(
        (entry.credentialPrompts ?? []).map((p) => [p.authField, p.credentialKey]),
      );
      expect(byField['credentialKey']).toBe(ETORO_API_KEY_CREDENTIAL);
      expect(byField['secondaryCredentialKey']).toBe(ETORO_USER_KEY_CREDENTIAL);
    }
  });

  it('ships no route eToro has deprecated', () => {
    // The v1 open-by-amount / open-by-units / limit-order routes are under
    // deprecated-api-reference; the unified v2 route replaces all three.
    const paths = ENTRIES.flatMap(([, e]) => e.definition.endpoints.map((ep) => ep.pathTemplate));
    for (const deprecated of [
      '/api/v1/trading/execution/market-open-orders/by-amount',
      '/api/v1/trading/execution/market-open-orders/by-units',
      '/api/v1/trading/execution/limit-orders',
    ]) {
      expect(paths).not.toContain(deprecated);
    }
    expect(paths).toContain('/api/v2/trading/execution/orders');
  });
});

describe('eToro read-only connectors carry no write authority', () => {
  it.each(READ_ONLY.map((e) => [e.catalogId, e] as const))(
    '%s is GET-only, in both its endpoints and its suggested egress',
    (_id, entry) => {
      for (const ep of entry.definition.endpoints) {
        expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
        expect(
          ep.params?.some((p) => p.location === 'body'),
          `endpoint ${ep.endpointId}`,
        ).toBeFalsy();
        expect(effectiveWriteRiskTier(ep), `endpoint ${ep.endpointId}`).toBe('read');
      }
      expect(entry.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
    },
  );
});

describe('eToro trading connector risk tiers', () => {
  const tierOf = (endpointId: string) => {
    const ep = ETORO_TRADING_CONNECTOR.definition.endpoints.find(
      (e) => e.endpointId === endpointId,
    );
    if (!ep) throw new Error(`no endpoint ${endpointId}`);
    return effectiveWriteRiskTier(ep);
  };

  it('gates every route that takes on risk', () => {
    // Opening exposure, and widening or clearing a stop, are the risk-taking
    // writes. Cancelling a pending CLOSE belongs here too: it keeps a position
    // the operator had begun to exit.
    expect(tierOf('createOrder')).toBe('high');
    expect(tierOf('modifyPosition')).toBe('high');
    expect(tierOf('cancelCloseOrder')).toBe('high');
  });

  it('tiers risk-reducing writes one step lower so an exit is not trapped behind approval', () => {
    // Both still gate by default; the separation is what lets a space relax
    // `medium` alone and keep entries gated.
    expect(tierOf('closePosition')).toBe('medium');
    expect(tierOf('cancelOrder')).toBe('medium');
    expect(writeRiskTierGatedByDefault('medium')).toBe(true);
  });

  it('treats the what-if POSTs as reads, because they place nothing', () => {
    expect(tierOf('getCosts')).toBe('read');
    expect(tierOf('checkEligibility')).toBe('read');
    expect(writeRiskTierGatedByDefault('read')).toBe(false);
  });

  it('every non-GET route declares its tier explicitly rather than inheriting the default', () => {
    for (const ep of ETORO_TRADING_CONNECTOR.definition.endpoints) {
      if (ep.method === 'GET') continue;
      expect(ep.writeRiskTier, `endpoint ${ep.endpointId}`).toBeDefined();
    }
  });

  it('every body param carries a schema, so the promoted tool teaches its shape', () => {
    for (const ep of ETORO_TRADING_CONNECTOR.definition.endpoints) {
      for (const param of ep.params ?? []) {
        if (param.location !== 'body') continue;
        expect(param.schema, `endpoint ${ep.endpointId}`).toBeDefined();
      }
    }
  });

  it('ships the lookup routes an order actually needs to be resolved', () => {
    // A 200 on an order route means submitted, not filled — without these the
    // connector could place orders it could never report the outcome of.
    const ids = ETORO_TRADING_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(ids).toContain('lookupOrder');
    expect(ids).toContain('getCloseOrder');
  });
});
