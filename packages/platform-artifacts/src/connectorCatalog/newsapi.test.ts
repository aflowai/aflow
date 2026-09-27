import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { NEWSAPI_CONNECTOR } from './newsapi.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('NewsAPI connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(NEWSAPI_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(NEWSAPI_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(NEWSAPI_CONNECTOR.definition.baseUrl).toBe('https://newsapi.org');
    expect(NEWSAPI_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(NEWSAPI_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of NEWSAPI_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(NEWSAPI_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('newsapi')).toEqual(NEWSAPI_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('newsapi');
  });

  it('declares the search, headlines, and sources endpoints', () => {
    const endpointIds = NEWSAPI_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['searchEverything', 'getTopHeadlines', 'listSources']);
  });
});
