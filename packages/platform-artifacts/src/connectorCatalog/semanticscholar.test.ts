import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { SEMANTIC_SCHOLAR_CONNECTOR } from './semanticscholar.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Semantic Scholar connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(SEMANTIC_SCHOLAR_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(SEMANTIC_SCHOLAR_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(SEMANTIC_SCHOLAR_CONNECTOR.definition.baseUrl).toBe('https://api.semanticscholar.org');
    expect(SEMANTIC_SCHOLAR_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(SEMANTIC_SCHOLAR_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('is keyed: authKind api_key with the x-api-key header and a credential prompt', () => {
    expect(SEMANTIC_SCHOLAR_CONNECTOR.authKind).toBe('api_key');
    expect(SEMANTIC_SCHOLAR_CONNECTOR.apiKeyHeaderName).toBe('x-api-key');
    expect(SEMANTIC_SCHOLAR_CONNECTOR.credentialPrompts).toEqual([
      {
        authField: 'credentialKey',
        label: 'Semantic Scholar API key',
        setupNote: 'Free from semanticscholar.org/product/api. Sent as the x-api-key header.',
      },
    ]);
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of SEMANTIC_SCHOLAR_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(SEMANTIC_SCHOLAR_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual([
      'GET',
    ]);
  });

  it('describes the fields param that controls returned fields', () => {
    const searchPapers = SEMANTIC_SCHOLAR_CONNECTOR.definition.endpoints.find(
      (e) => e.endpointId === 'searchPapers',
    );
    const fields = searchPapers?.params.find((p) => p.name === 'fields');
    expect(fields).toBeDefined();
    expect(fields?.description).toMatch(/fields/i);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('semantic-scholar')).toEqual(SEMANTIC_SCHOLAR_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('semantic-scholar');
  });

  it('declares the Graph API endpoints', () => {
    const endpointIds = SEMANTIC_SCHOLAR_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['searchPapers', 'getPaper', 'getPaperCitations', 'searchAuthors']);
  });
});
