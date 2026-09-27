import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { FIRECRAWL_CONNECTOR } from './firecrawl.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Firecrawl connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(FIRECRAWL_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(FIRECRAWL_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(FIRECRAWL_CONNECTOR.definition.baseUrl).toBe('https://api.firecrawl.dev');
    expect(FIRECRAWL_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(FIRECRAWL_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of FIRECRAWL_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          const schema = param.schema as { additionalProperties?: unknown } | undefined;
          expect(schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
          expect(
            schema?.additionalProperties,
            `endpoint ${ep.endpointId} additionalProperties`,
          ).toBe(false);
        }
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('firecrawl')).toEqual(FIRECRAWL_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('firecrawl');
  });

  it('declares the scrape/crawl/map/search endpoints', () => {
    const endpointIds = FIRECRAWL_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['scrape', 'crawl', 'getCrawlStatus', 'map', 'search']);
  });
});
