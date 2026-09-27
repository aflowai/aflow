import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { POLYGON_CONNECTOR } from './polygon.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Polygon connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(POLYGON_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(POLYGON_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(POLYGON_CONNECTOR.definition.baseUrl).toBe('https://api.polygon.io');
    expect(POLYGON_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(POLYGON_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('sends the key as the apiKey query parameter', () => {
    expect(POLYGON_CONNECTOR.authKind).toBe('api_key');
    expect(POLYGON_CONNECTOR.apiKeyQueryParamName).toBe('apiKey');
    expect(POLYGON_CONNECTOR.apiKeyHeaderName).toBeUndefined();
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of POLYGON_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(POLYGON_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('polygon')).toEqual(POLYGON_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('polygon');
  });

  it('declares the market-data endpoints', () => {
    const endpointIds = POLYGON_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'getAggregates',
      'getDailyOpenClose',
      'getPreviousClose',
      'getTickerDetails',
      'listTickerNews',
      'getMarketStatus',
      'getTickerSnapshot',
    ]);
  });
});
