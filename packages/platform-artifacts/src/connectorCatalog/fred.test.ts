import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { FRED_CONNECTOR } from './fred.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('FRED connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(FRED_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(FRED_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(FRED_CONNECTOR.definition.baseUrl).toBe('https://api.stlouisfed.org');
    expect(FRED_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(FRED_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('sends the key as the api_key query parameter', () => {
    expect(FRED_CONNECTOR.authKind).toBe('api_key');
    expect(FRED_CONNECTOR.apiKeyQueryParamName).toBe('api_key');
    expect(FRED_CONNECTOR.apiKeyHeaderName).toBeUndefined();
  });

  it('pins file_type=json on every endpoint (the API defaults to XML)', () => {
    for (const ep of FRED_CONNECTOR.definition.endpoints) {
      const fileType = ep.params.find((p) => p.name === 'file_type');
      expect(fileType, `endpoint ${ep.endpointId} file_type param`).toBeDefined();
      expect(fileType?.required, `endpoint ${ep.endpointId} file_type required`).toBe(true);
      expect((fileType?.schema as { enum?: string[] } | undefined)?.enum).toEqual(['json']);
    }
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of FRED_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(FRED_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('fred')).toEqual(FRED_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('fred');
  });

  it('declares the economic-data endpoints', () => {
    const endpointIds = FRED_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'getSeriesObservations',
      'getSeries',
      'searchSeries',
      'listReleases',
      'getCategory',
    ]);
  });
});
