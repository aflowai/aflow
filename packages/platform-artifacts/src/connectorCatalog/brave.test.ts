import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { BRAVE_CONNECTOR } from './brave.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Brave Search connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(BRAVE_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(BRAVE_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(BRAVE_CONNECTOR.definition.baseUrl).toBe('https://api.search.brave.com');
    expect(BRAVE_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(BRAVE_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('pins the subscription-token header via apiKeyHeaderName', () => {
    expect(BRAVE_CONNECTOR.authKind).toBe('api_key');
    expect(BRAVE_CONNECTOR.apiKeyHeaderName).toBe('X-Subscription-Token');
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of BRAVE_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(BRAVE_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('brave-search')).toEqual(BRAVE_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('brave-search');
  });

  it('declares the search endpoints', () => {
    const endpointIds = BRAVE_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['webSearch', 'newsSearch', 'imageSearch', 'videoSearch']);
  });
});
