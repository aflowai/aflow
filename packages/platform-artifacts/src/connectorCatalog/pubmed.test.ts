import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { PUBMED_CONNECTOR } from './pubmed.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('PubMed connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(PUBMED_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(PUBMED_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(PUBMED_CONNECTOR.definition.baseUrl).toBe('https://eutils.ncbi.nlm.nih.gov');
    expect(PUBMED_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(PUBMED_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('is keyless: authKind none with no credential prompts', () => {
    expect(PUBMED_CONNECTOR.authKind).toBe('none');
    expect(PUBMED_CONNECTOR.credentialPrompts).toBeUndefined();
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of PUBMED_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(PUBMED_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('pins retmode json for esearch/esummary and xml for efetch', () => {
    const byId = Object.fromEntries(
      PUBMED_CONNECTOR.definition.endpoints.map((e) => [e.endpointId, e]),
    );
    const retmodeEnum = (endpointId: string): unknown => {
      const retmode = byId[endpointId]?.params.find((p) => p.name === 'retmode');
      return (retmode?.schema as { enum?: unknown } | undefined)?.enum;
    };
    expect(retmodeEnum('esearch')).toEqual(['json']);
    expect(retmodeEnum('esummary')).toEqual(['json']);
    expect(retmodeEnum('efetch')).toEqual(['xml']);
    expect(byId['efetch']?.description).toMatch(/XML/);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('pubmed')).toEqual(PUBMED_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('pubmed');
  });

  it('declares the esearch, esummary, and efetch endpoints', () => {
    const endpointIds = PUBMED_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['esearch', 'esummary', 'efetch']);
  });
});
