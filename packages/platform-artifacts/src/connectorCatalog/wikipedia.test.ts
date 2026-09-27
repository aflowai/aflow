import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { WIKIPEDIA_CONNECTOR } from './wikipedia.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Wikipedia connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(WIKIPEDIA_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(WIKIPEDIA_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(WIKIPEDIA_CONNECTOR.definition.baseUrl).toBe('https://en.wikipedia.org');
    expect(WIKIPEDIA_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(WIKIPEDIA_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('is keyless: authKind none with no credential prompts', () => {
    expect(WIKIPEDIA_CONNECTOR.authKind).toBe('none');
    expect(WIKIPEDIA_CONNECTOR.credentialPrompts).toBeUndefined();
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of WIKIPEDIA_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(WIKIPEDIA_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('wikipedia')).toEqual(WIKIPEDIA_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('wikipedia');
  });

  it('declares the search and read endpoints', () => {
    const endpointIds = WIKIPEDIA_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['search', 'getPageSummary', 'getPageExtract', 'getPageLinks']);
  });
});
