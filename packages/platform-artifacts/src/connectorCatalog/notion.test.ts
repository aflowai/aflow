import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { NOTION_CONNECTOR } from './notion.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Notion connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(NOTION_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(NOTION_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(NOTION_CONNECTOR.definition.baseUrl).toBe('https://api.notion.com');
    expect(NOTION_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(NOTION_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('pins the Notion-Version header in defaultHeaders', () => {
    expect(NOTION_CONNECTOR.definition.defaultHeaders?.['Notion-Version']).toBe('2022-06-28');
  });

  it('declares a body schema for every body-bearing endpoint', () => {
    for (const ep of NOTION_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        }
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('notion')).toEqual(NOTION_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('notion');
  });

  it('declares the discover-read-write endpoints', () => {
    const endpointIds = NOTION_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toContain('search');
    expect(endpointIds).toContain('getDatabase');
    expect(endpointIds).toContain('queryDatabase');
    expect(endpointIds).toContain('createPage');
    expect(endpointIds).toContain('appendBlockChildren');
    expect(endpointIds).toContain('getBlockChildren');
  });
});
