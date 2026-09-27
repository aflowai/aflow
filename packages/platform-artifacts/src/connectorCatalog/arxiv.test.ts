import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { ARXIV_CONNECTOR } from './arxiv.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('arXiv connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(ARXIV_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(ARXIV_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(ARXIV_CONNECTOR.definition.baseUrl).toBe('https://export.arxiv.org');
    expect(ARXIV_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(ARXIV_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('is keyless: authKind none with no credential prompts', () => {
    expect(ARXIV_CONNECTOR.authKind).toBe('none');
    expect(ARXIV_CONNECTOR.credentialPrompts).toBeUndefined();
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of ARXIV_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(ARXIV_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('normalizes Atom XML at the connector boundary — the agent sees typed JSON records', () => {
    const searchPapers = ARXIV_CONNECTOR.definition.endpoints.find(
      (e) => e.endpointId === 'searchPapers',
    );
    expect(searchPapers).toBeDefined();
    expect(searchPapers?.responseTransformPresetId).toBe('arxiv_atom_papers');
    // The contract describes the normalized record shape, never "parse the XML".
    expect(searchPapers?.description).toContain('papers');
    expect(searchPapers?.description).toContain('arxivId');
    expect(searchPapers?.description).not.toMatch(/parse[sd]? the XML/i);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('arxiv')).toEqual(ARXIV_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('arxiv');
  });

  it('declares the searchPapers endpoint', () => {
    const endpointIds = ARXIV_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['searchPapers']);
  });
});
